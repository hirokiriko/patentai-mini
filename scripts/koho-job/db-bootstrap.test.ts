import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  createApplicationClient,
  createBootstrapClient,
  createScramVerifier,
  createSchemaAdminClient,
  DB_BOOTSTRAP_EXIT_CODES,
  readBootstrapConfig,
  runDatabaseBootstrap,
} from "./db-bootstrap.mjs";

const ADMIN_SECRET = "Fictional-Admin-Secret-Do-Not-Log-8!";
const TARGET_SECRET = "Fictional-Target-Secret-Do-Not-Log-9!";
const RAW_ERROR_SECRET = "FICTIONAL-RAW-ERROR-DO-NOT-LOG";
const EXPECTED_HOST =
  "issue75-fictional.postgres.database.azure.com:5432";
const ADMIN_URL =
  `postgres://issue75admin:${ADMIN_SECRET}` +
  `@${EXPECTED_HOST}/postgres?sslmode=verify-full`;
const TARGET_DATABASE = "issue75_staging";
const TARGET_USER = "issue75_app";
const RUN_POSTGRES_INTEGRATION =
  process.env.KOHO_BOOTSTRAP_RUN_POSTGRES_INTEGRATION === "1";

function environment(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    KOHO_BOOTSTRAP_DATABASE_SCOPE: "issue-75-dedicated-staging",
    KOHO_BOOTSTRAP_EXPECTED_DATABASE_HOST: EXPECTED_HOST,
    KOHO_BOOTSTRAP_ADMIN_DATABASE_URL: ADMIN_URL,
    KOHO_BOOTSTRAP_TARGET_DATABASE_NAME: TARGET_DATABASE,
    KOHO_BOOTSTRAP_TARGET_DATABASE_USER: TARGET_USER,
    KOHO_BOOTSTRAP_TARGET_DATABASE_PASSWORD: TARGET_SECRET,
    ...overrides,
  };
}

function emptyTargetState(
  postgresMajor: 15 | 16 = 16,
): Record<string, unknown> {
  return {
    server_version_num: postgresMajor * 10_000,
    createrole_self_grant: postgresMajor >= 16 ? "" : null,
    target_database_count: "0",
    target_database_owner: null,
    target_database_encoding: null,
    target_database_allows_connections: null,
    target_database_connection_limit: null,
    target_database_public_privileges_revoked: null,
    target_database_target_privilege_count: null,
    target_database_target_has_no_grant_option: null,
    target_database_target_has_connect: null,
    target_database_target_has_create: null,
    target_database_target_has_temporary: null,
    target_database_unexpected_grantee_count: null,
    target_role_count: "0",
    target_role_can_login: null,
    target_role_is_superuser: null,
    target_role_can_create_database: null,
    target_role_can_create_role: null,
    target_role_inherits: null,
    target_role_can_replicate: null,
    target_role_can_bypass_rls: null,
    target_role_connection_limit: null,
    target_role_has_no_valid_until: null,
    target_role_parent_membership_count: null,
    target_role_creator_membership_count: null,
    target_role_creator_admin_option: null,
    target_role_creator_inherit_option: null,
    target_role_creator_set_option: null,
    target_role_other_member_count: null,
  };
}

function exactRoleState(
  postgresMajor: 15 | 16 = 16,
): Record<string, unknown> {
  const hasCreatorEdge = postgresMajor >= 16;
  return {
    ...emptyTargetState(postgresMajor),
    target_role_count: "1",
    target_role_can_login: true,
    target_role_is_superuser: false,
    target_role_can_create_database: false,
    target_role_can_create_role: false,
    target_role_inherits: false,
    target_role_can_replicate: false,
    target_role_can_bypass_rls: false,
    target_role_connection_limit: 4,
    target_role_has_no_valid_until: true,
    target_role_parent_membership_count: "0",
    target_role_creator_membership_count: hasCreatorEdge ? "1" : "0",
    target_role_creator_admin_option: hasCreatorEdge ? true : null,
    target_role_creator_inherit_option: hasCreatorEdge ? false : null,
    target_role_creator_set_option: hasCreatorEdge ? false : null,
    target_role_other_member_count: "0",
  };
}

function exactDatabaseState(
  publicPrivilegesRevoked: boolean,
  postgresMajor: 15 | 16 = 16,
): Record<string, unknown> {
  return {
    ...exactRoleState(postgresMajor),
    target_database_count: "1",
    target_database_owner: "issue75admin",
    target_database_encoding: "UTF8",
    target_database_allows_connections: true,
    target_database_connection_limit: 4,
    target_database_public_privileges_revoked: publicPrivilegesRevoked,
    target_database_target_privilege_count: publicPrivilegesRevoked ? "2" : "0",
    target_database_target_has_no_grant_option: true,
    target_database_target_has_connect: true,
    target_database_target_has_create: publicPrivilegesRevoked,
    target_database_target_has_temporary: !publicPrivilegesRevoked,
    target_database_unexpected_grantee_count: "0",
  };
}

function exactSchemaState(): Array<Record<string, unknown>> {
  return [
    {
      schema_name: "public",
      schema_owner: "azure_pg_admin",
      public_privileges_revoked: true,
      target_privilege_count: "2",
      target_has_no_grant_option: true,
      unexpected_grantee_count: "0",
      target_has_usage: true,
      target_has_create: true,
      unexpected_schema_count: "0",
    },
  ];
}

function preflightState(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    database_name: "postgres",
    user_name: "issue75admin",
    server_is_private: true,
    admin_can_login: true,
    admin_can_create_database: true,
    admin_can_create_role: true,
    admin_is_superuser: false,
    admin_can_replicate: false,
    admin_can_bypass_rls: false,
    password_encryption_is_scram_sha_256: true,
    parameter_logging_is_disabled: true,
    error_parameter_logging_is_disabled: true,
    statement_logging_is_disabled: true,
    duration_statement_logging_is_disabled: true,
    sampled_statement_logging_is_disabled: true,
    transaction_statement_sampling_is_disabled: true,
    debug_query_logging_is_disabled: true,
    server_version_is_supported: true,
    scram_iterations_are_supported: true,
    createrole_self_grant_is_safe: true,
    error_log_verbosity_is_safe: true,
    error_statement_logging_is_disabled: true,
    pgaudit_logging_is_disabled: true,
    nested_statement_tracking_is_disabled: true,
    auto_explain_logging_is_disabled: true,
    query_store_capture_is_disabled: true,
    wait_sampling_capture_is_disabled: true,
    admin_is_azure_pg_admin: true,
    unexpected_database_count: "0",
    unexpected_login_role_count: "0",
    ...emptyTargetState(),
    ...overrides,
  };
}

function schemaResponses(
  overrides: Record<string, QueryResponse> = {},
): Record<string, QueryResponse> {
  return {
    "issue75-bootstrap-schema-admin-identity": {
      rows: [
        {
          database_name: TARGET_DATABASE,
          user_name: "issue75admin",
          server_is_private: true,
          admin_is_azure_pg_admin: true,
          drizzle_schema_count: "0",
          unexpected_schema_count: "0",
        },
      ],
    },
    "issue75-bootstrap-schema-begin": { rows: [] },
    "issue75-bootstrap-schema-revoke-public": { rows: [] },
    "issue75-bootstrap-schema-grant-public-target": { rows: [] },
    "issue75-bootstrap-schema-state": {
      rows: exactSchemaState(),
    },
    "issue75-bootstrap-schema-commit": { rows: [] },
    "issue75-bootstrap-schema-rollback": { rows: [] },
    "issue75-bootstrap-schema-reconcile": {
      rows: exactSchemaState(),
    },
    ...overrides,
  };
}

function applicationResponses(
  overrides: Record<string, QueryResponse> = {},
): Record<string, QueryResponse> {
  return {
    "issue75-bootstrap-application-identity": {
      rows: [
        {
          database_name: TARGET_DATABASE,
          user_name: TARGET_USER,
          server_is_private: true,
          can_login: true,
          is_superuser: false,
          can_create_database: false,
          can_create_role: false,
          inherits: false,
          can_replicate: false,
          can_bypass_rls: false,
          connection_limit: 4,
          parent_membership_count: "0",
          is_azure_pg_admin: false,
          is_database_owner: false,
          can_connect_to_database: true,
          can_create_in_database: true,
          can_create_temporary_objects: false,
          can_create_in_public_schema: true,
          can_use_public_schema: true,
        },
      ],
    },
    ...overrides,
  };
}

type QueryResult = { rows: Array<Record<string, unknown>> };
type QueryRequest = {
  name: string;
  text: string;
  values: unknown[];
  query_timeout: number;
};
type QueryResponse =
  | QueryResult
  | Error
  | ((request: QueryRequest) => QueryResult | Promise<QueryResult>);

