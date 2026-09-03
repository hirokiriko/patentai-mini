import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import pg from "pg";

import * as runnerModule from "./runner.mjs";

export const DB_OBSERVER_EXIT_CODES = Object.freeze({
  success: 0,
  internal: 1,
  config: 2,
  connect: 3,
  query: 4,
  state: 5,
  cleanup: 6,
});

const COMPONENT = "koho_db_observer";
const SCHEMA_VERSION = 1;
const CONNECT_TIMEOUT_MS = 15_000;
const QUERY_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const ALLOWED_MODES = Object.freeze([
  "preflight",
  "migrated",
  "snapshot",
  "package",
]);
const EXPECTED_APPLICATION_TABLES = Object.freeze([
  "public.case_watch_findings",
  "public.case_watch_runs",
  "public.case_watch_settings",
  "public.cases",
  "public.comparison_results",
  "public.draft_patents",
  "public.koho_import_documents",
  "public.koho_import_runs",
  "public.prior_art_documents",
  "public.search_query_sets",
]);
const EXPECTED_MIGRATION_MANIFEST = Object.freeze([
  Object.freeze({
    id: 1,
    index: 0,
    tag: "0000_loud_forge",
    createdAt: "1779317966922",
  }),
  Object.freeze({
    id: 2,
    index: 1,
    tag: "0001_regular_black_bolt",
    createdAt: "1787810352336",
  }),
  Object.freeze({
    id: 3,
    index: 2,
    tag: "0002_calm_red_ghost",
    createdAt: "1788308618345",
  }),
]);
const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../../drizzle/", import.meta.url),
);
const SCHEMA_SNAPSHOT_PATH = fileURLToPath(
  new URL("../../drizzle/meta/0002_snapshot.json", import.meta.url),
);

