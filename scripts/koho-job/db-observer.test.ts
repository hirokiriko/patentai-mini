import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createObserverClient,
  DB_OBSERVER_EXIT_CODES,
  fingerprintDatabaseSchema,
  loadExpectedMigrations,
  loadExpectedSchemaFingerprint,
  readDatabaseSchemaFingerprint,
  readObserverConfig,
  runDatabaseObserver,
} from "./db-observer.mjs";

const DATABASE_SECRET = "FICTIONAL-OBSERVER-DB-SECRET-DO-NOT-LOG";
const RAW_ERROR_SECRET = "FICTIONAL-RAW-ERROR-DO-NOT-LOG";
const SCHEMA_FINGERPRINT = "d".repeat(64);
const DATABASE_URL =
  `postgres://observer:${DATABASE_SECRET}` +
  "@fictional.postgres.database.azure.com:5432/issue75_staging?sslmode=require";

const EXPECTED_TABLE_ROWS = [
  ["public", "case_watch_findings"],
  ["public", "case_watch_runs"],
  ["public", "case_watch_settings"],
  ["public", "cases"],
  ["public", "comparison_results"],
  ["public", "draft_patents"],
  ["public", "koho_import_documents"],
  ["public", "koho_import_runs"],
  ["public", "prior_art_documents"],
  ["public", "search_query_sets"],
].map(([schema_name, table_name]) => ({ schema_name, table_name }));

const EXPECTED_MIGRATIONS = [
  { id: 1, createdAt: "1779317966922", hash: "a".repeat(64) },
  { id: 2, createdAt: "1787810352336", hash: "b".repeat(64) },
  { id: 3, createdAt: "1788308618345", hash: "c".repeat(64) },
];

const EXPECTED_MIGRATION_ROWS = EXPECTED_MIGRATIONS.map((migration) => ({
  id: String(migration.id),
  hash: migration.hash,
  created_at: migration.createdAt,
}));

function environment(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    KOHO_JOB_DATABASE_SCOPE: "issue-75-dedicated-staging",
    KOHO_JOB_EXPECTED_DATABASE_HOST:
      "fictional.postgres.database.azure.com:5432",
    KOHO_JOB_EXPECTED_DATABASE_NAME: "issue75_staging",
    KOHO_JOB_PACKAGE_TYPE: "JPA",
    KOHO_JOB_EXPECTED_SOURCE_SHA256: "a".repeat(64),
    KOHO_JOB_EXPECTED_DOCUMENT_COUNT: "1",
    DATABASE_URL,
    ...overrides,
  };
}

type QueryResponse =
  | { rows: Array<Record<string, unknown>> }
  | Error
  | (() => Promise<{ rows: Array<Record<string, unknown>> }>);

function baseResponses(
  overrides: Record<string, QueryResponse> = {},
): Record<string, QueryResponse> {
  return {
    "issue75-observer-identity": {
      rows: [{ database_name: "issue75_staging" }],
    },
    "issue75-observer-application-tables": { rows: EXPECTED_TABLE_ROWS },
    "issue75-observer-migration-table": {
      rows: [{ journal_exists: true }],
    },
    "issue75-observer-migrations": { rows: EXPECTED_MIGRATION_ROWS },
    "issue75-observer-storage-metrics": {
      rows: [
        {
          database_bytes: "1000",
          user_table_bytes: "600",
          index_bytes: "200",
          koho_import_runs_table_bytes: "120",
          koho_import_runs_index_bytes: "40",
          koho_import_documents_table_bytes: "480",
          koho_import_documents_index_bytes: "160",
          wal_position_bytes: "5000",
          temp_bytes: "30",
        },
      ],
    },
    "issue75-observer-import-metrics": {
      rows: [
        {
          import_run_count: "2",
          import_document_count: "1628",
          reported_document_count: "1628",
          amendment_count: "4",
          nested_st26_count: "3",
        },
      ],
    },
    "issue75-observer-activity-metrics": {
      rows: [
        {
          other_session_count: "3",
          other_active_session_count: "1",
          other_waiting_session_count: "1",
          other_lock_count: "8",
          other_waiting_lock_count: "2",
        },
      ],
    },
    "issue75-observer-package-state": {
      rows: [
        {
          matching_run_count: "1",
          package_type: "JPA",
          package_status: "success",
          declared_document_count: "1",
          amendment_count: "0",
          nested_st26_count: "0",
          stored_document_count: "1",
        },
      ],
    },
    ...overrides,
  };
}