function postgresError(code: string): Error {
  return Object.assign(new Error(RAW_ERROR_SECRET), { code });
}

function neverResolves<T>(): Promise<T> {
  return new Promise(() => undefined);
}

function baseResponses(
  overrides: Record<string, QueryResponse> = {},
): Record<string, QueryResponse> {
  return {
    "issue75-bootstrap-advisory-lock": {
      rows: [{ lock_acquired: true }],
    },
    "issue75-bootstrap-preflight": { rows: [preflightState()] },
    "issue75-bootstrap-role-begin": { rows: [] },
    "issue75-bootstrap-role-verifier": {
      rows: [
        {
          target_user_configured: true,
          target_verifier_configured: true,
        },
      ],
    },
    "issue75-bootstrap-role-create": { rows: [] },
    "issue75-bootstrap-role-state": { rows: [exactRoleState()] },
    "issue75-bootstrap-role-commit": { rows: [] },
    "issue75-bootstrap-role-rollback": { rows: [] },
    "issue75-bootstrap-role-rollback-state": {
      rows: [emptyTargetState()],
    },
    "issue75-bootstrap-database-create": { rows: [] },
    "issue75-bootstrap-database-reconcile": {
      rows: [exactDatabaseState(false)],
    },
    "issue75-bootstrap-database-state": {
      rows: [exactDatabaseState(false)],
    },
    "issue75-bootstrap-database-revoke-public": { rows: [] },
    "issue75-bootstrap-database-grant-target": { rows: [] },
    "issue75-bootstrap-database-privilege-reconcile": {
      rows: [exactDatabaseState(true)],
    },
    "issue75-bootstrap-final-state": {
      rows: [exactDatabaseState(true)],
    },
    "issue75-bootstrap-cleanup-role": { rows: [] },
    "issue75-bootstrap-cleanup-state": { rows: [emptyTargetState()] },
    ...overrides,
  };
}

function fakeClient(responses = baseResponses()) {
  const client = {
    connect: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined),
    on: vi.fn(),
    removeListener: vi.fn(),
    query: vi.fn(async (request: QueryRequest) => {
      const response = responses[request.name];
      if (response instanceof Error) throw response;
      if (typeof response === "function") return response(request);
      if (response === undefined) {
        throw new Error(`unexpected test query: ${request.name}`);
      }
      return response;
    }),
  };
  return client;
}

function docker(args: string[], tolerateFailure = false): string {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (!tolerateFailure && result.status !== 0) {
    throw new Error("fictional PostgreSQL Docker probe failed");
  }
  return result.stdout.trim();
}

async function waitForPostgres(containerName: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = spawnSync(
      "docker",
      ["exec", containerName, "pg_isready", "-U", "postgres"],
      { encoding: "utf8", timeout: 5_000 },
    );
    if (result.status === 0) return;
    await delay(250);
  }
  throw new Error("fictional PostgreSQL Docker probe did not become ready");
}

async function bootstrap(
  responses = baseResponses(),
  overrides: Record<string, unknown> = {},
) {
  const client = fakeClient(responses);
  const schemaClient = fakeClient(schemaResponses());
  const applicationClient = fakeClient(applicationResponses());
  const createAdminClient = vi.fn((databaseUrl: string) => {
    void databaseUrl;
    return client;
  });
  const createSchemaClient = vi.fn((databaseUrl: string) => {
    void databaseUrl;
    return schemaClient;
  });
  const createTargetClient = vi.fn((databaseUrl: string) => {
    void databaseUrl;
    return applicationClient;
  });
  const outcome = await runDatabaseBootstrap({
    environment: environment(),
    dependencies: {
      createAdminClient,
      createSchemaAdminClient: createSchemaClient,
      createApplicationClient: createTargetClient,
      ...overrides,
    },
  });
  return {
    client,
    schemaClient,
    applicationClient,
    createAdminClient,
    createSchemaClient,
    createTargetClient,
    outcome,
  };
}

describe("database bootstrap configuration", () => {
  it("accepts only the dedicated Azure PostgreSQL identity contract", () => {
    expect(readBootstrapConfig(environment())).toEqual({
      adminDatabaseUrl: ADMIN_URL,
      adminUser: "issue75admin",
      expectedHost: EXPECTED_HOST,
      targetDatabaseName: TARGET_DATABASE,
      targetUser: TARGET_USER,
      targetPassword: TARGET_SECRET,
    });

    const hostWithoutPort =
      "issue75-fictional.postgres.database.azure.com";
    expect(
      readBootstrapConfig(
        environment({
          KOHO_BOOTSTRAP_EXPECTED_DATABASE_HOST: hostWithoutPort,
          KOHO_BOOTSTRAP_ADMIN_DATABASE_URL:
            `postgres://issue75admin:${ADMIN_SECRET}` +
            `@${hostWithoutPort}/postgres?sslmode=verify-full`,
        }),
      ).expectedHost,
    ).toBe(hostWithoutPort);
  });

  it.each([
    { KOHO_BOOTSTRAP_DATABASE_SCOPE: "issue-75" },
    { KOHO_BOOTSTRAP_EXPECTED_DATABASE_HOST: undefined },
    {
      KOHO_BOOTSTRAP_EXPECTED_DATABASE_HOST:
        "fictional.postgres.database.azure.com:5432",
      KOHO_BOOTSTRAP_ADMIN_DATABASE_URL:
        `postgres://issue75admin:${ADMIN_SECRET}` +
        "@fictional.postgres.database.azure.com:5432/postgres?sslmode=verify-full",
    },
    {
      KOHO_BOOTSTRAP_ADMIN_DATABASE_URL:
        `postgres://issue75admin:${ADMIN_SECRET}` +
        `@${EXPECTED_HOST}/postgres?sslmode=require`,
    },
    {
      KOHO_BOOTSTRAP_ADMIN_DATABASE_URL:
        `postgres://issue75admin:${ADMIN_SECRET}` +
        `@${EXPECTED_HOST}/issue75_staging?sslmode=verify-full`,
    },
    { KOHO_BOOTSTRAP_TARGET_DATABASE_NAME: "issue75_prod" },
    { KOHO_BOOTSTRAP_TARGET_DATABASE_NAME: "patentai" },
    { KOHO_BOOTSTRAP_TARGET_DATABASE_NAME: "issue75__staging" },
    { KOHO_BOOTSTRAP_TARGET_DATABASE_USER: "issue75_production_user" },
    { KOHO_BOOTSTRAP_TARGET_DATABASE_USER: "azure_issue75" },
    { KOHO_BOOTSTRAP_TARGET_DATABASE_PASSWORD: "too-short" },
    {
      KOHO_BOOTSTRAP_TARGET_DATABASE_PASSWORD:
        "Fictional-Target-Password-with-space 9!",
    },
    {
      KOHO_BOOTSTRAP_TARGET_DATABASE_PASSWORD:
        "Fictional-Target-Password-日本語-9!",
    },
  ])("rejects unsafe configuration %# before connecting", async (override) => {
    const createAdminClient = vi.fn();
    const outcome = await runDatabaseBootstrap({
      environment: environment(override),
      dependencies: { createAdminClient },
    });

    expect(outcome).toEqual({
      exitCode: DB_BOOTSTRAP_EXIT_CODES.config,
      log: {
        component: "koho_db_bootstrap",
        schemaVersion: 1,
        status: "failed",
        result: "not_started",
        reason: "invalid_config",
        databaseCreatedConfirmed: false,
        roleCreatedConfirmed: false,
        cleanupAttempted: false,
        cleanupConfirmed: false,
      },
    });
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it.each([
    {
      adminPassword: "Fictional-Shared-Secret-123!",
      targetPassword: "Fictional-Shared-Secret-123!",
    },
    {
      adminPassword: encodeURIComponent(
        "Fictional-Shared:Secret@123",
      ),
      targetPassword: "Fictional-Shared:Secret@123",
    },
  ])(
    "rejects the same decoded admin and target password %# without disclosure",
    async ({ adminPassword, targetPassword }) => {
      const createAdminClient = vi.fn();
      const outcome = await runDatabaseBootstrap({
        environment: environment({
          KOHO_BOOTSTRAP_ADMIN_DATABASE_URL:
            `postgres://issue75admin:${adminPassword}` +
            `@${EXPECTED_HOST}/postgres?sslmode=verify-full`,
          KOHO_BOOTSTRAP_TARGET_DATABASE_PASSWORD: targetPassword,
        }),
        dependencies: { createAdminClient },
      });

      expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.config);
      expect(outcome.log.reason).toBe("invalid_config");
      expect(createAdminClient).not.toHaveBeenCalled();
      expect(JSON.stringify(outcome)).not.toContain(adminPassword);
      expect(JSON.stringify(outcome)).not.toContain(targetPassword);
    },
  );

  it("uses strict TLS and finite client timeouts", () => {
    const receivedOptions: Array<Record<string, unknown>> = [];
    class CapturingClient {
      constructor(received: Record<string, unknown>) {
        receivedOptions.push(received);
      }
    }

    createBootstrapClient(
      ADMIN_URL.replace("verify-full", "require"),
      CapturingClient as never,
    );
    createSchemaAdminClient(
      ADMIN_URL.replace("verify-full", "require"),
      CapturingClient as never,
    );
    createApplicationClient(
      ADMIN_URL.replace("verify-full", "require"),
      CapturingClient as never,
    );

    expect(receivedOptions[0]).toMatchObject({
      connectionString: ADMIN_URL,
      application_name: "issue75_db_bootstrap",
      connectionTimeoutMillis: 15_000,
      query_timeout: 30_000,
      statement_timeout: 30_000,
      lock_timeout: 5_000,
      keepAlive: true,
    });
    expect(receivedOptions[1]).toMatchObject({
      connectionString: ADMIN_URL,
      application_name: "issue75_db_bootstrap_schema",
      connectionTimeoutMillis: 15_000,
      query_timeout: 30_000,
      statement_timeout: 30_000,
      lock_timeout: 5_000,
    });
    expect(receivedOptions[2]).toMatchObject({
      connectionString: ADMIN_URL,
      application_name: "issue75_db_bootstrap_verify",
      connectionTimeoutMillis: 15_000,
      query_timeout: 30_000,
      statement_timeout: 30_000,
      lock_timeout: 5_000,
    });
  });
});

describe("database bootstrap identity and existing-object gate", () => {
  it.each([
    { database_name: "patentai" },
    { user_name: "other_admin" },
    { server_is_private: false },
    { admin_can_create_database: false },
    { admin_can_create_role: false },
    { admin_is_superuser: true },
    { password_encryption_is_scram_sha_256: false },
    { parameter_logging_is_disabled: false },
    { error_parameter_logging_is_disabled: false },
    { statement_logging_is_disabled: false },
    { duration_statement_logging_is_disabled: false },
    { sampled_statement_logging_is_disabled: false },
    { transaction_statement_sampling_is_disabled: false },
    { debug_query_logging_is_disabled: false },
    { server_version_is_supported: false },
    { scram_iterations_are_supported: false },
    { createrole_self_grant_is_safe: false },
    { error_log_verbosity_is_safe: false },
    { error_statement_logging_is_disabled: false },
    { pgaudit_logging_is_disabled: false },
    { nested_statement_tracking_is_disabled: false },
    { auto_explain_logging_is_disabled: false },
    { query_store_capture_is_disabled: false },
    { wait_sampling_capture_is_disabled: false },
    { admin_is_azure_pg_admin: false },
    { unexpected_database_count: "1" },
    { unexpected_login_role_count: "1" },
  ])("rejects an identity mismatch %# before mutation", async (override) => {
    const { client, outcome } = await bootstrap(
      baseResponses({
        "issue75-bootstrap-preflight": {
          rows: [preflightState(override)],
        },
      }),
    );

    expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.state);
    expect(outcome.log).toMatchObject({
      status: "failed",
      result: "not_started",
      reason: "database_identity_mismatch",
    });
    expect(client.query).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "issue75-bootstrap-role-create" }),
    );
  });

  it.each([
    exactRoleState(),
    exactDatabaseState(true),
  ])("rejects an existing target object before mutation", async (targetState) => {
    const { client, outcome } = await bootstrap(
      baseResponses({
        "issue75-bootstrap-preflight": {
          rows: [preflightState(targetState)],
        },
      }),
    );

    expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.state);
    expect(outcome.log.reason).toBe("existing_target_object");
    expect(client.query).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "issue75-bootstrap-role-create" }),
    );
  });

  it("refuses a concurrent bootstrap without inspecting or changing targets", async () => {
    const { client, outcome } = await bootstrap(
      baseResponses({
        "issue75-bootstrap-advisory-lock": {
          rows: [{ lock_acquired: false }],
        },
      }),
    );

    expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.state);
    expect(outcome.log.reason).toBe("bootstrap_already_running");
    expect(client.query).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "issue75-bootstrap-preflight" }),
    );
  });
});