const SQL = Object.freeze({
  identity: `
    SELECT current_database()::text AS database_name
  `,
  applicationTables: `
    SELECT n.nspname::text AS schema_name, c.relname::text AS table_name
    FROM pg_catalog.pg_class AS c
    INNER JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND n.nspname NOT LIKE 'pg_temp_%'
      AND n.nspname NOT LIKE 'pg_toast_temp_%'
      AND NOT (
        n.nspname = 'drizzle' AND c.relname = '__drizzle_migrations'
      )
    ORDER BY n.nspname, c.relname
  `,
  migrationTable: `
    SELECT
      to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS journal_exists
  `,
  migrations: `
    SELECT id::text AS id, hash::text AS hash, created_at::text AS created_at
    FROM drizzle.__drizzle_migrations
    ORDER BY id ASC
  `,
  schemaColumns: `
    SELECT
      namespace.nspname::text AS schema_name,
      relation.relname::text AS table_name,
      attribute.attname::text AS column_name,
      attribute.attnum::integer AS ordinal_position,
      pg_catalog.format_type(
        attribute.atttypid,
        attribute.atttypmod
      )::text AS data_type,
      attribute.attnotnull AS not_null,
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_constraint AS primary_constraint
        WHERE primary_constraint.conrelid = relation.oid
          AND primary_constraint.contype = 'p'
          AND attribute.attnum = ANY(primary_constraint.conkey)
      ) AS primary_key,
      pg_catalog.pg_get_expr(
        column_default.adbin,
        column_default.adrelid,
        false
      )::text AS default_expression,
      attribute.attidentity::text AS identity_kind,
      attribute.attgenerated::text AS generated_kind
    FROM pg_catalog.pg_attribute AS attribute
    INNER JOIN pg_catalog.pg_class AS relation
      ON relation.oid = attribute.attrelid
    INNER JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    LEFT JOIN pg_catalog.pg_attrdef AS column_default
      ON column_default.adrelid = relation.oid
      AND column_default.adnum = attribute.attnum
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
    ORDER BY relation.relname, attribute.attnum
  `,
  schemaIndexes: `
    SELECT
      namespace.nspname::text AS schema_name,
      relation.relname::text AS table_name,
      index_relation.relname::text AS index_name,
      index_state.indisunique AS is_unique,
      access_method.amname::text AS method,
      ARRAY(
        SELECT index_attribute.attname::text
        FROM unnest(index_state.indkey::smallint[]) WITH ORDINALITY
          AS index_key(attribute_number, position)
        INNER JOIN pg_catalog.pg_attribute AS index_attribute
          ON index_attribute.attrelid = relation.oid
          AND index_attribute.attnum = index_key.attribute_number
        WHERE index_key.position <= index_state.indnkeyatts
        ORDER BY index_key.position
      ) AS key_columns,
      0 = ANY(index_state.indkey::smallint[]) AS has_expression,
      index_state.indnatts <> index_state.indnkeyatts
        AS has_included_columns,
      index_state.indoption::text AS index_options,
      pg_catalog.pg_get_expr(
        index_state.indpred,
        index_state.indrelid,
        false
      )::text AS predicate,
      index_state.indisvalid AS is_valid,
      index_state.indisready AS is_ready,
      index_state.indislive AS is_live,
      index_relation.reloptions AS storage_options
    FROM pg_catalog.pg_index AS index_state
    INNER JOIN pg_catalog.pg_class AS relation
      ON relation.oid = index_state.indrelid
    INNER JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    INNER JOIN pg_catalog.pg_class AS index_relation
      ON index_relation.oid = index_state.indexrelid
    INNER JOIN pg_catalog.pg_am AS access_method
      ON access_method.oid = index_relation.relam
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
      AND NOT index_state.indisprimary
    ORDER BY relation.relname, index_relation.relname
  `,
  schemaConstraints: `
    SELECT
      namespace.nspname::text AS schema_name,
      relation.relname::text AS table_name,
      constraint_state.conname::text AS constraint_name,
      constraint_state.contype::text AS constraint_type,
      ARRAY(
        SELECT constrained_attribute.attname::text
        FROM unnest(constraint_state.conkey) WITH ORDINALITY
          AS constrained_key(attribute_number, position)
        INNER JOIN pg_catalog.pg_attribute AS constrained_attribute
          ON constrained_attribute.attrelid = relation.oid
          AND constrained_attribute.attnum = constrained_key.attribute_number
        ORDER BY constrained_key.position
      ) AS constrained_columns,
      referenced_namespace.nspname::text AS referenced_schema,
      referenced_relation.relname::text AS referenced_table,
      CASE WHEN constraint_state.confrelid = 0 THEN ARRAY[]::text[] ELSE ARRAY(
        SELECT referenced_attribute.attname::text
        FROM unnest(constraint_state.confkey) WITH ORDINALITY
          AS referenced_key(attribute_number, position)
        INNER JOIN pg_catalog.pg_attribute AS referenced_attribute
          ON referenced_attribute.attrelid = constraint_state.confrelid
          AND referenced_attribute.attnum = referenced_key.attribute_number
        ORDER BY referenced_key.position
      ) END AS referenced_columns,
      constraint_state.confupdtype::text AS update_action,
      constraint_state.confdeltype::text AS delete_action,
      constraint_state.confmatchtype::text AS match_type,
      constraint_state.condeferrable AS is_deferrable,
      constraint_state.condeferred AS is_deferred,
      constraint_state.convalidated AS is_validated,
      constraint_state.connoinherit AS is_no_inherit,
      pg_catalog.pg_get_expr(
        constraint_state.conbin,
        constraint_state.conrelid,
        false
      )::text AS check_expression
    FROM pg_catalog.pg_constraint AS constraint_state
    INNER JOIN pg_catalog.pg_class AS relation
      ON relation.oid = constraint_state.conrelid
    INNER JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    LEFT JOIN pg_catalog.pg_class AS referenced_relation
      ON referenced_relation.oid = constraint_state.confrelid
    LEFT JOIN pg_catalog.pg_namespace AS referenced_namespace
      ON referenced_namespace.oid = referenced_relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
      AND constraint_state.contype IN ('p', 'u', 'f', 'c', 'x')
    ORDER BY relation.relname, constraint_state.conname
  `,
  storageMetrics: `
    WITH user_tables AS (
      SELECT c.oid
      FROM pg_catalog.pg_class AS c
      INNER JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        AND n.nspname NOT LIKE 'pg_temp_%'
        AND n.nspname NOT LIKE 'pg_toast_temp_%'
        AND NOT (
          n.nspname = 'drizzle' AND c.relname = '__drizzle_migrations'
        )
    )
    SELECT
      pg_database_size(current_database())::bigint::text AS database_bytes,
      COALESCE(SUM(pg_table_size(oid)), 0)::bigint::text AS user_table_bytes,
      COALESCE(SUM(pg_indexes_size(oid)), 0)::bigint::text AS index_bytes,
      pg_table_size('public.koho_import_runs'::regclass)::bigint::text
        AS koho_import_runs_table_bytes,
      pg_indexes_size('public.koho_import_runs'::regclass)::bigint::text
        AS koho_import_runs_index_bytes,
      pg_table_size('public.koho_import_documents'::regclass)::bigint::text
        AS koho_import_documents_table_bytes,
      pg_indexes_size('public.koho_import_documents'::regclass)::bigint::text
        AS koho_import_documents_index_bytes,
      FLOOR(
        pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')
      )::bigint::text AS wal_position_bytes,
      COALESCE((
        SELECT temp_bytes
        FROM pg_catalog.pg_stat_database
        WHERE datname = current_database()
      ), 0)::bigint::text AS temp_bytes
    FROM user_tables
  `,
  importMetrics: `
    SELECT
      COUNT(*)::bigint::text AS import_run_count,
      COALESCE(SUM(document_count), 0)::bigint::text AS reported_document_count,
      COALESCE(SUM(amendment_count), 0)::bigint::text AS amendment_count,
      COALESCE(SUM(nested_st26_count), 0)::bigint::text AS nested_st26_count,
      (
        SELECT COUNT(*) FROM public.koho_import_documents
      )::bigint::text AS import_document_count
    FROM public.koho_import_runs
  `,
  activityMetrics: `
    WITH other_sessions AS (
      SELECT state, wait_event_type
      FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
    ),
    other_locks AS (
      SELECT locks.granted
      FROM pg_catalog.pg_locks AS locks
      INNER JOIN pg_catalog.pg_stat_activity AS activity
        ON activity.pid = locks.pid
      WHERE activity.datname = current_database()
        AND locks.pid <> pg_backend_pid()
    )
    SELECT
      (SELECT COUNT(*) FROM other_sessions)::bigint::text
        AS other_session_count,
      (SELECT COUNT(*) FROM other_sessions WHERE state = 'active')::bigint::text
        AS other_active_session_count,
      (
        SELECT COUNT(*) FROM other_sessions WHERE wait_event_type IS NOT NULL
      )::bigint::text AS other_waiting_session_count,
      (SELECT COUNT(*) FROM other_locks)::bigint::text AS other_lock_count,
      (SELECT COUNT(*) FROM other_locks WHERE NOT granted)::bigint::text
        AS other_waiting_lock_count
  `,
  packageState: `
    SELECT
      COUNT(DISTINCT runs.import_id)::bigint::text AS matching_run_count,
      MIN(runs.package_type)::text AS package_type,
      MIN(runs.package_status)::text AS package_status,
      MIN(runs.document_count)::bigint::text AS declared_document_count,
      MIN(runs.amendment_count)::bigint::text AS amendment_count,
      MIN(runs.nested_st26_count)::bigint::text AS nested_st26_count,
      COUNT(documents.document_id)::bigint::text AS stored_document_count
    FROM public.koho_import_runs AS runs
    LEFT JOIN public.koho_import_documents AS documents
      ON documents.import_id = runs.import_id
    WHERE runs.source_sha256 = $1
  `,
});