function fakeClient(responses = baseResponses()) {
  const client = {
    connect: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined),
    on: vi.fn(),
    removeListener: vi.fn(),
    query: vi.fn(
      async (query: {
        name: string;
        text: string;
        values: unknown[];
        query_timeout: number;
      }) => {
        const response = responses[query.name];
        if (response instanceof Error) throw response;
        if (typeof response === "function") return response();
        if (response === undefined) {
          throw new Error(`unexpected test query: ${query.name}`);
        }
        return response;
      },
    ),
  };
  return client;
}

function dependencies(client: ReturnType<typeof fakeClient>) {
  return {
    createClient: vi.fn(() => client),
    loadExpectedMigrations: vi.fn(async () => EXPECTED_MIGRATIONS),
    loadExpectedSchemaFingerprint: vi.fn(async () => SCHEMA_FINGERPRINT),
    readDatabaseSchemaFingerprint: vi.fn(async () => SCHEMA_FINGERPRINT),
    readDatabaseIdentity: vi.fn(
      (values: NodeJS.ProcessEnv) => values.DATABASE_URL!,
    ),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

async function observe(
  mode: string,
  responses = baseResponses(),
  overrides: Record<string, unknown> = {},
) {
  const client = fakeClient(responses);
  const observerDependencies = {
    ...dependencies(client),
    ...overrides,
  };
  const outcome = await runDatabaseObserver({
    mode,
    environment: environment(),
    dependencies: observerDependencies,
  });
  return { client, observerDependencies, outcome };
}

describe("database observer configuration", () => {
  it("supports explicit injection of the runner database identity validator", () => {
    const validator = vi.fn(() => DATABASE_URL);
    expect(readObserverConfig("preflight", environment(), validator)).toEqual({
      mode: "preflight",
      databaseUrl: DATABASE_URL,
      expectedDatabaseName: "issue75_staging",
    });
    expect(validator).toHaveBeenCalledOnce();
  });

  it("uses the exported fail-closed runner validator by default", () => {
    expect(readObserverConfig("preflight", environment())).toEqual({
      mode: "preflight",
      databaseUrl: DATABASE_URL,
      expectedDatabaseName: "issue75_staging",
    });
    expect(() =>
      readObserverConfig(
        "preflight",
        environment({
          KOHO_JOB_EXPECTED_DATABASE_NAME: "patentai",
          DATABASE_URL:
            "postgres://observer:fictional@fictional.postgres.database.azure.com:5432/patentai?sslmode=require",
        }),
      ),
    ).toThrow("invalid_config");
  });

  it.each(["", "unknown", "PREFLIGHT"])(
    "rejects unsupported mode %j without creating a client",
    async (mode) => {
      const createClient = vi.fn();
      const outcome = await runDatabaseObserver({
        mode,
        environment: environment(),
        dependencies: {
          createClient,
          readDatabaseIdentity: vi.fn(() => DATABASE_URL),
        },
      });

      expect(outcome).toEqual({
        exitCode: DB_OBSERVER_EXIT_CODES.config,
        log: {
          component: "koho_db_observer",
          schemaVersion: 1,
          mode: "unknown",
          status: "failed",
          result: "unknown",
          reason: "invalid_config",
        },
      });
      expect(createClient).not.toHaveBeenCalled();
    },
  );

  it("fails closed when the shared validator rejects configuration", async () => {
    const createClient = vi.fn();
    const outcome = await runDatabaseObserver({
      mode: "preflight",
      environment: environment(),
      dependencies: {
        createClient,
        readDatabaseIdentity: vi.fn(() => {
          throw new Error(`${RAW_ERROR_SECRET} ${DATABASE_URL}`);
        }),
      },
    });

    expect(outcome.exitCode).toBe(DB_OBSERVER_EXIT_CODES.config);
    expect(outcome.log.reason).toBe("invalid_config");
    expect(JSON.stringify(outcome)).not.toContain(RAW_ERROR_SECRET);
    expect(JSON.stringify(outcome)).not.toContain(DATABASE_SECRET);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("uses finite connection, statement, lock, and query timeouts", () => {
    let options: Record<string, unknown> | undefined;
    class CapturingClient {
      constructor(received: Record<string, unknown>) {
        options = received;
      }
    }

    createObserverClient(DATABASE_URL, CapturingClient as never);

    expect(options).toMatchObject({
      connectionString:
        "postgres://observer:FICTIONAL-OBSERVER-DB-SECRET-DO-NOT-LOG" +
        "@fictional.postgres.database.azure.com:5432/issue75_staging?sslmode=verify-full",
      application_name: "issue75_db_observer",
      connectionTimeoutMillis: 15_000,
      query_timeout: 30_000,
      statement_timeout: 30_000,
      lock_timeout: 30_000,
    });
  });
});

describe("database observer preflight", () => {
  it("accepts only a database with no application or journal table", async () => {
    const responses = baseResponses({
      "issue75-observer-application-tables": { rows: [] },
      "issue75-observer-migration-table": {
        rows: [{ journal_exists: false }],
      },
    });
    const { client, outcome } = await observe("preflight", responses);

    expect(outcome).toEqual({
      exitCode: DB_OBSERVER_EXIT_CODES.success,
      log: {
        component: "koho_db_observer",
        schemaVersion: 1,
        mode: "preflight",
        status: "succeeded",
        result: "confirmed",
        reason: null,
        applicationTableCount: 0,
        migrationCount: 0,
      },
    });
    expect(client.end).toHaveBeenCalledOnce();
    expect(client.query).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "issue75-observer-migrations" }),
    );
  });

  it("rejects even an empty migration journal table", async () => {
    const responses = baseResponses({
      "issue75-observer-application-tables": { rows: [] },
      "issue75-observer-migrations": { rows: [] },
    });
    const { outcome } = await observe("preflight", responses);

    expect(outcome.exitCode).toBe(DB_OBSERVER_EXIT_CODES.state);
    expect(outcome.log.reason).toBe("database_not_empty");
  });

  it("rejects any application table", async () => {
    const responses = baseResponses({
      "issue75-observer-application-tables": {
        rows: [{ schema_name: "public", table_name: "unexpected" }],
      },
      "issue75-observer-migration-table": {
        rows: [{ journal_exists: false }],
      },
    });
    const { outcome } = await observe("preflight", responses);

    expect(outcome.exitCode).toBe(DB_OBSERVER_EXIT_CODES.state);
    expect(outcome.log.reason).toBe("database_not_empty");
  });

  it("rejects any migration journal row", async () => {
    const responses = baseResponses({
      "issue75-observer-application-tables": { rows: [] },
      "issue75-observer-migrations": { rows: [EXPECTED_MIGRATION_ROWS[0]] },
    });
    const { outcome } = await observe("preflight", responses);

    expect(outcome.exitCode).toBe(DB_OBSERVER_EXIT_CODES.state);
    expect(outcome.log.reason).toBe("database_not_empty");
  });

  it.each(["another_database", "patentai"])(
    "rejects actual database identity %s",
    async (databaseName) => {
      const responses = baseResponses({
        "issue75-observer-identity": {
          rows: [{ database_name: databaseName }],
        },
      });
      const { client, outcome } = await observe("preflight", responses);

      expect(outcome.exitCode).toBe(DB_OBSERVER_EXIT_CODES.state);
      expect(outcome.log.reason).toBe("database_identity_mismatch");
      expect(client.end).toHaveBeenCalledOnce();
    },
  );
});

describe("database observer migrated state", () => {
  it("accepts exactly migrations 0000 through 0002 and expected tables", async () => {
    const { outcome } = await observe("migrated");

    expect(outcome).toEqual({
      exitCode: DB_OBSERVER_EXIT_CODES.success,
      log: {
        component: "koho_db_observer",
        schemaVersion: 1,
        mode: "migrated",
        status: "succeeded",
        result: "confirmed",
        reason: null,
        applicationTableCount: 10,
        migrationCount: 3,
      },
    });
  });

  it("rejects a missing migration", async () => {
    const responses = baseResponses({
      "issue75-observer-migrations": {
        rows: EXPECTED_MIGRATION_ROWS.slice(0, 2),
      },
    });
    const { outcome } = await observe("migrated", responses);
    expect(outcome.exitCode).toBe(DB_OBSERVER_EXIT_CODES.state);
    expect(outcome.log.reason).toBe("migration_state_mismatch");
  });

  it("rejects an additional migration", async () => {
    const responses = baseResponses({
      "issue75-observer-migrations": {
        rows: [
          ...EXPECTED_MIGRATION_ROWS,
          { id: "4", hash: "extra", created_at: "1788308618346" },
        ],
      },
    });
    const { outcome } = await observe("migrated", responses);
    expect(outcome.exitCode).toBe(DB_OBSERVER_EXIT_CODES.state);
    expect(outcome.log.reason).toBe("migration_state_mismatch");
  });

  it("rejects a changed migration hash", async () => {
    const rows = EXPECTED_MIGRATION_ROWS.map((row) => ({ ...row }));
    rows[1].hash = "changed";
    const responses = baseResponses({
      "issue75-observer-migrations": { rows },
    });
    const { outcome } = await observe("migrated", responses);
    expect(outcome.exitCode).toBe(DB_OBSERVER_EXIT_CODES.state);
    expect(outcome.log.reason).toBe("migration_state_mismatch");
  });

  it("rejects reordered migrations", async () => {
    const responses = baseResponses({
      "issue75-observer-migrations": {
        rows: [
          EXPECTED_MIGRATION_ROWS[1],
          EXPECTED_MIGRATION_ROWS[0],
          EXPECTED_MIGRATION_ROWS[2],
        ],
      },
    });
    const { outcome } = await observe("migrated", responses);
    expect(outcome.exitCode).toBe(DB_OBSERVER_EXIT_CODES.state);
    expect(outcome.log.reason).toBe("migration_state_mismatch");
  });

  it("rejects a missing or additional application table", async () => {
    const responses = baseResponses({
      "issue75-observer-application-tables": {
        rows: EXPECTED_TABLE_ROWS.slice(1),
      },
    });
    const { outcome } = await observe("migrated", responses);
    expect(outcome.exitCode).toBe(DB_OBSERVER_EXIT_CODES.state);
    expect(outcome.log.reason).toBe("migration_state_mismatch");
  });

  it("loads exact branch migration metadata and hashes", async () => {
    const migrations = await loadExpectedMigrations();
    expect(migrations).toHaveLength(3);
    expect(migrations.map(({ id, createdAt }) => ({ id, createdAt }))).toEqual(
      EXPECTED_MIGRATIONS.map(({ id, createdAt }) => ({ id, createdAt })),
    );
    for (const migration of migrations) {
      expect(migration.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("rejects a catalog fingerprint that differs from the exact snapshot", async () => {
    const { outcome } = await observe("migrated", baseResponses(), {
      readDatabaseSchemaFingerprint: vi.fn(async () => "e".repeat(64)),
    });

    expect(outcome.exitCode).toBe(DB_OBSERVER_EXIT_CODES.state);
    expect(outcome.log.reason).toBe("schema_state_mismatch");
  });
});

describe("database observer schema fingerprint", () => {
  const schemaRows = {
    columns: [
      {
        schema_name: "public",
        table_name: "cases",
        column_name: "case_id",
        ordinal_position: 1,
        data_type: "integer",
        not_null: true,
        primary_key: true,
        default_expression: "nextval('cases_case_id_seq'::regclass)",
        identity_kind: "",
        generated_kind: "",
      },
    ],
    indexes: [
      {
        schema_name: "public",
        table_name: "cases",
        index_name: "cases_title_idx",
        is_unique: false,
        method: "btree",
        key_columns: ["title"],
        has_expression: false,
        has_included_columns: false,
        index_options: "0",
        predicate: null,
        is_valid: true,
        is_ready: true,
        is_live: true,
        storage_options: null,
      },
    ],
    constraints: [
      {
        schema_name: "public",
        table_name: "cases",
        constraint_name: "cases_pkey",
        constraint_type: "p",
        constrained_columns: ["case_id"],
        referenced_schema: null,
        referenced_table: null,
        referenced_columns: [],
        update_action: " ",
        delete_action: " ",
        match_type: " ",
        is_deferrable: false,
        is_deferred: false,
        is_validated: true,
        is_no_inherit: true,
        check_expression: null,
      },
    ],
  };

  it("loads a canonical fingerprint from the exact branch snapshot", async () => {
    await expect(loadExpectedSchemaFingerprint()).resolves.toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it.each(["columns", "indexes", "constraints"] as const)(
    "changes when the %s expected set changes",
    (section) => {
      const baseline = fingerprintDatabaseSchema(schemaRows);
      const changed = {
        ...schemaRows,
        [section]: [
          ...schemaRows[section],
          structuredClone(schemaRows[section][0]),
        ],
      };
      expect(baseline).toMatch(/^[0-9a-f]{64}$/);
      expect(fingerprintDatabaseSchema(changed)).not.toBe(baseline);
    },
  );

  it("queries columns, indexes, and constraints with read-only finite statements", async () => {
    const client = fakeClient(
      baseResponses({
        "issue75-observer-schema-columns": { rows: schemaRows.columns },
        "issue75-observer-schema-indexes": { rows: schemaRows.indexes },
        "issue75-observer-schema-constraints": {
          rows: schemaRows.constraints,
        },
      }),
    );

    const fingerprint = await readDatabaseSchemaFingerprint(client);

    expect(fingerprint).toBe(fingerprintDatabaseSchema(schemaRows));
    const schemaQueries = client.query.mock.calls
      .map(([query]) => query)
      .filter((query) => query.name.includes("schema-"));
    expect(schemaQueries).toHaveLength(3);
    for (const query of schemaQueries) {
      expect(query.query_timeout).toBe(30_000);
      expect(query.text.trim()).toMatch(/^SELECT\b/i);
    }
  });
});

describe("database observer snapshot", () => {
  it("returns numeric aggregate-only metrics after migration verification", async () => {
    const { client, outcome } = await observe("snapshot");

    expect(outcome.exitCode).toBe(DB_OBSERVER_EXIT_CODES.success);
    expect(outcome.log).toMatchObject({
      status: "succeeded",
      result: "confirmed",
      applicationTableCount: 10,
      migrationCount: 3,
      databaseBytes: 1000,
      userTableBytes: 600,
      indexBytes: 200,
      kohoImportRunsTableBytes: 120,
      kohoImportRunsIndexBytes: 40,
      kohoImportDocumentsTableBytes: 480,
      kohoImportDocumentsIndexBytes: 160,
      walPositionBytes: 5000,
      tempBytes: 30,
      importRunCount: 2,
      importDocumentCount: 1628,
      reportedDocumentCount: 1628,
      amendmentCount: 4,
      nestedSt26Count: 3,
      otherSessionCount: 3,
      otherActiveSessionCount: 1,
      otherWaitingSessionCount: 1,
      otherLockCount: 8,
      otherWaitingLockCount: 2,
    });
    for (const [key, value] of Object.entries(outcome.log)) {
      if (key.endsWith("Count") || key.endsWith("Bytes")) {
        expect(typeof value).toBe("number");
      }
    }

    const queryNames = client.query.mock.calls.map(([query]) => query.name);
    expect(queryNames.indexOf("issue75-observer-migrations")).toBeLessThan(
      queryNames.indexOf("issue75-observer-storage-metrics"),
    );
  });

  it("fails closed on malformed or unsafe numeric metrics", async () => {
    const responses = baseResponses({
      "issue75-observer-storage-metrics": {
        rows: [
          {
            database_bytes: "1000",
            user_table_bytes: "not-a-number",
            index_bytes: "200",
            wal_position_bytes: "5000",
            temp_bytes: "30",
          },
        ],
      },
    });
    const { client, outcome } = await observe("snapshot", responses);
    expect(outcome.exitCode).toBe(DB_OBSERVER_EXIT_CODES.state);
    expect(outcome.log.reason).toBe("invalid_metric_state");
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("uses only bounded read-only queries", async () => {
    const { client } = await observe("snapshot");
    expect(client.query).toHaveBeenCalled();
    for (const [query] of client.query.mock.calls) {
      expect(query.query_timeout).toBe(30_000);
      expect(query.text.trim()).toMatch(/^(SELECT|WITH)\b/i);
      expect(query.text).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\b/i,
      );
    }
  });
});

describe("database observer package state", () => {
  it("binds the source digest and verifies exactly one aggregate package", async () => {
    const { client, outcome } = await observe("package");

    expect(outcome).toEqual({
      exitCode: DB_OBSERVER_EXIT_CODES.success,
      log: {
        component: "koho_db_observer",
        schemaVersion: 1,
        mode: "package",
        status: "succeeded",
        result: "confirmed",
        reason: null,
        applicationTableCount: 10,
        migrationCount: 3,
        matchingRunCount: 1,
        packageType: "JPA",
        packageStatus: "success",
        expectedDocumentCount: 1,
        declaredDocumentCount: 1,
        storedDocumentCount: 1,
        amendmentCount: 0,
        nestedSt26Count: 0,
      },
    });
    const packageQuery = client.query.mock.calls
      .map(([query]) => query)
      .find((query) => query.name === "issue75-observer-package-state");
    expect(packageQuery?.values).toEqual(["a".repeat(64)]);
    expect(JSON.stringify(outcome)).not.toContain("a".repeat(64));
  });

  it("verifies a JPB review-required package by its independent source digest", async () => {
    const sourceSha256 = "b".repeat(64);
    const client = fakeClient(
      baseResponses({
        "issue75-observer-package-state": {
          rows: [
            {
              matching_run_count: "1",
              package_type: "JPB",
              package_status: "review_required",
              declared_document_count: "2",
              amendment_count: "1",
              nested_st26_count: "1",
              stored_document_count: "2",
            },
          ],
        },
      }),
    );

    const outcome = await runDatabaseObserver({
      mode: "package",
      environment: environment({
        KOHO_JOB_PACKAGE_TYPE: "JPB",
        KOHO_JOB_EXPECTED_SOURCE_SHA256: sourceSha256,
        KOHO_JOB_EXPECTED_DOCUMENT_COUNT: "2",
      }),
      dependencies: dependencies(client),
    });

    expect(outcome.exitCode).toBe(DB_OBSERVER_EXIT_CODES.success);
    expect(outcome.log).toMatchObject({
      packageType: "JPB",
      packageStatus: "review_required",
      expectedDocumentCount: 2,
      declaredDocumentCount: 2,
      storedDocumentCount: 2,
    });
    const packageQuery = client.query.mock.calls
      .map(([query]) => query)
      .find((query) => query.name === "issue75-observer-package-state");
    expect(packageQuery?.values).toEqual([sourceSha256]);
    expect(JSON.stringify(outcome)).not.toContain(sourceSha256);
  });

  it.each([
    { matching_run_count: "0" },
    { matching_run_count: "2" },
    { package_type: "JPB" },
    { package_status: "failed" },
    { declared_document_count: "2" },
    { stored_document_count: "2" },
  ])("rejects package state mismatch %#", async (override) => {
    const row = {
      ...(baseResponses()["issue75-observer-package-state"] as {
        rows: Array<Record<string, unknown>>;
      }).rows[0],
      ...override,
    };
    const { outcome } = await observe(
      "package",
      baseResponses({
        "issue75-observer-package-state": { rows: [row] },
      }),
    );

    expect(outcome.exitCode).toBe(DB_OBSERVER_EXIT_CODES.state);
    expect(outcome.log.reason).toBe("package_state_mismatch");
  });

  it.each([
    { KOHO_JOB_PACKAGE_TYPE: undefined },
    { KOHO_JOB_EXPECTED_SOURCE_SHA256: undefined },
    { KOHO_JOB_EXPECTED_SOURCE_SHA256: "A".repeat(64) },
    { KOHO_JOB_EXPECTED_DOCUMENT_COUNT: "0" },
  ])("rejects package verification config %#", async (override) => {
    const client = fakeClient();
    const outcome = await runDatabaseObserver({
      mode: "package",
      environment: environment(override),
      dependencies: dependencies(client),
    });

    expect(outcome.exitCode).toBe(DB_OBSERVER_EXIT_CODES.config);
    expect(outcome.log.reason).toBe("invalid_config");
    expect(client.connect).not.toHaveBeenCalled();
  });
});

describe("database observer failure and cleanup", () => {
  it("always ends a client after a connection failure", async () => {
    const client = fakeClient();
    client.connect.mockRejectedValueOnce(new Error(RAW_ERROR_SECRET));
    const outcome = await runDatabaseObserver({
      mode: "preflight",
      environment: environment(),
      dependencies: dependencies(client),
    });

    expect(outcome.exitCode).toBe(DB_OBSERVER_EXIT_CODES.connect);
    expect(outcome.log.reason).toBe("connect_failed");
    expect(client.end).toHaveBeenCalledOnce();
    expect(JSON.stringify(outcome)).not.toContain(RAW_ERROR_SECRET);
  });

  it("maps a pending connection to the stable finite timeout result", async () => {
    vi.useFakeTimers();
    const client = fakeClient();
    client.connect.mockImplementationOnce(() => new Promise(() => undefined));
    const observing = runDatabaseObserver({
      mode: "preflight",
      environment: environment(),
      dependencies: dependencies(client),
    });

    await vi.advanceTimersByTimeAsync(15_000);
    const outcome = await observing;

    expect(outcome.exitCode).toBe(DB_OBSERVER_EXIT_CODES.connect);
    expect(outcome.log.reason).toBe("connect_timed_out");
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("maps query failures to a stable safe result and ends the client", async () => {
    const responses = baseResponses({
      "issue75-observer-identity": new Error(
        `${RAW_ERROR_SECRET} ${DATABASE_URL}`,
      ),
    });
    const { client, outcome } = await observe("preflight", responses);

    expect(outcome.exitCode).toBe(DB_OBSERVER_EXIT_CODES.query);
    expect(outcome.log.reason).toBe("query_failed");
    expect(client.end).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(RAW_ERROR_SECRET);
    expect(serialized).not.toContain(DATABASE_SECRET);
    expect(serialized).not.toContain("fictional.postgres.database.azure.com");
  });

  it("maps a pending query to the stable finite timeout result", async () => {
    vi.useFakeTimers();
    const client = fakeClient(
      baseResponses({
        "issue75-observer-identity": () => new Promise(() => undefined),
      }),
    );
    const observing = runDatabaseObserver({
      mode: "preflight",
      environment: environment(),
      dependencies: dependencies(client),
    });
    for (let index = 0; index < 10 && client.query.mock.calls.length === 0; index += 1) {
      await Promise.resolve();
    }
    expect(client.query).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(30_000);
    const outcome = await observing;

    expect(outcome.exitCode).toBe(DB_OBSERVER_EXIT_CODES.query);
    expect(outcome.log.reason).toBe("query_timed_out");
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("cannot report success after an idle client error", async () => {
    const client = fakeClient(
      baseResponses({
        "issue75-observer-application-tables": { rows: [] },
        "issue75-observer-migration-table": {
          rows: [{ journal_exists: false }],
        },
      }),
    );
    let idleErrorListener: (() => void) | undefined;
    client.on.mockImplementation((event: string, listener: () => void) => {
      if (event === "error") idleErrorListener = listener;
      return client;
    });
    client.query.mockImplementation(async (query) => {
      const response = baseResponses({
        "issue75-observer-application-tables": { rows: [] },
        "issue75-observer-migration-table": {
          rows: [{ journal_exists: false }],
        },
      })[query.name];
      if (response instanceof Error || typeof response === "function") {
        throw new Error("unexpected fixture");
      }
      if (query.name === "issue75-observer-migration-table") {
        idleErrorListener?.();
      }
      return response!;
    });

    const outcome = await runDatabaseObserver({
      mode: "preflight",
      environment: environment(),
      dependencies: dependencies(client),
    });

    expect(outcome.exitCode).toBe(DB_OBSERVER_EXIT_CODES.query);
    expect(outcome.log).toMatchObject({
      status: "failed",
      result: "unknown",
      reason: "idle_client_error",
    });
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("fails closed when local migration metadata cannot be read", async () => {
    const { client, outcome } = await observe("migrated", baseResponses(), {
      loadExpectedMigrations: vi.fn(async () => {
        throw new Error(`${RAW_ERROR_SECRET} C:\\private\\migration.sql`);
      }),
    });

    expect(outcome.exitCode).toBe(DB_OBSERVER_EXIT_CODES.state);
    expect(outcome.log.reason).toBe("migration_manifest_unavailable");
    expect(client.end).toHaveBeenCalledOnce();
    expect(JSON.stringify(outcome)).not.toContain(RAW_ERROR_SECRET);
    expect(JSON.stringify(outcome)).not.toContain("migration.sql");
  });

  it("uses cleanup failure precedence and a stable exit code", async () => {
    const client = fakeClient(
      baseResponses({
        "issue75-observer-application-tables": { rows: [] },
        "issue75-observer-migration-table": {
          rows: [{ journal_exists: false }],
        },
      }),
    );
    client.end.mockRejectedValueOnce(new Error(RAW_ERROR_SECRET));
    const outcome = await runDatabaseObserver({
      mode: "preflight",
      environment: environment(),
      dependencies: dependencies(client),
    });

    expect(outcome.exitCode).toBe(DB_OBSERVER_EXIT_CODES.cleanup);
    expect(outcome.log.reason).toBe("cleanup_failed");
    expect(JSON.stringify(outcome)).not.toContain(RAW_ERROR_SECRET);
    expect(client.removeListener).not.toHaveBeenCalled();
  });

  it("preserves the cleanup timeout reason", async () => {
    vi.useFakeTimers();
    const client = fakeClient(
      baseResponses({
        "issue75-observer-application-tables": { rows: [] },
        "issue75-observer-migration-table": {
          rows: [{ journal_exists: false }],
        },
      }),
    );
    client.end.mockImplementationOnce(() => new Promise(() => undefined));
    const observing = runDatabaseObserver({
      mode: "preflight",
      environment: environment(),
      dependencies: dependencies(client),
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const outcome = await observing;

    expect(outcome.exitCode).toBe(DB_OBSERVER_EXIT_CODES.cleanup);
    expect(outcome.log.reason).toBe("cleanup_timed_out");
    expect(client.removeListener).not.toHaveBeenCalled();
  });

  it("entrypoint emits exactly one safe JSON line to stdout", () => {
    const entrypoint = fileURLToPath(new URL("./db-observer.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [entrypoint, "invalid-mode"], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      encoding: "utf8",
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "" },
      timeout: 10_000,
    });

    expect(result.status).toBe(DB_OBSERVER_EXIT_CODES.config);
    expect(result.stderr).toBe("");
    expect(result.stdout.split(/\r?\n/)).toHaveLength(2);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      component: "koho_db_observer",
      schemaVersion: 1,
      mode: "unknown",
      status: "failed",
      result: "unknown",
      reason: "invalid_config",
    });
  });
});