describe("database bootstrap creation", () => {
  it("creates one least-privilege role and an admin-owned database", async () => {
    const {
      client,
      schemaClient,
      applicationClient,
      createAdminClient,
      createSchemaClient,
      createTargetClient,
      outcome,
    } = await bootstrap();

    expect(outcome).toEqual({
      exitCode: DB_BOOTSTRAP_EXIT_CODES.success,
      log: {
        component: "koho_db_bootstrap",
        schemaVersion: 1,
        status: "succeeded",
        result: "confirmed",
        reason: null,
        databaseCreatedConfirmed: true,
        roleCreatedConfirmed: true,
        cleanupAttempted: false,
        cleanupConfirmed: false,
      },
    });
    expect(createAdminClient).toHaveBeenCalledWith(ADMIN_URL);
    expect(createSchemaClient).toHaveBeenCalledOnce();
    expect(createTargetClient).toHaveBeenCalledOnce();
    expect(createSchemaClient.mock.calls[0][0]).toBe(
      `postgres://issue75admin:${ADMIN_SECRET}` +
        `@${EXPECTED_HOST}/${TARGET_DATABASE}?sslmode=verify-full`,
    );
    expect(createTargetClient.mock.calls[0][0]).toBe(
      `postgres://issue75_app:${TARGET_SECRET}` +
        `@${EXPECTED_HOST}/${TARGET_DATABASE}?sslmode=verify-full`,
    );
    expect(client.end).toHaveBeenCalledOnce();
    expect(client.removeListener).toHaveBeenCalledOnce();
    expect(schemaClient.end).toHaveBeenCalledOnce();
    expect(applicationClient.end).toHaveBeenCalledOnce();

    const roleVerifier = client.query.mock.calls.find(
      ([request]) => request.name === "issue75-bootstrap-role-verifier",
    )?.[0];
    expect(roleVerifier?.values[0]).toBe(TARGET_USER);
    expect(
      typeof roleVerifier?.values[1] === "string" &&
        /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$/.test(
          roleVerifier.values[1],
        ),
    ).toBe(true);

    const roleCreate = client.query.mock.calls.find(
      ([request]) => request.name === "issue75-bootstrap-role-create",
    )?.[0];
    expect(roleCreate?.text).toContain("NOSUPERUSER NOCREATEDB NOCREATEROLE");
    expect(roleCreate?.text).toContain(
      "NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT",
    );
    expect(roleCreate?.text).not.toContain(TARGET_SECRET);

    const databaseCreate = client.query.mock.calls.find(
      ([request]) => request.name === "issue75-bootstrap-database-create",
    )?.[0];
    expect(databaseCreate?.text).toContain(
      "CREATE DATABASE issue75_staging",
    );
    expect(databaseCreate?.text).not.toContain("OWNER");
    expect(databaseCreate?.text).toContain("TEMPLATE = template0");

    const revoke = client.query.mock.calls.find(
      ([request]) =>
        request.name === "issue75-bootstrap-database-revoke-public",
    )?.[0];
    expect(revoke?.text).toContain("FROM PUBLIC");
    const databaseGrant = client.query.mock.calls.find(
      ([request]) =>
        request.name === "issue75-bootstrap-database-grant-target",
    )?.[0];
    expect(databaseGrant?.text).toContain(
      "GRANT CONNECT, CREATE",
    );
    expect(databaseGrant?.text).toContain(
      "ON DATABASE issue75_staging",
    );
    expect(databaseGrant?.text).toContain("TO issue75_app");
    const revokeIndex = client.query.mock.calls.findIndex(
      ([request]) =>
        request.name === "issue75-bootstrap-database-revoke-public",
    );
    const finalStateIndex = client.query.mock.calls.findIndex(
      ([request]) => request.name === "issue75-bootstrap-final-state",
    );
    const databaseGrantIndex = client.query.mock.calls.findIndex(
      ([request]) =>
        request.name === "issue75-bootstrap-database-grant-target",
    );
    const revokeOrder = client.query.mock.invocationCallOrder[revokeIndex];
    expect(revokeOrder).toBeLessThan(
      schemaClient.query.mock.invocationCallOrder[0],
    );
    expect(schemaClient.query.mock.invocationCallOrder.at(-1)).toBeLessThan(
      client.query.mock.invocationCallOrder[databaseGrantIndex],
    );
    expect(client.query.mock.invocationCallOrder[finalStateIndex]).toBeGreaterThan(
      client.query.mock.invocationCallOrder[databaseGrantIndex],
    );
    expect(applicationClient.query.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      client.query.mock.invocationCallOrder[finalStateIndex],
    );
    const schemaRevoke = schemaClient.query.mock.calls.find(
      ([request]) =>
        request.name === "issue75-bootstrap-schema-revoke-public",
    )?.[0];
    expect(schemaRevoke?.text).toContain("SCHEMA public FROM PUBLIC");
    const publicSchemaGrant = schemaClient.query.mock.calls.find(
      ([request]) =>
        request.name === "issue75-bootstrap-schema-grant-public-target",
    )?.[0];
    expect(publicSchemaGrant?.text).toContain(
      "GRANT USAGE, CREATE ON SCHEMA public TO issue75_app",
    );
    const queryPayloads = [client, schemaClient, applicationClient].flatMap(
      (databaseClient) =>
        databaseClient.query.mock.calls.map(([request]) => request),
    );
    const serializedQueryPayloads = JSON.stringify(queryPayloads);
    expect(serializedQueryPayloads.includes(ADMIN_SECRET)).toBe(false);
    expect(serializedQueryPayloads.includes(TARGET_SECRET)).toBe(false);
    expect(serializedQueryPayloads.includes(ADMIN_URL)).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain(ADMIN_SECRET);
    expect(JSON.stringify(outcome)).not.toContain(TARGET_SECRET);
  });

  it("does not print secrets or raw errors when role creation fails", async () => {
    const { outcome } = await bootstrap(
      baseResponses({
        "issue75-bootstrap-role-create": new Error(
          `${RAW_ERROR_SECRET} ${ADMIN_URL} ${TARGET_SECRET}`,
        ),
      }),
    );

    expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.create);
    expect(outcome.log).toMatchObject({
      status: "failed",
      result: "rolled_back",
      reason: "role_create_failed",
      databaseCreatedConfirmed: false,
      roleCreatedConfirmed: false,
      cleanupAttempted: true,
      cleanupConfirmed: true,
    });
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(RAW_ERROR_SECRET);
    expect(serialized).not.toContain(ADMIN_SECRET);
    expect(serialized).not.toContain(TARGET_SECRET);
    expect(serialized).not.toContain(EXPECTED_HOST);
  });

  it("accepts a lost CREATE DATABASE response only after exact reconciliation", async () => {
    const { outcome } = await bootstrap(
      baseResponses({
        "issue75-bootstrap-database-create": new Error(RAW_ERROR_SECRET),
        "issue75-bootstrap-database-reconcile": {
          rows: [exactDatabaseState(false)],
        },
      }),
    );

    expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.success);
    expect(outcome.log.result).toBe("confirmed");
  });

  it("does not adopt a database after a server-confirmed CREATE rejection", async () => {
    const { createSchemaClient, outcome } = await bootstrap(
      baseResponses({
        "issue75-bootstrap-database-create": postgresError("42P04"),
        "issue75-bootstrap-database-reconcile": {
          rows: [exactDatabaseState(false)],
        },
      }),
    );

    expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.state);
    expect(outcome.log).toMatchObject({
      status: "failed",
      result: "unknown",
      reason: "existing_target_object",
      databaseCreatedConfirmed: false,
      roleCreatedConfirmed: true,
    });
    expect(createSchemaClient).not.toHaveBeenCalled();
  });

  it.each([
    { user_name: "other_user" },
    { parent_membership_count: "1" },
    { is_database_owner: true },
    { can_connect_to_database: false },
    { can_create_in_database: false },
    { can_create_temporary_objects: true },
    { can_create_in_public_schema: false },
    { can_use_public_schema: false },
  ])("fails closed on an application identity mismatch %#", async (override) => {
    const applicationClient = fakeClient(
      applicationResponses({
        "issue75-bootstrap-application-identity": {
          rows: [
            {
              ...(
                applicationResponses()[
                  "issue75-bootstrap-application-identity"
                ] as QueryResult
              ).rows[0],
              ...override,
            },
          ],
        },
      }),
    );
    const { outcome } = await bootstrap(baseResponses(), {
      createApplicationClient: vi.fn(() => applicationClient),
    });

    expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.verify);
    expect(outcome.log).toMatchObject({
      status: "failed",
      result: "unknown",
      reason: "application_identity_mismatch",
      databaseCreatedConfirmed: true,
      roleCreatedConfirmed: true,
    });
    expect(applicationClient.end).toHaveBeenCalledOnce();
    expect(JSON.stringify(outcome)).not.toContain(TARGET_SECRET);
  });

  it("fails closed when schema least privilege cannot be confirmed", async () => {
    const schemaClient = fakeClient(
      schemaResponses({
        "issue75-bootstrap-schema-grant-public-target": new Error(
          `${RAW_ERROR_SECRET} ${TARGET_SECRET}`,
        ),
        "issue75-bootstrap-schema-reconcile": {
          rows: [
            {
              schema_name: "public",
              schema_owner: "azure_pg_admin",
              public_privileges_revoked: false,
              target_privilege_count: "0",
              target_has_no_grant_option: true,
              unexpected_grantee_count: "0",
              target_has_usage: false,
              target_has_create: false,
              unexpected_schema_count: "0",
            },
          ],
        },
      }),
    );
    const { outcome } = await bootstrap(baseResponses(), {
      createSchemaAdminClient: vi.fn(() => schemaClient),
    });

    expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.create);
    expect(outcome.log).toMatchObject({
      status: "failed",
      result: "unknown",
      reason: "schema_privilege_failed",
      databaseCreatedConfirmed: true,
      roleCreatedConfirmed: true,
      cleanupAttempted: true,
      cleanupConfirmed: true,
    });
    expect(
      schemaClient.query.mock.calls.filter(
        ([request]) =>
          request.name === "issue75-bootstrap-schema-grant-public-target",
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(outcome)).not.toContain(RAW_ERROR_SECRET);
    expect(JSON.stringify(outcome)).not.toContain(TARGET_SECRET);
  });

  it("accepts only an ambiguous schema COMMIT after exact reconciliation", async () => {
    const schemaClient = fakeClient(
      schemaResponses({
        "issue75-bootstrap-schema-commit": new Error(RAW_ERROR_SECRET),
      }),
    );
    const { outcome } = await bootstrap(baseResponses(), {
      createSchemaAdminClient: vi.fn(() => schemaClient),
    });

    expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.success);
    expect(outcome.log).toMatchObject({
      result: "confirmed",
      cleanupAttempted: true,
      cleanupConfirmed: true,
    });
    expect(schemaClient.query).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "issue75-bootstrap-schema-reconcile",
      }),
    );
  });

  it.each([
    "issue75-bootstrap-schema-revoke-public",
    "issue75-bootstrap-schema-grant-public-target",
  ])(
    "does not reconcile an ambiguous intermediate schema write at %s",
    async (failureQuery) => {
      const schemaClient = fakeClient(
        schemaResponses({ [failureQuery]: new Error(RAW_ERROR_SECRET) }),
      );
      const { createTargetClient, outcome } = await bootstrap(baseResponses(), {
        createSchemaAdminClient: vi.fn(() => schemaClient),
      });

      expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.create);
      expect(outcome.log).toMatchObject({
        status: "failed",
        result: "unknown",
        reason: "schema_privilege_failed",
        cleanupAttempted: true,
        cleanupConfirmed: true,
      });
      expect(schemaClient.query).not.toHaveBeenCalledWith(
        expect.objectContaining({
          name: "issue75-bootstrap-schema-reconcile",
        }),
      );
      expect(createTargetClient).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      failureQuery: "issue75-bootstrap-schema-revoke-public",
      response: postgresError("42501"),
      reason: "schema_privilege_failed",
      exitCode: DB_BOOTSTRAP_EXIT_CODES.create,
    },
    {
      failureQuery: "issue75-bootstrap-schema-grant-public-target",
      response: postgresError("42501"),
      reason: "schema_privilege_failed",
      exitCode: DB_BOOTSTRAP_EXIT_CODES.create,
    },
    {
      failureQuery: "issue75-bootstrap-schema-commit",
      response: postgresError("42501"),
      reason: "schema_commit_failed",
      exitCode: DB_BOOTSTRAP_EXIT_CODES.create,
    },
    {
      failureQuery: "issue75-bootstrap-schema-state",
      response: new Error(RAW_ERROR_SECRET),
      reason: "schema_state_failed",
      exitCode: DB_BOOTSTRAP_EXIT_CODES.verify,
    },
    {
      failureQuery: "issue75-bootstrap-schema-state",
      response: {
        rows: [
          {
            ...exactSchemaState()[0],
            target_has_create: false,
          },
        ],
      },
      reason: "schema_state_mismatch",
      exitCode: DB_BOOTSTRAP_EXIT_CODES.verify,
    },
  ])(
    "does not reconcile a non-ambiguous schema failure %#",
    async ({ failureQuery, response, reason, exitCode }) => {
      const schemaClient = fakeClient(
        schemaResponses({ [failureQuery]: response }),
      );
      const { createTargetClient, outcome } = await bootstrap(
        baseResponses(),
        { createSchemaAdminClient: vi.fn(() => schemaClient) },
      );

      expect(outcome.exitCode).toBe(exitCode);
      expect(outcome.log).toMatchObject({
        status: "failed",
        result: "unknown",
        reason,
        cleanupAttempted: true,
        cleanupConfirmed: true,
      });
      expect(schemaClient.query).not.toHaveBeenCalledWith(
        expect.objectContaining({
          name: "issue75-bootstrap-schema-reconcile",
        }),
      );
      expect(createTargetClient).not.toHaveBeenCalled();
    },
  );

  it("uses schema rollback failure precedence without retrying", async () => {
    const schemaClient = fakeClient(
      schemaResponses({
        "issue75-bootstrap-schema-grant-public-target":
          postgresError("42501"),
        "issue75-bootstrap-schema-rollback": new Error(RAW_ERROR_SECRET),
      }),
    );
    const { createTargetClient, outcome } = await bootstrap(baseResponses(), {
      createSchemaAdminClient: vi.fn(() => schemaClient),
    });

    expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.cleanup);
    expect(outcome.log).toMatchObject({
      status: "failed",
      result: "unknown",
      reason: "schema_rollback_failed",
      databaseCreatedConfirmed: true,
      roleCreatedConfirmed: true,
      cleanupAttempted: true,
      cleanupConfirmed: false,
    });
    expect(
      schemaClient.query.mock.calls.filter(
        ([request]) => request.name === "issue75-bootstrap-schema-rollback",
      ),
    ).toHaveLength(1);
    expect(schemaClient.query).not.toHaveBeenCalledWith(
      expect.objectContaining({
        name: "issue75-bootstrap-schema-reconcile",
      }),
    );
    expect(createTargetClient).not.toHaveBeenCalled();
    expect(JSON.stringify(outcome)).not.toContain(RAW_ERROR_SECRET);
  });

  it("uses schema rollback timeout precedence without retrying", async () => {
    vi.useFakeTimers();
    try {
      const schemaClient = fakeClient(
        schemaResponses({
          "issue75-bootstrap-schema-grant-public-target":
            postgresError("42501"),
          "issue75-bootstrap-schema-rollback": () => neverResolves(),
        }),
      );
      const createTargetClient = vi.fn(() =>
        fakeClient(applicationResponses()),
      );
      const outcomePromise = runDatabaseBootstrap({
        environment: environment(),
        dependencies: {
          createAdminClient: vi.fn(() => fakeClient()),
          createSchemaAdminClient: vi.fn(() => schemaClient),
          createApplicationClient: createTargetClient,
        },
      });

      await vi.advanceTimersByTimeAsync(30_000);
      const outcome = await outcomePromise;

      expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.cleanup);
      expect(outcome.log).toMatchObject({
        status: "failed",
        result: "unknown",
        reason: "schema_rollback_timed_out",
        databaseCreatedConfirmed: true,
        roleCreatedConfirmed: true,
        cleanupAttempted: true,
        cleanupConfirmed: false,
      });
      expect(
        schemaClient.query.mock.calls.filter(
          ([request]) => request.name === "issue75-bootstrap-schema-rollback",
        ),
      ).toHaveLength(1);
      expect(schemaClient.query).not.toHaveBeenCalledWith(
        expect.objectContaining({
          name: "issue75-bootstrap-schema-reconcile",
        }),
      );
      expect(createTargetClient).not.toHaveBeenCalled();
      expect(JSON.stringify(outcome)).not.toContain(RAW_ERROR_SECRET);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not accept exact ACLs after a server-confirmed DB grant failure", async () => {
    const { applicationClient, client, outcome } = await bootstrap(
      baseResponses({
        "issue75-bootstrap-database-grant-target": postgresError("42501"),
      }),
    );

    expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.create);
    expect(outcome.log).toMatchObject({
      status: "failed",
      result: "unknown",
      reason: "database_privilege_failed",
    });
    expect(client.query).not.toHaveBeenCalledWith(
      expect.objectContaining({
        name: "issue75-bootstrap-database-privilege-reconcile",
      }),
    );
    expect(applicationClient.connect).not.toHaveBeenCalled();
  });

  it("accepts an ambiguous DB grant only after exact reconciliation", async () => {
    const { client, outcome } = await bootstrap(
      baseResponses({
        "issue75-bootstrap-database-grant-target": new Error(
          RAW_ERROR_SECRET,
        ),
      }),
    );

    expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.success);
    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "issue75-bootstrap-database-privilege-reconcile",
      }),
    );
  });

  it.each([
    { label: "ambiguous", response: new Error(RAW_ERROR_SECRET) },
    { label: "server-confirmed", response: postgresError("42501") },
  ])(
    "does not reconcile an intermediate DB ACL revoke ($label)",
    async ({ response }) => {
      const { applicationClient, client, outcome } = await bootstrap(
        baseResponses({
          "issue75-bootstrap-database-revoke-public": response,
        }),
      );

      expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.create);
      expect(outcome.log).toMatchObject({
        status: "failed",
        result: "unknown",
        reason: "database_privilege_failed",
      });
      expect(client.query).not.toHaveBeenCalledWith(
        expect.objectContaining({
          name: "issue75-bootstrap-database-privilege-reconcile",
        }),
      );
      expect(client.query).not.toHaveBeenCalledWith(
        expect.objectContaining({
          name: "issue75-bootstrap-database-grant-target",
        }),
      );
      expect(applicationClient.connect).not.toHaveBeenCalled();
    },
  );

  it.each([
    { schemaName: "public", override: { schema_owner: "other_owner" } },
    {
      schemaName: "public",
      override: { unexpected_grantee_count: "1" },
    },
    {
      schemaName: "public",
      override: { target_has_no_grant_option: false },
    },
    {
      schemaName: "public",
      override: { unexpected_schema_count: "1" },
    },
  ])("rejects an unexpected schema ACL %#", async ({ schemaName, override }) => {
    const unsafeState = exactSchemaState().map((row) =>
      row.schema_name === schemaName ? { ...row, ...override } : row,
    );
    const schemaClient = fakeClient(
      schemaResponses({
        "issue75-bootstrap-schema-state": { rows: unsafeState },
        "issue75-bootstrap-schema-reconcile": { rows: unsafeState },
      }),
    );
    const { outcome } = await bootstrap(baseResponses(), {
      createSchemaAdminClient: vi.fn(() => schemaClient),
    });

    expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.verify);
    expect(outcome.log).toMatchObject({
      status: "failed",
      result: "unknown",
      reason: "schema_state_mismatch",
    });
  });

  it.each([
    { target_role_parent_membership_count: "1" },
    { target_role_other_member_count: "1" },
  ])(
    "rejects unsafe target role membership %# before schema mutation",
    async (membershipOverride) => {
      const { createSchemaClient, outcome } = await bootstrap(
        baseResponses({
          "issue75-bootstrap-database-state": {
            rows: [
              {
                ...exactDatabaseState(false),
                ...membershipOverride,
              },
            ],
          },
          "issue75-bootstrap-final-state": {
            rows: [
              {
                ...exactDatabaseState(true),
                ...membershipOverride,
              },
            ],
          },
        }),
      );

      expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.verify);
      expect(outcome.log).toMatchObject({
        status: "failed",
        result: "unknown",
        reason: "database_state_mismatch",
      });
      expect(createSchemaClient).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      postgresMajor: 16 as const,
      override: {
        target_role_creator_membership_count: "0",
        target_role_creator_admin_option: null,
        target_role_creator_inherit_option: null,
        target_role_creator_set_option: null,
      },
    },
    {
      postgresMajor: 16 as const,
      override: { target_role_creator_admin_option: false },
    },
    {
      postgresMajor: 16 as const,
      override: { target_role_creator_inherit_option: true },
    },
    {
      postgresMajor: 16 as const,
      override: { target_role_creator_set_option: true },
    },
    {
      postgresMajor: 16 as const,
      override: { createrole_self_grant: "inherit" },
    },
  ])(
    "rejects a version-incompatible creator membership %#",
    async ({ postgresMajor, override }) => {
      const { createSchemaClient, outcome } = await bootstrap(
        baseResponses({
          "issue75-bootstrap-preflight": {
            rows: [preflightState(emptyTargetState(postgresMajor))],
          },
          "issue75-bootstrap-role-state": {
            rows: [{ ...exactRoleState(postgresMajor), ...override }],
          },
          "issue75-bootstrap-role-rollback-state": {
            rows: [emptyTargetState(postgresMajor)],
          },
        }),
      );

      expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.verify);
      expect(outcome.log).toMatchObject({
        status: "failed",
        result: "rolled_back",
        reason: "role_state_mismatch",
        cleanupAttempted: true,
        cleanupConfirmed: true,
      });
      expect(createSchemaClient).not.toHaveBeenCalled();
    },
  );

  it("rejects PostgreSQL 15 before any mutation", async () => {
    const { client, createSchemaClient, outcome } = await bootstrap(
      baseResponses({
        "issue75-bootstrap-preflight": {
          rows: [
            preflightState({
              ...emptyTargetState(15),
              server_version_is_supported: true,
            }),
          ],
        },
      }),
    );

    expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.state);
    expect(outcome.log).toMatchObject({
      status: "failed",
      result: "not_started",
      reason: "database_identity_mismatch",
    });
    expect(client.query).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "issue75-bootstrap-role-begin" }),
    );
    expect(client.query).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "issue75-bootstrap-role-create" }),
    );
    expect(createSchemaClient).not.toHaveBeenCalled();
  });

  it("accepts the PostgreSQL 16 creator-only incoming role edge", async () => {
    const { outcome } = await bootstrap(
      baseResponses({
        "issue75-bootstrap-preflight": {
          rows: [preflightState(emptyTargetState(16))],
        },
        "issue75-bootstrap-role-state": {
          rows: [exactRoleState(16)],
        },
        "issue75-bootstrap-database-reconcile": {
          rows: [exactDatabaseState(false, 16)],
        },
        "issue75-bootstrap-database-state": {
          rows: [exactDatabaseState(false, 16)],
        },
        "issue75-bootstrap-database-privilege-reconcile": {
          rows: [exactDatabaseState(true, 16)],
        },
        "issue75-bootstrap-final-state": {
          rows: [exactDatabaseState(true, 16)],
        },
      }),
    );

    expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.success);
    expect(outcome.log.result).toBe("confirmed");
  });

  it.each([
    { target_database_target_privilege_count: "1" },
    { target_database_target_has_no_grant_option: false },
    { target_database_target_has_connect: false },
    { target_database_target_has_create: false },
    { target_database_target_has_temporary: true },
    { target_database_unexpected_grantee_count: "1" },
  ])("rejects a non-exact final database ACL %#", async (override) => {
    const { outcome } = await bootstrap(
      baseResponses({
        "issue75-bootstrap-final-state": {
          rows: [{ ...exactDatabaseState(true), ...override }],
        },
      }),
    );

    expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.verify);
    expect(outcome.log).toMatchObject({
      status: "failed",
      result: "unknown",
      reason: "final_state_mismatch",
    });
  });
});