class ObserverFailure extends Error {
  constructor(kind, reason) {
    super(reason);
    this.name = "ObserverFailure";
    this.kind = kind;
    this.reason = reason;
  }
}

function failure(kind, reason) {
  return new ObserverFailure(kind, reason);
}

function safeMode(mode) {
  return ALLOWED_MODES.includes(mode) ? mode : "unknown";
}

function baseLog(mode, status, result, reason) {
  return {
    component: COMPONENT,
    schemaVersion: SCHEMA_VERSION,
    mode: safeMode(mode),
    status,
    result,
    reason,
  };
}

function failedOutcome(mode, observerFailure) {
  const normalized =
    observerFailure instanceof ObserverFailure
      ? observerFailure
      : failure("internal", "internal_error");
  return {
    exitCode: DB_OBSERVER_EXIT_CODES[normalized.kind],
    log: baseLog(mode, "failed", "unknown", normalized.reason),
  };
}

function resolvedTimeout(promise, timeoutMilliseconds, timeoutFailure) {
  let timer;
  const timeout = new Promise((_, rejectPromise) => {
    timer = setTimeout(() => rejectPromise(timeoutFailure), timeoutMilliseconds);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    clearTimeout(timer);
  });
}

function parseSafeInteger(value) {
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return value;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw failure("state", "invalid_metric_state");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw failure("state", "invalid_metric_state");
  }
  return parsed;
}

function oneRow(result) {
  if (!result || !Array.isArray(result.rows) || result.rows.length !== 1) {
    throw failure("state", "unexpected_database_state");
  }
  return result.rows[0];
}

function resultRows(result) {
  if (!result || !Array.isArray(result.rows)) {
    throw failure("state", "unexpected_database_state");
  }
  return result.rows;
}

async function safeQuery(client, name, text, values = []) {
  try {
    return await resolvedTimeout(
      client.query({ name, text, values, query_timeout: QUERY_TIMEOUT_MS }),
      QUERY_TIMEOUT_MS,
      failure("query", "query_timed_out"),
    );
  } catch (error) {
    if (error instanceof ObserverFailure) throw error;
    throw failure("query", "query_failed");
  }
}

function validateActualDatabase(row, expectedName) {
  if (
    typeof row?.database_name !== "string" ||
    row.database_name !== expectedName ||
    row.database_name.toLowerCase() === "patentai"
  ) {
    throw failure("state", "database_identity_mismatch");
  }
}

async function readApplicationTables(client) {
  const rows = resultRows(
    await safeQuery(
      client,
      "issue75-observer-application-tables",
      SQL.applicationTables,
    ),
  );
  return rows
    .map((row) => {
      if (
        typeof row?.schema_name !== "string" ||
        typeof row?.table_name !== "string"
      ) {
        throw failure("state", "unexpected_database_state");
      }
      return `${row.schema_name}.${row.table_name}`;
    })
    .sort();
}

async function readMigrationRows(client) {
  const existence = oneRow(
    await safeQuery(
      client,
      "issue75-observer-migration-table",
      SQL.migrationTable,
    ),
  );
  if (typeof existence?.journal_exists !== "boolean") {
    throw failure("state", "unexpected_database_state");
  }
  if (!existence.journal_exists) return null;
  return resultRows(
    await safeQuery(client, "issue75-observer-migrations", SQL.migrations),
  );
}

function validatePreflightState(applicationTables, migrationRows) {
  if (applicationTables.length !== 0 || migrationRows !== null) {
    throw failure("state", "database_not_empty");
  }
  return {
    applicationTableCount: 0,
    migrationCount: 0,
  };
}

function validateExpectedTables(applicationTables) {
  if (
    applicationTables.length !== EXPECTED_APPLICATION_TABLES.length ||
    applicationTables.some(
      (tableName, index) => tableName !== EXPECTED_APPLICATION_TABLES[index],
    )
  ) {
    throw failure("state", "migration_state_mismatch");
  }
}

function validateMigrationRows(rows, expectedMigrations) {
  if (
    rows === null ||
    !Array.isArray(expectedMigrations) ||
    rows.length !== expectedMigrations.length ||
    expectedMigrations.length !== EXPECTED_MIGRATION_MANIFEST.length
  ) {
    throw failure("state", "migration_state_mismatch");
  }

  for (let index = 0; index < expectedMigrations.length; index += 1) {
    const actual = rows[index];
    const expected = expectedMigrations[index];
    if (
      !expected ||
      !Number.isSafeInteger(expected.id) ||
      typeof expected.hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(expected.hash) ||
      typeof expected.createdAt !== "string" ||
      !/^\d+$/.test(expected.createdAt) ||
      actual?.id !== String(expected.id) ||
      typeof actual?.hash !== "string" ||
      actual.hash !== expected.hash ||
      actual?.created_at !== expected.createdAt
    ) {
      throw failure("state", "migration_state_mismatch");
    }
  }
}

function validateManifestJournal(journal) {
  if (
    !journal ||
    journal.version !== "7" ||
    journal.dialect !== "postgresql" ||
    !Array.isArray(journal.entries) ||
    journal.entries.length !== EXPECTED_MIGRATION_MANIFEST.length
  ) {
    throw failure("state", "migration_manifest_mismatch");
  }

  for (let index = 0; index < EXPECTED_MIGRATION_MANIFEST.length; index += 1) {
    const actual = journal.entries[index];
    const expected = EXPECTED_MIGRATION_MANIFEST[index];
    if (
      actual?.idx !== expected.index ||
      actual?.version !== "7" ||
      actual?.tag !== expected.tag ||
      actual?.when !== Number(expected.createdAt) ||
      actual?.breakpoints !== true
    ) {
      throw failure("state", "migration_manifest_mismatch");
    }
  }
}

export async function loadExpectedMigrations(
  migrationDirectory = MIGRATION_DIRECTORY,
) {
  try {
    const journalText = await readFile(
      resolve(migrationDirectory, "meta", "_journal.json"),
      "utf8",
    );
    const journal = JSON.parse(journalText);
    validateManifestJournal(journal);

    return await Promise.all(
      EXPECTED_MIGRATION_MANIFEST.map(async (entry) => {
        const sqlText = await readFile(
          resolve(migrationDirectory, `${entry.tag}.sql`),
          "utf8",
        );
        return Object.freeze({
          id: entry.id,
          createdAt: entry.createdAt,
          hash: createHash("sha256").update(sqlText).digest("hex"),
        });
      }),
    );
  } catch (error) {
    if (error instanceof ObserverFailure) throw error;
    throw failure("state", "migration_manifest_unavailable");
  }
}

function schemaMismatch() {
  return failure("state", "schema_state_mismatch");
}

function requireString(value) {
  if (typeof value !== "string") throw schemaMismatch();
  return value;
}

function requireBoolean(value) {
  if (typeof value !== "boolean") throw schemaMismatch();
  return value;
}

function requireStringArray(value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw schemaMismatch();
  }
  return [...value];
}

function normalizeDefaultExpression(expression) {
  if (expression === null || expression === undefined) return null;
  return requireString(expression)
    .replace(
      /::(?:text|boolean|integer|real|double precision|timestamp with time zone)\b/gi,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDatabaseColumnDefault(row) {
  const expression = row.default_expression;
  if (expression === null) return null;
  const normalized = normalizeDefaultExpression(expression);
  const serialMatch = /^nextval\('([^']+)'::regclass\)$/.exec(
    requireString(expression),
  );
  if (serialMatch !== null) {
    const sequence = serialMatch[1]
      .replace(/^public\./, "")
      .replaceAll('"', "");
    return `serial:${sequence}`;
  }
  return normalized;
}

function normalizeExpectedColumnDefault(tableName, column) {
  if (column.type === "serial") {
    return `serial:${tableName}_${column.name}_seq`;
  }
  if (column.default === undefined) return null;
  return normalizeDefaultExpression(String(column.default));
}

function normalizeCheckExpression(expression, tableName) {
  let normalized = requireString(expression)
    .toLowerCase()
    .replaceAll('"', "")
    .replaceAll(`${tableName.toLowerCase()}.`, "")
    .replace(
      /::(?:text|boolean|integer|real|double precision|timestamp with time zone)\b/g,
      "",
    );
  normalized = normalized.replace(
    /\b([a-z_][a-z0-9_]*)\s*=\s*any\s*\(\s*array\s*\[([^\]]*)\]\s*\)/g,
    "$1 in ($2)",
  );
  normalized = normalized.replace(
    /\b([a-z_][a-z0-9_]*)\s+between\s+([^\s()]+)\s+and\s+([^\s()]+)/g,
    "($1 >= $2 and $1 <= $3)",
  );
  return normalized.replace(/[\s()]/g, "");
}