describe("database bootstrap unknown result and cleanup", () => {
  it("preserves the target when a CREATE result cannot be reconciled", async () => {
    const { client, outcome } = await bootstrap(
      baseResponses({
        "issue75-bootstrap-database-create": new Error(RAW_ERROR_SECRET),
        "issue75-bootstrap-database-reconcile": new Error(
          `${RAW_ERROR_SECRET} ${TARGET_SECRET}`,
        ),
      }),
    );

    expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.create);
    expect(outcome.log).toMatchObject({
      status: "failed",
      result: "unknown",
      reason: "database_create_failed",
      databaseCreatedConfirmed: false,
      roleCreatedConfirmed: true,
      cleanupAttempted: false,
      cleanupConfirmed: false,
    });
    expect(client.query).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "issue75-bootstrap-cleanup-role" }),
    );
    expect(JSON.stringify(outcome)).not.toContain(RAW_ERROR_SECRET);
    expect(JSON.stringify(outcome)).not.toContain(TARGET_SECRET);
  });

  it("drops only the exact role after confirming that database creation failed", async () => {
    const { client, outcome } = await bootstrap(
      baseResponses({
        "issue75-bootstrap-database-create": new Error(RAW_ERROR_SECRET),
        "issue75-bootstrap-database-reconcile": {
          rows: [exactRoleState()],
        },
        "issue75-bootstrap-cleanup-state": {
          rows: [emptyTargetState()],
        },
      }),
    );

    expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.create);
    expect(outcome.log).toMatchObject({
      result: "rolled_back",
      reason: "database_create_failed",
      databaseCreatedConfirmed: false,
      roleCreatedConfirmed: false,
      cleanupAttempted: true,
      cleanupConfirmed: true,
    });
    const cleanup = client.query.mock.calls.find(
      ([request]) => request.name === "issue75-bootstrap-cleanup-role",
    )?.[0];
    expect(cleanup?.text.trim()).toBe("DROP ROLE issue75_app");
  });

  it("uses cleanup failure precedence and never retries a destructive query", async () => {
    const { client, outcome } = await bootstrap(
      baseResponses({
        "issue75-bootstrap-database-create": new Error(RAW_ERROR_SECRET),
        "issue75-bootstrap-database-reconcile": {
          rows: [exactRoleState()],
        },
        "issue75-bootstrap-cleanup-role": new Error(RAW_ERROR_SECRET),
        "issue75-bootstrap-cleanup-state": {
          rows: [exactRoleState()],
        },
      }),
    );

    expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.cleanup);
    expect(outcome.log).toMatchObject({
      result: "unknown",
      reason: "cleanup_failed",
      roleCreatedConfirmed: true,
      cleanupAttempted: true,
      cleanupConfirmed: false,
    });
    expect(
      client.query.mock.calls.filter(
        ([request]) => request.name === "issue75-bootstrap-cleanup-role",
      ),
    ).toHaveLength(1);
  });

  it("uses cleanup failure precedence when the client cannot close", async () => {
    const client = fakeClient();
    client.end.mockRejectedValueOnce(new Error(RAW_ERROR_SECRET));
    const schemaClient = fakeClient(schemaResponses());
    const applicationClient = fakeClient(applicationResponses());
    const outcome = await runDatabaseBootstrap({
      environment: environment(),
      dependencies: {
        createAdminClient: vi.fn(() => client),
        createSchemaAdminClient: vi.fn(() => schemaClient),
        createApplicationClient: vi.fn(() => applicationClient),
      },
    });

    expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.cleanup);
    expect(outcome.log).toMatchObject({
      status: "failed",
      result: "unknown",
      reason: "cleanup_failed",
      databaseCreatedConfirmed: true,
      roleCreatedConfirmed: true,
      cleanupAttempted: true,
      cleanupConfirmed: false,
    });
    expect(client.removeListener).not.toHaveBeenCalled();
    expect(JSON.stringify(outcome)).not.toContain(RAW_ERROR_SECRET);
  });

  it("marks a schema client cleanup failure as unconfirmed", async () => {
    const schemaClient = fakeClient(schemaResponses());
    schemaClient.end.mockRejectedValueOnce(new Error(RAW_ERROR_SECRET));
    const createTargetClient = vi.fn(() =>
      fakeClient(applicationResponses()),
    );
    const outcome = await runDatabaseBootstrap({
      environment: environment(),
      dependencies: {
        createAdminClient: vi.fn(() => fakeClient()),
        createSchemaAdminClient: vi.fn(() => schemaClient),
        createApplicationClient: createTargetClient,
      },
    });

    expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.cleanup);
    expect(outcome.log).toMatchObject({
      status: "failed",
      result: "unknown",
      reason: "schema_client_cleanup_failed",
      cleanupAttempted: true,
      cleanupConfirmed: false,
    });
    expect(createTargetClient).not.toHaveBeenCalled();
    expect(JSON.stringify(outcome)).not.toContain(RAW_ERROR_SECRET);
  });

  it("does not preserve cleanup confirmation after schema client close fails", async () => {
    const schemaClient = fakeClient(
      schemaResponses({
        "issue75-bootstrap-schema-grant-public-target":
          postgresError("42501"),
      }),
    );
    schemaClient.end.mockRejectedValueOnce(new Error(RAW_ERROR_SECRET));
    const outcome = await runDatabaseBootstrap({
      environment: environment(),
      dependencies: {
        createAdminClient: vi.fn(() => fakeClient()),
        createSchemaAdminClient: vi.fn(() => schemaClient),
        createApplicationClient: vi.fn(() =>
          fakeClient(applicationResponses()),
        ),
      },
    });

    expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.cleanup);
    expect(outcome.log).toMatchObject({
      status: "failed",
      result: "unknown",
      reason: "schema_client_cleanup_failed",
      cleanupAttempted: true,
      cleanupConfirmed: false,
    });
    expect(schemaClient.query).toHaveBeenCalledWith(
      expect.objectContaining({ name: "issue75-bootstrap-schema-rollback" }),
    );
  });

  it("marks an application client cleanup failure as unconfirmed", async () => {
    const applicationClient = fakeClient(applicationResponses());
    applicationClient.end.mockRejectedValueOnce(new Error(RAW_ERROR_SECRET));
    const outcome = await runDatabaseBootstrap({
      environment: environment(),
      dependencies: {
        createAdminClient: vi.fn(() => fakeClient()),
        createSchemaAdminClient: vi.fn(() => fakeClient(schemaResponses())),
        createApplicationClient: vi.fn(() => applicationClient),
      },
    });

    expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.cleanup);
    expect(outcome.log).toMatchObject({
      status: "failed",
      result: "unknown",
      reason: "application_client_cleanup_failed",
      cleanupAttempted: true,
      cleanupConfirmed: false,
    });
    expect(JSON.stringify(outcome)).not.toContain(RAW_ERROR_SECRET);
  });

  it("times out a permanently pending schema admin connection", async () => {
    vi.useFakeTimers();
    try {
      const schemaClient = fakeClient(schemaResponses());
      schemaClient.connect.mockImplementationOnce(() => neverResolves());
      const createTargetClient = vi.fn(() =>
        fakeClient(applicationResponses()),
      );
      const outcomePromise = runDatabaseBootstrap({
        environment: environment(),
        dependencies: {
          createAdminClient: vi.fn(() => fakeClient()),
          createSchemaAdminClient: vi.fn(() => schemaClient),
          createApplicationClient: createTargetClient,
        },
      });

      await vi.advanceTimersByTimeAsync(15_000);
      const outcome = await outcomePromise;

      expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.verify);
      expect(outcome.log).toMatchObject({
        status: "failed",
        result: "unknown",
        reason: "schema_admin_connect_timed_out",
      });
      expect(schemaClient.end).toHaveBeenCalledOnce();
      expect(schemaClient.query).not.toHaveBeenCalled();
      expect(createTargetClient).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a permanently pending application connection", async () => {
    vi.useFakeTimers();
    try {
      const applicationClient = fakeClient(applicationResponses());
      applicationClient.connect.mockImplementationOnce(() => neverResolves());
      const outcomePromise = runDatabaseBootstrap({
        environment: environment(),
        dependencies: {
          createAdminClient: vi.fn(() => fakeClient()),
          createSchemaAdminClient: vi.fn(() => fakeClient(schemaResponses())),
          createApplicationClient: vi.fn(() => applicationClient),
        },
      });

      await vi.advanceTimersByTimeAsync(15_000);
      const outcome = await outcomePromise;

      expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.verify);
      expect(outcome.log).toMatchObject({
        status: "failed",
        result: "unknown",
        reason: "application_connect_timed_out",
      });
      expect(applicationClient.end).toHaveBeenCalledOnce();
      expect(applicationClient.query).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a permanently pending schema client cleanup", async () => {
    vi.useFakeTimers();
    try {
      const schemaClient = fakeClient(schemaResponses());
      schemaClient.end.mockImplementationOnce(() => neverResolves());
      const createTargetClient = vi.fn(() =>
        fakeClient(applicationResponses()),
      );
      const outcomePromise = runDatabaseBootstrap({
        environment: environment(),
        dependencies: {
          createAdminClient: vi.fn(() => fakeClient()),
          createSchemaAdminClient: vi.fn(() => schemaClient),
          createApplicationClient: createTargetClient,
        },
      });

      await vi.advanceTimersByTimeAsync(5_000);
      const outcome = await outcomePromise;

      expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.cleanup);
      expect(outcome.log).toMatchObject({
        status: "failed",
        result: "unknown",
        reason: "schema_client_cleanup_timed_out",
        cleanupAttempted: true,
        cleanupConfirmed: false,
      });
      expect(schemaClient.end).toHaveBeenCalledOnce();
      expect(createTargetClient).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a permanently pending application client cleanup", async () => {
    vi.useFakeTimers();
    try {
      const applicationClient = fakeClient(applicationResponses());
      applicationClient.end.mockImplementationOnce(() => neverResolves());
      const outcomePromise = runDatabaseBootstrap({
        environment: environment(),
        dependencies: {
          createAdminClient: vi.fn(() => fakeClient()),
          createSchemaAdminClient: vi.fn(() => fakeClient(schemaResponses())),
          createApplicationClient: vi.fn(() => applicationClient),
        },
      });

      await vi.advanceTimersByTimeAsync(5_000);
      const outcome = await outcomePromise;

      expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.cleanup);
      expect(outcome.log).toMatchObject({
        status: "failed",
        result: "unknown",
        reason: "application_client_cleanup_timed_out",
        cleanupAttempted: true,
        cleanupConfirmed: false,
      });
      expect(applicationClient.end).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("always attempts client cleanup after a connection failure", async () => {
    const client = fakeClient();
    client.connect.mockRejectedValueOnce(new Error(RAW_ERROR_SECRET));
    const outcome = await runDatabaseBootstrap({
      environment: environment(),
      dependencies: { createAdminClient: vi.fn(() => client) },
    });

    expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.connect);
    expect(outcome.log.reason).toBe("connect_failed");
    expect(outcome.log.result).toBe("not_started");
    expect(client.end).toHaveBeenCalledOnce();
    expect(JSON.stringify(outcome)).not.toContain(RAW_ERROR_SECRET);
  });

  it("times out a permanently pending admin connection", async () => {
    vi.useFakeTimers();
    try {
      const client = fakeClient();
      client.connect.mockImplementationOnce(() => neverResolves());
      const outcomePromise = runDatabaseBootstrap({
        environment: environment(),
        dependencies: { createAdminClient: vi.fn(() => client) },
      });

      await vi.advanceTimersByTimeAsync(15_000);
      const outcome = await outcomePromise;

      expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.connect);
      expect(outcome.log).toMatchObject({
        status: "failed",
        result: "not_started",
        reason: "connect_timed_out",
      });
      expect(client.end).toHaveBeenCalledOnce();
      expect(client.query).not.toHaveBeenCalled();
      expect(JSON.stringify(outcome)).not.toContain(TARGET_SECRET);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a permanently pending preflight query", async () => {
    vi.useFakeTimers();
    try {
      const client = fakeClient(
        baseResponses({
          "issue75-bootstrap-preflight": () => neverResolves(),
        }),
      );
      const outcomePromise = runDatabaseBootstrap({
        environment: environment(),
        dependencies: { createAdminClient: vi.fn(() => client) },
      });

      await vi.advanceTimersByTimeAsync(30_000);
      const outcome = await outcomePromise;

      expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.state);
      expect(outcome.log).toMatchObject({
        status: "failed",
        result: "not_started",
        reason: "preflight_timed_out",
      });
      expect(client.end).toHaveBeenCalledOnce();
      expect(client.query).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: "issue75-bootstrap-role-create" }),
      );
      expect(JSON.stringify(outcome)).not.toContain(TARGET_SECRET);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a permanently pending admin cleanup without retry", async () => {
    vi.useFakeTimers();
    try {
      const client = fakeClient();
      client.end.mockImplementationOnce(() => neverResolves());
      const schemaClient = fakeClient(schemaResponses());
      const applicationClient = fakeClient(applicationResponses());
      const outcomePromise = runDatabaseBootstrap({
        environment: environment(),
        dependencies: {
          createAdminClient: vi.fn(() => client),
          createSchemaAdminClient: vi.fn(() => schemaClient),
          createApplicationClient: vi.fn(() => applicationClient),
        },
      });

      await vi.advanceTimersByTimeAsync(5_000);
      const outcome = await outcomePromise;

      expect(outcome.exitCode).toBe(DB_BOOTSTRAP_EXIT_CODES.cleanup);
      expect(outcome.log).toMatchObject({
        status: "failed",
        result: "unknown",
        reason: "cleanup_timed_out",
        cleanupAttempted: true,
        cleanupConfirmed: false,
      });
      expect(
        client.query.mock.calls.filter(
          ([request]) => request.name === "issue75-bootstrap-database-create",
        ),
      ).toHaveLength(1);
      expect(client.end).toHaveBeenCalledOnce();
      expect(JSON.stringify(outcome)).not.toContain(TARGET_SECRET);
    } finally {
      vi.useRealTimers();
    }
  });

  it("entrypoint emits one safe JSON line and no stderr", () => {
    const entrypoint = fileURLToPath(
      new URL("./db-bootstrap.mjs", import.meta.url),
    );
    const result = spawnSync(process.execPath, [entrypoint], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      encoding: "utf8",
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "" },
      timeout: 10_000,
    });

    expect(result.status).toBe(DB_BOOTSTRAP_EXIT_CODES.config);
    expect(result.stderr).toBe("");
    expect(result.stdout.split(/\r?\n/)).toHaveLength(2);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      component: "koho_db_bootstrap",
      schemaVersion: 1,
      status: "failed",
      result: "not_started",
      reason: "invalid_config",
      databaseCreatedConfirmed: false,
      roleCreatedConfirmed: false,
      cleanupAttempted: false,
      cleanupConfirmed: false,
    });
  });
});