function fingerprintDescriptors(descriptors) {
  const lines = descriptors.map((value) => JSON.stringify(value)).sort();
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

function expectedColumnDescriptors(tables) {
  const descriptors = [];
  for (const table of tables) {
    if (!table || typeof table !== "object" || !table.columns) {
      throw schemaMismatch();
    }
    const columns = Object.values(table.columns);
    columns.forEach((column, index) => {
      if (
        !column ||
        typeof column !== "object" ||
        typeof column.name !== "string" ||
        typeof column.type !== "string" ||
        typeof column.notNull !== "boolean" ||
        typeof column.primaryKey !== "boolean"
      ) {
        throw schemaMismatch();
      }
      descriptors.push([
        "column",
        "public",
        table.name,
        column.name,
        index + 1,
        column.type === "serial" ? "integer" : column.type,
        column.notNull,
        column.primaryKey,
        normalizeExpectedColumnDefault(table.name, column),
        "",
        "",
      ]);
    });
  }
  return descriptors;
}

function expectedIndexDescriptors(tables) {
  const descriptors = [];
  for (const table of tables) {
    const indexes = Object.values(table.indexes ?? {});
    for (const index of indexes) {
      if (
        !index ||
        typeof index !== "object" ||
        typeof index.name !== "string" ||
        typeof index.isUnique !== "boolean" ||
        typeof index.method !== "string" ||
        !Array.isArray(index.columns) ||
        !index.columns.every(
          (column) =>
            column &&
            typeof column === "object" &&
            typeof column.expression === "string" &&
            column.isExpression === false &&
            column.asc === true &&
            column.nulls === "last",
        ) ||
        Object.keys(index.with ?? {}).length !== 0
      ) {
        throw schemaMismatch();
      }
      descriptors.push([
        "index",
        "public",
        table.name,
        index.name,
        index.isUnique,
        index.method,
        index.columns.map((column) => column.expression),
        false,
        false,
        index.columns.map(() => 0),
        null,
        true,
        true,
        true,
        [],
      ]);
    }
  }
  return descriptors;
}

const FOREIGN_KEY_ACTION_CODES = Object.freeze({
  "no action": "a",
  restrict: "r",
  cascade: "c",
  "set null": "n",
  "set default": "d",
});

function expectedConstraintDescriptors(tables) {
  const descriptors = [];
  for (const table of tables) {
    const columns = Object.values(table.columns);
    const primaryColumns = columns
      .filter((column) => column.primaryKey)
      .map((column) => column.name);
    if (primaryColumns.length > 0) {
      descriptors.push([
        "constraint",
        "public",
        table.name,
        `${table.name}_pkey`,
        "p",
        primaryColumns,
        false,
        false,
        true,
      ]);
    }

    for (const constraint of Object.values(table.uniqueConstraints ?? {})) {
      if (
        !constraint ||
        typeof constraint.name !== "string" ||
        !Array.isArray(constraint.columns)
      ) {
        throw schemaMismatch();
      }
      descriptors.push([
        "constraint",
        "public",
        table.name,
        constraint.name,
        "u",
        requireStringArray(constraint.columns),
        false,
        false,
        true,
      ]);
    }

    for (const constraint of Object.values(table.foreignKeys ?? {})) {
      if (
        !constraint ||
        typeof constraint.name !== "string" ||
        typeof constraint.tableTo !== "string" ||
        !Array.isArray(constraint.columnsFrom) ||
        !Array.isArray(constraint.columnsTo) ||
        !Object.hasOwn(FOREIGN_KEY_ACTION_CODES, constraint.onUpdate) ||
        !Object.hasOwn(FOREIGN_KEY_ACTION_CODES, constraint.onDelete)
      ) {
        throw schemaMismatch();
      }
      descriptors.push([
        "constraint",
        "public",
        table.name,
        constraint.name,
        "f",
        requireStringArray(constraint.columnsFrom),
        "public",
        constraint.tableTo,
        requireStringArray(constraint.columnsTo),
        FOREIGN_KEY_ACTION_CODES[constraint.onUpdate],
        FOREIGN_KEY_ACTION_CODES[constraint.onDelete],
        "s",
        false,
        false,
        true,
      ]);
    }

    for (const constraint of Object.values(table.checkConstraints ?? {})) {
      if (
        !constraint ||
        typeof constraint.name !== "string" ||
        typeof constraint.value !== "string"
      ) {
        throw schemaMismatch();
      }
      descriptors.push([
        "constraint",
        "public",
        table.name,
        constraint.name,
        "c",
        normalizeCheckExpression(constraint.value, table.name),
        true,
        false,
      ]);
    }
  }
  return descriptors;
}

function expectedSchemaFingerprint(snapshot) {
  if (
    !snapshot ||
    snapshot.version !== "7" ||
    snapshot.dialect !== "postgresql" ||
    !snapshot.tables ||
    typeof snapshot.tables !== "object"
  ) {
    throw schemaMismatch();
  }
  const tableKeys = Object.keys(snapshot.tables).sort();
  if (
    tableKeys.length !== EXPECTED_APPLICATION_TABLES.length ||
    tableKeys.some(
      (tableName, index) => tableName !== EXPECTED_APPLICATION_TABLES[index],
    )
  ) {
    throw schemaMismatch();
  }
  const tables = tableKeys.map((tableKey) => snapshot.tables[tableKey]);
  if (
    tables.some(
      (table, index) =>
        !table ||
        table.name !== tableKeys[index].slice("public.".length) ||
        (table.schema !== "" && table.schema !== "public"),
    )
  ) {
    throw schemaMismatch();
  }
  return fingerprintDescriptors([
    ...expectedColumnDescriptors(tables),
    ...expectedIndexDescriptors(tables),
    ...expectedConstraintDescriptors(tables),
  ]);
}

export async function loadExpectedSchemaFingerprint(
  snapshotPath = SCHEMA_SNAPSHOT_PATH,
) {
  try {
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
    return expectedSchemaFingerprint(snapshot);
  } catch (error) {
    if (error instanceof ObserverFailure) throw error;
    throw failure("state", "schema_manifest_unavailable");
  }
}

function parseIndexOptions(value, expectedLength) {
  const raw = requireString(value).trim();
  const options = raw === "" ? [] : raw.split(/\s+/).map(Number);
  if (
    options.length !== expectedLength ||
    options.some((option) => !Number.isSafeInteger(option) || option < 0)
  ) {
    throw schemaMismatch();
  }
  return options;
}

function databaseColumnDescriptors(rows) {
  return rows.map((row) => [
    "column",
    requireString(row?.schema_name),
    requireString(row?.table_name),
    requireString(row?.column_name),
    parseSafeInteger(row?.ordinal_position),
    requireString(row?.data_type),
    requireBoolean(row?.not_null),
    requireBoolean(row?.primary_key),
    normalizeDatabaseColumnDefault(row),
    requireString(row?.identity_kind),
    requireString(row?.generated_kind),
  ]);
}

function databaseIndexDescriptors(rows) {
  return rows.map((row) => {
    const columns = requireStringArray(row?.key_columns);
    const storageOptions =
      row?.storage_options === null
        ? []
        : requireStringArray(row?.storage_options).sort();
    return [
      "index",
      requireString(row?.schema_name),
      requireString(row?.table_name),
      requireString(row?.index_name),
      requireBoolean(row?.is_unique),
      requireString(row?.method),
      columns,
      requireBoolean(row?.has_expression),
      requireBoolean(row?.has_included_columns),
      parseIndexOptions(row?.index_options, columns.length),
      row?.predicate === null
        ? null
        : normalizeDefaultExpression(row?.predicate),
      requireBoolean(row?.is_valid),
      requireBoolean(row?.is_ready),
      requireBoolean(row?.is_live),
      storageOptions,
    ];
  });
}

function databaseConstraintDescriptor(row) {
  const type = requireString(row?.constraint_type);
  const common = [
    "constraint",
    requireString(row?.schema_name),
    requireString(row?.table_name),
    requireString(row?.constraint_name),
    type,
  ];
  if (type === "p" || type === "u") {
    return [
      ...common,
      requireStringArray(row?.constrained_columns),
      requireBoolean(row?.is_deferrable),
      requireBoolean(row?.is_deferred),
      requireBoolean(row?.is_validated),
    ];
  }
  if (type === "f") {
    return [
      ...common,
      requireStringArray(row?.constrained_columns),
      requireString(row?.referenced_schema),
      requireString(row?.referenced_table),
      requireStringArray(row?.referenced_columns),
      requireString(row?.update_action),
      requireString(row?.delete_action),
      requireString(row?.match_type),
      requireBoolean(row?.is_deferrable),
      requireBoolean(row?.is_deferred),
      requireBoolean(row?.is_validated),
    ];
  }
  if (type === "c") {
    return [
      ...common,
      normalizeCheckExpression(
        row?.check_expression,
        requireString(row?.table_name),
      ),
      requireBoolean(row?.is_validated),
      requireBoolean(row?.is_no_inherit),
    ];
  }
  return [
    ...common,
    requireStringArray(row?.constrained_columns),
    requireBoolean(row?.is_validated),
  ];
}

export function fingerprintDatabaseSchema(rows) {
  try {
    if (
      !rows ||
      !Array.isArray(rows.columns) ||
      !Array.isArray(rows.indexes) ||
      !Array.isArray(rows.constraints)
    ) {
      throw schemaMismatch();
    }
    return fingerprintDescriptors([
      ...databaseColumnDescriptors(rows.columns),
      ...databaseIndexDescriptors(rows.indexes),
      ...rows.constraints.map(databaseConstraintDescriptor),
    ]);
  } catch {
    throw schemaMismatch();
  }
}

export async function readDatabaseSchemaFingerprint(client) {
  const columns = resultRows(
    await safeQuery(
      client,
      "issue75-observer-schema-columns",
      SQL.schemaColumns,
    ),
  );
  const indexes = resultRows(
    await safeQuery(
      client,
      "issue75-observer-schema-indexes",
      SQL.schemaIndexes,
    ),
  );
  const constraints = resultRows(
    await safeQuery(
      client,
      "issue75-observer-schema-constraints",
      SQL.schemaConstraints,
    ),
  );
  return fingerprintDatabaseSchema({ columns, indexes, constraints });
}

async function validateMigratedState(
  client,
  applicationTables,
  migrationRows,
  loadMigrations,
  loadSchemaFingerprint,
  readSchemaFingerprint,
) {
  validateExpectedTables(applicationTables);
  let expectedMigrations;
  try {
    expectedMigrations = await loadMigrations();
  } catch (error) {
    if (error instanceof ObserverFailure) throw error;
    throw failure("state", "migration_manifest_unavailable");
  }
  validateMigrationRows(migrationRows, expectedMigrations);

  let expectedFingerprint;
  try {
    expectedFingerprint = await loadSchemaFingerprint();
  } catch (error) {
    if (error instanceof ObserverFailure) throw error;
    throw failure("state", "schema_manifest_unavailable");
  }
  const actualFingerprint = await readSchemaFingerprint(client);
  if (
    typeof expectedFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(expectedFingerprint) ||
    typeof actualFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(actualFingerprint) ||
    actualFingerprint !== expectedFingerprint
  ) {
    throw schemaMismatch();
  }
  return {
    applicationTableCount: applicationTables.length,
    migrationCount: migrationRows.length,
  };
}

function parseMetricRow(row, fields) {
  return Object.fromEntries(
    fields.map(([outputName, databaseName]) => [
      outputName,
      parseSafeInteger(row?.[databaseName]),
    ]),
  );
}

async function readSnapshot(client) {
  const storage = oneRow(
    await safeQuery(
      client,
      "issue75-observer-storage-metrics",
      SQL.storageMetrics,
    ),
  );
  const imports = oneRow(
    await safeQuery(
      client,
      "issue75-observer-import-metrics",
      SQL.importMetrics,
    ),
  );
  const activity = oneRow(
    await safeQuery(
      client,
      "issue75-observer-activity-metrics",
      SQL.activityMetrics,
    ),
  );

  return {
    ...parseMetricRow(storage, [
      ["databaseBytes", "database_bytes"],
      ["userTableBytes", "user_table_bytes"],
      ["indexBytes", "index_bytes"],
      ["kohoImportRunsTableBytes", "koho_import_runs_table_bytes"],
      ["kohoImportRunsIndexBytes", "koho_import_runs_index_bytes"],
      [
        "kohoImportDocumentsTableBytes",
        "koho_import_documents_table_bytes",
      ],
      [
        "kohoImportDocumentsIndexBytes",
        "koho_import_documents_index_bytes",
      ],
      ["walPositionBytes", "wal_position_bytes"],
      ["tempBytes", "temp_bytes"],
    ]),
    ...parseMetricRow(imports, [
      ["importRunCount", "import_run_count"],
      ["importDocumentCount", "import_document_count"],
      ["reportedDocumentCount", "reported_document_count"],
      ["amendmentCount", "amendment_count"],
      ["nestedSt26Count", "nested_st26_count"],
    ]),
    ...parseMetricRow(activity, [
      ["otherSessionCount", "other_session_count"],
      ["otherActiveSessionCount", "other_active_session_count"],
      ["otherWaitingSessionCount", "other_waiting_session_count"],
      ["otherLockCount", "other_lock_count"],
      ["otherWaitingLockCount", "other_waiting_lock_count"],
    ]),
  };
}

function parsePackageMetric(value) {
  try {
    return parseSafeInteger(value);
  } catch {
    throw failure("state", "package_state_mismatch");
  }
}

async function readPackageState(client, config) {
  const row = oneRow(
    await safeQuery(
      client,
      "issue75-observer-package-state",
      SQL.packageState,
      [config.expectedSourceSha256],
    ),
  );
  const matchingRunCount = parsePackageMetric(row?.matching_run_count);
  const declaredDocumentCount = parsePackageMetric(
    row?.declared_document_count,
  );
  const storedDocumentCount = parsePackageMetric(row?.stored_document_count);
  const amendmentCount = parsePackageMetric(row?.amendment_count);
  const nestedSt26Count = parsePackageMetric(row?.nested_st26_count);

  if (
    matchingRunCount !== 1 ||
    row?.package_type !== config.packageType ||
    (row?.package_status !== "success" &&
      row?.package_status !== "review_required") ||
    declaredDocumentCount !== config.expectedDocumentCount ||
    storedDocumentCount !== config.expectedDocumentCount
  ) {
    throw failure("state", "package_state_mismatch");
  }

  return {
    matchingRunCount,
    packageType: row.package_type,
    packageStatus: row.package_status,
    expectedDocumentCount: config.expectedDocumentCount,
    declaredDocumentCount,
    storedDocumentCount,
    amendmentCount,
    nestedSt26Count,
  };
}

export function readObserverConfig(
  mode,
  environment = process.env,
  readDatabaseIdentity = runnerModule.parseDatabaseIdentity,
) {
  if (!ALLOWED_MODES.includes(mode) || typeof readDatabaseIdentity !== "function") {
    throw failure("config", "invalid_config");
  }

  let databaseUrl;
  try {
    databaseUrl = readDatabaseIdentity(environment);
  } catch {
    throw failure("config", "invalid_config");
  }

  return Object.freeze({
    mode,
    databaseUrl,
    expectedDatabaseName: environment.KOHO_JOB_EXPECTED_DATABASE_NAME,
    ...(mode === "package"
      ? readPackageObserverConfig(environment)
      : {}),
  });
}

function readPackageObserverConfig(environment) {
  const packageType = environment.KOHO_JOB_PACKAGE_TYPE;
  const sourceSha256 = environment.KOHO_JOB_EXPECTED_SOURCE_SHA256;
  const documentCount = environment.KOHO_JOB_EXPECTED_DOCUMENT_COUNT;
  if (
    (packageType !== "JPA" && packageType !== "JPB") ||
    typeof sourceSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(sourceSha256) ||
    typeof documentCount !== "string" ||
    !/^[1-9]\d*$/.test(documentCount)
  ) {
    throw failure("config", "invalid_config");
  }
  const expectedDocumentCount = Number(documentCount);
  if (
    !Number.isSafeInteger(expectedDocumentCount) ||
    expectedDocumentCount > 10_000_000
  ) {
    throw failure("config", "invalid_config");
  }
  return {
    packageType,
    expectedSourceSha256: sourceSha256,
    expectedDocumentCount,
  };
}

export function createObserverClient(databaseUrl, Client = pg.Client) {
  const connectionUrl = new URL(databaseUrl);
  // pg 8 already treats these modes as verify-full. Normalizing explicitly
  // keeps certificate verification strict and suppresses its stderr warning.
  connectionUrl.searchParams.set("sslmode", "verify-full");
  return new Client({
    connectionString: connectionUrl.toString(),
    application_name: "issue75_db_observer",
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
    lock_timeout: QUERY_TIMEOUT_MS,
    keepAlive: true,
  });
}

export async function runDatabaseObserver(options = {}) {
  const mode = options.mode;
  const dependencies = {
    createClient: createObserverClient,
    loadExpectedMigrations,
    loadExpectedSchemaFingerprint,
    readDatabaseSchemaFingerprint,
    readDatabaseIdentity: runnerModule.parseDatabaseIdentity,
    ...options.dependencies,
  };

  let config;
  try {
    config = readObserverConfig(
      mode,
      options.environment ?? process.env,
      dependencies.readDatabaseIdentity,
    );
  } catch (error) {
    return failedOutcome(mode, error);
  }

  let client;
  let observerFailure = null;
  let successMetrics = null;
  let idleClientErrorObserved = false;
  let cleanupCompleted = false;
  const onIdleError = () => {
    idleClientErrorObserved = true;
  };

  try {
    try {
      client = dependencies.createClient(config.databaseUrl);
      client.on?.("error", onIdleError);
      await resolvedTimeout(
        client.connect(),
        CONNECT_TIMEOUT_MS,
        failure("connect", "connect_timed_out"),
      );
    } catch (error) {
      if (error instanceof ObserverFailure) throw error;
      throw failure("connect", "connect_failed");
    }

    const identity = oneRow(
      await safeQuery(client, "issue75-observer-identity", SQL.identity),
    );
    validateActualDatabase(identity, config.expectedDatabaseName);

    const applicationTables = await readApplicationTables(client);
    const migrationRows = await readMigrationRows(client);

    if (config.mode === "preflight") {
      successMetrics = validatePreflightState(
        applicationTables,
        migrationRows,
      );
    } else {
      successMetrics = await validateMigratedState(
        client,
        applicationTables,
        migrationRows,
        dependencies.loadExpectedMigrations,
        dependencies.loadExpectedSchemaFingerprint,
        dependencies.readDatabaseSchemaFingerprint,
      );
      if (config.mode === "snapshot") {
        successMetrics = {
          ...successMetrics,
          ...(await readSnapshot(client)),
        };
      } else if (config.mode === "package") {
        successMetrics = {
          ...successMetrics,
          ...(await readPackageState(client, config)),
        };
      }
    }
  } catch (error) {
    observerFailure =
      error instanceof ObserverFailure
        ? error
        : failure("internal", "internal_error");
  } finally {
    if (client !== undefined) {
      try {
        await resolvedTimeout(
          client.end(),
          CLEANUP_TIMEOUT_MS,
          failure("cleanup", "cleanup_timed_out"),
        );
        cleanupCompleted = true;
      } catch (error) {
        observerFailure =
          error instanceof ObserverFailure
            ? error
            : failure("cleanup", "cleanup_failed");
      }
      if (cleanupCompleted) {
        client.removeListener?.("error", onIdleError);
      }
    }
  }

  if (observerFailure === null && idleClientErrorObserved) {
    observerFailure = failure("query", "idle_client_error");
  }

  if (observerFailure !== null) {
    return failedOutcome(mode, observerFailure);
  }

  return {
    exitCode: DB_OBSERVER_EXIT_CODES.success,
    log: {
      ...baseLog(mode, "succeeded", "confirmed", null),
      ...successMetrics,
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const mode = argv.length === 1 ? argv[0] : "unknown";
  let outcome;
  try {
    outcome = await runDatabaseObserver({ mode });
  } catch {
    outcome = failedOutcome(mode, failure("internal", "internal_error"));
  }
  await new Promise((resolvePromise) => {
    process.stdout.write(`${JSON.stringify(outcome.log)}\n`, resolvePromise);
  });
  process.exit(outcome.exitCode);
}

const entryPath = process.argv[1];
if (
  typeof entryPath === "string" &&
  import.meta.url === pathToFileURL(resolve(entryPath)).href
) {
  await main();
}