for (const postgresMajor of ["15", "16"]) {
  it.skipIf(!RUN_POSTGRES_INTEGRATION)(
    `uses a generated verifier for a real PostgreSQL ${postgresMajor} login`,
    async () => {
      const containerName =
        `codex-issue75-scram-pg${postgresMajor}-${process.pid}`;
      const containerAdminPassword =
        "Fictional-Container-Admin-Secret-7!";
      const applicationPassword =
        "Fictional-Container-Target-Secret-8!";
      let rootClient: pg.Client | undefined;
      let adminClient: pg.Client | undefined;
      let schemaAdminClient: pg.Client | undefined;
      let applicationClient: pg.Client | undefined;

      try {
        docker([
          "run",
          "--detach",
          "--rm",
          "--name",
          containerName,
          "--env",
          `POSTGRES_PASSWORD=${containerAdminPassword}`,
          "--env",
          "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256",
          "--publish",
          "127.0.0.1::5432",
          `postgres:${postgresMajor}-alpine`,
        ]);
        await waitForPostgres(containerName);
        const publishedPort = docker([
          "port",
          containerName,
          "5432/tcp",
        ]);
        const portMatch = /:(\d+)$/.exec(publishedPort);
        if (portMatch === null) {
          throw new Error("fictional PostgreSQL port was not published");
        }
        const port = Number(portMatch[1]);
        rootClient = new pg.Client({
          host: "127.0.0.1",
          port,
          database: "postgres",
          user: "postgres",
          password: containerAdminPassword,
        });
        await rootClient.connect();

        const adminVerifier = createScramVerifier(
          containerAdminPassword,
        );
        await rootClient.query(
          "SELECT set_config('issue75_probe.admin_verifier', $1, false)",
          [adminVerifier],
        );
        await rootClient.query(`
          DO $issue75_probe$
          BEGIN
            EXECUTE format(
              'CREATE ROLE issue75_probe_admin WITH LOGIN PASSWORD %L CREATEDB CREATEROLE NOSUPERUSER NOINHERIT NOREPLICATION NOBYPASSRLS',
              current_setting('issue75_probe.admin_verifier')
            );
          END
          $issue75_probe$
        `);
        await rootClient.query("CREATE ROLE azure_pg_admin NOLOGIN");
        await rootClient.query(
          "GRANT azure_pg_admin TO issue75_probe_admin",
        );
        await rootClient.query("ALTER ROLE postgres NOLOGIN");

        adminClient = new pg.Client({
          host: "127.0.0.1",
          port,
          database: "postgres",
          user: "issue75_probe_admin",
          password: containerAdminPassword,
        });
        await adminClient.connect();
        if (postgresMajor === "16") {
          await adminClient.query("SET createrole_self_grant = ''");
        }

        const capturedBootstrap = await bootstrap();
        const roleVerifierRequest =
          capturedBootstrap.client.query.mock.calls.find(
            ([request]) =>
              request.name === "issue75-bootstrap-role-verifier",
          )?.[0];
        const roleCreateRequest =
          capturedBootstrap.client.query.mock.calls.find(
            ([request]) =>
              request.name === "issue75-bootstrap-role-create",
          )?.[0];
        if (
          roleVerifierRequest === undefined ||
          roleCreateRequest === undefined
        ) {
          throw new Error("role creation queries were not captured");
        }
        const verifier = createScramVerifier(applicationPassword);
        await adminClient.query("BEGIN");
        await adminClient.query({
          text: roleVerifierRequest.text,
          values: ["issue75_probe_app", verifier],
        });
        await adminClient.query(roleCreateRequest.text);
        await adminClient.query("COMMIT");
        await adminClient.query(`
          CREATE DATABASE issue75_probe_database
            WITH TEMPLATE = template0 ENCODING = 'UTF8'
        `);
        await adminClient.query(
          "REVOKE ALL PRIVILEGES ON DATABASE issue75_probe_database FROM PUBLIC",
        );
        await adminClient.query(
          "GRANT CONNECT, CREATE ON DATABASE issue75_probe_database TO issue75_probe_app",
        );

        schemaAdminClient = new pg.Client({
          host: "127.0.0.1",
          port,
          database: "issue75_probe_database",
          user: "issue75_probe_admin",
          password: containerAdminPassword,
        });
        await schemaAdminClient.connect();
        await schemaAdminClient.query(
          "REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC",
        );
        await schemaAdminClient.query(
          "GRANT USAGE, CREATE ON SCHEMA public TO issue75_probe_app",
        );

        const targetStateRequest = capturedBootstrap.client.query.mock.calls.find(
          ([request]) => request.name === "issue75-bootstrap-final-state",
        )?.[0];
        const preflightRequest = capturedBootstrap.client.query.mock.calls.find(
          ([request]) => request.name === "issue75-bootstrap-preflight",
        )?.[0];
        if (targetStateRequest === undefined) {
          throw new Error("target catalog query was not captured");
        }
        if (preflightRequest === undefined) {
          throw new Error("preflight catalog query was not captured");
        }
        const preflightResult = await adminClient.query({
          text: preflightRequest.text,
          values: ["issue75_probe_database", "issue75_probe_app"],
        });
        expect(preflightResult.rows[0]).toMatchObject({
          database_name: "postgres",
          user_name: "issue75_probe_admin",
          server_is_private: true,
          admin_is_azure_pg_admin: true,
          server_version_is_supported: postgresMajor === "16",
          scram_iterations_are_supported: true,
          createrole_self_grant_is_safe: true,
        });
        const targetStateResult = await adminClient.query({
          text: targetStateRequest.text,
          values: ["issue75_probe_database", "issue75_probe_app"],
        });
        const expectedCreatorEdge =
          postgresMajor === "16"
            ? {
                createrole_self_grant: "",
                target_role_creator_membership_count: "1",
                target_role_creator_admin_option: true,
                target_role_creator_inherit_option: false,
                target_role_creator_set_option: false,
              }
            : {
                createrole_self_grant: null,
                target_role_creator_membership_count: "0",
                target_role_creator_admin_option: null,
                target_role_creator_inherit_option: null,
                target_role_creator_set_option: null,
              };
        expect(targetStateResult.rows[0]).toMatchObject({
          target_database_owner: "issue75_probe_admin",
          target_database_target_privilege_count: "2",
          target_database_target_has_connect: true,
          target_database_target_has_create: true,
          target_database_target_has_temporary: false,
          target_role_parent_membership_count: "0",
          target_role_other_member_count: "0",
          ...expectedCreatorEdge,
        });

        applicationClient = new pg.Client({
          host: "127.0.0.1",
          port,
          database: "issue75_probe_database",
          user: "issue75_probe_app",
          password: applicationPassword,
        });
        await applicationClient.connect();
        const identity = await applicationClient.query(`
          SELECT
            current_user::text AS user_name,
            has_database_privilege(
              current_user,
              current_database(),
              'CONNECT'
            )::boolean AS can_connect,
            has_database_privilege(
              current_user,
              current_database(),
              'CREATE'
            )::boolean AS can_create,
            has_database_privilege(
              current_user,
              current_database(),
              'TEMPORARY'
            )::boolean AS can_create_temporary_objects
        `);
        expect(identity.rows).toEqual([
          {
            user_name: "issue75_probe_app",
            can_connect: true,
            can_create: true,
            can_create_temporary_objects: false,
          },
        ]);
        await applicationClient.query(
          "CREATE SCHEMA IF NOT EXISTS drizzle",
        );
        const drizzleOwner = await applicationClient.query(`
          SELECT pg_catalog.pg_get_userbyid(nspowner)::text AS owner_name
          FROM pg_catalog.pg_namespace
          WHERE nspname = 'drizzle'
        `);
        expect(drizzleOwner.rows).toEqual([
          { owner_name: "issue75_probe_app" },
        ]);
      } finally {
        await applicationClient?.end().catch(() => undefined);
        await schemaAdminClient?.end().catch(() => undefined);
        await adminClient?.end().catch(() => undefined);
        await rootClient?.end().catch(() => undefined);
        docker(["rm", "--force", containerName], true);
      }
    },
    90_000,
  );
}
