import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

export const DB_BOOTSTRAP_EXIT_CODES = Object.freeze({
  success: 0,
  internal: 1,
  config: 2,
  connect: 3,
  state: 4,
  create: 5,
  verify: 6,
  cleanup: 7,
});

const COMPONENT = "koho_db_bootstrap";
const SCHEMA_VERSION = 1;
const REQUIRED_DATABASE_SCOPE = "issue-75-dedicated-staging";
const CONNECT_TIMEOUT_MS = 15_000;
const QUERY_TIMEOUT_MS = 30_000;
const LOCK_TIMEOUT_MS = 5_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const ADVISORY_LOCK_KEY = 7_500_075;
const ROLE_CONNECTION_LIMIT = 4;
const DATABASE_CONNECTION_LIMIT = 4;
const SCRAM_ITERATIONS = 4_096;
const SCRAM_KEY_LENGTH = 32;
const SCRAM_SALT_LENGTH = 16;
const TARGET_IDENTIFIER =
  /^issue75_[a-z0-9](?:[a-z0-9_]{0,53}[a-z0-9])?$/;
const ADMIN_IDENTIFIER = /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/;
const AZURE_POSTGRES_HOST =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.postgres\.database\.azure\.com(?::5432)?$/;
const PRODUCTION_CANDIDATE =
  /(?:patentai|production|prod|postgres|template|azure[_-])/;
const STRONG_ASCII_PASSWORD =
  /^(?=.{24,128}$)(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9])[!-~]+$/;

const SQL = Object.freeze({
  advisoryLock: `
    SELECT pg_try_advisory_lock($1)::boolean AS lock_acquired
  `,
  preflight: `
    WITH admin_role_state AS (
      SELECT
        rolname,
        rolcanlogin,
        rolcreatedb,
        rolcreaterole,
        rolsuper,
        rolreplication,
        rolbypassrls
      FROM pg_catalog.pg_roles
      WHERE rolname = current_user
    )
    SELECT
      current_database()::text AS database_name,
      current_user::text AS user_name,
      (
        inet_server_addr() << inet '10.0.0.0/8'
        OR inet_server_addr() << inet '172.16.0.0/12'
        OR inet_server_addr() << inet '192.168.0.0/16'
      )::boolean AS server_is_private,
      admin_role_state.rolcanlogin AS admin_can_login,
      admin_role_state.rolcreatedb AS admin_can_create_database,
      admin_role_state.rolcreaterole AS admin_can_create_role,
      admin_role_state.rolsuper AS admin_is_superuser,
      admin_role_state.rolreplication AS admin_can_replicate,
      admin_role_state.rolbypassrls AS admin_can_bypass_rls,
      (
        current_setting('password_encryption') = 'scram-sha-256'
      )::boolean AS password_encryption_is_scram_sha_256,
      (
        current_setting('log_parameter_max_length')::integer = 0
      )::boolean AS parameter_logging_is_disabled,
      (
        current_setting('log_parameter_max_length_on_error')::integer = 0
      )::boolean AS error_parameter_logging_is_disabled,
      (
        current_setting('log_statement') = 'none'
      )::boolean AS statement_logging_is_disabled,
      (
        current_setting('log_min_duration_statement') = '-1'
      )::boolean AS duration_statement_logging_is_disabled,
      (
        current_setting('log_min_duration_sample') = '-1'
        OR current_setting('log_statement_sample_rate')::numeric = 0
      )::boolean AS sampled_statement_logging_is_disabled,
      (
        current_setting('log_transaction_sample_rate')::numeric = 0
      )::boolean AS transaction_statement_sampling_is_disabled,
      (
        current_setting('debug_print_parse') = 'off'
        AND current_setting('debug_print_rewritten') = 'off'
        AND current_setting('debug_print_plan') = 'off'
      )::boolean AS debug_query_logging_is_disabled,
      (
        current_setting('server_version_num')::integer >= 160000
        AND current_setting('server_version_num')::integer < 170000
      )::boolean AS server_version_is_supported,
      (
        current_setting('server_version_num')::integer < 160000
        OR current_setting('scram_iterations', true)::integer = 4096
      )::boolean AS scram_iterations_are_supported,
      (
        (
          current_setting('server_version_num')::integer < 160000
          AND current_setting('createrole_self_grant', true) IS NULL
        )
        OR (
          current_setting('server_version_num')::integer >= 160000
          AND current_setting('createrole_self_grant', true) = ''
        )
      )::boolean AS createrole_self_grant_is_safe,
      (
        current_setting('log_error_verbosity') = 'terse'
      )::boolean AS error_log_verbosity_is_safe,
      (
        current_setting('log_min_error_statement') = 'panic'
      )::boolean AS error_statement_logging_is_disabled,
      (
        COALESCE(current_setting('pgaudit.log', true), 'none') = 'none'
        AND COALESCE(
          current_setting('pgaudit.log_parameter', true),
          'off'
        ) = 'off'
      )::boolean AS pgaudit_logging_is_disabled,
      (
        COALESCE(
          current_setting('pg_stat_statements.track', true),
          'none'
        ) = 'none'
      )::boolean AS nested_statement_tracking_is_disabled,
      (
        current_setting('auto_explain.log_min_duration', true) IS NULL
        OR current_setting(
          'auto_explain.log_min_duration',
          true
        )::integer < 0
      )::boolean AS auto_explain_logging_is_disabled,
      (
        COALESCE(
          current_setting('pg_qs.query_capture_mode', true),
          'none'
        ) = 'none'
        AND COALESCE(
          current_setting('pg_qs.parameters_capture_mode', true),
          'capture_parameterless_only'
        ) = 'capture_parameterless_only'
        AND COALESCE(
          current_setting('pg_qs.emit_query_text', true),
          'off'
        ) = 'off'
      )::boolean AS query_store_capture_is_disabled,
      (
        COALESCE(
          current_setting('pgms_wait_sampling.query_capture_mode', true),
          'none'
        ) = 'none'
      )::boolean AS wait_sampling_capture_is_disabled,
      pg_has_role(
        current_user,
        'azure_pg_admin',
        'MEMBER'
      )::boolean AS admin_is_azure_pg_admin,
      (
        SELECT COUNT(*)::bigint::text
        FROM pg_catalog.pg_database
        WHERE NOT datistemplate
          AND datname <> 'postgres'
          AND datname !~ '^azure_'
          AND datname <> $1
      ) AS unexpected_database_count,
      (
        SELECT COUNT(*)::bigint::text
        FROM pg_catalog.pg_roles
        WHERE rolcanlogin
          AND rolname <> current_user
          AND rolname !~ '^azure_'
          AND rolname <> $2
      ) AS unexpected_login_role_count,
      target_state.*
    FROM admin_role_state
    CROSS JOIN LATERAL (
      SELECT
        current_setting('server_version_num')::integer AS server_version_num,
        current_setting('createrole_self_grant', true)::text
          AS createrole_self_grant,
        (SELECT COUNT(*)::bigint::text
         FROM pg_catalog.pg_database
         WHERE datname = $1) AS target_database_count,
        (SELECT pg_catalog.pg_get_userbyid(datdba)::text
         FROM pg_catalog.pg_database
         WHERE datname = $1) AS target_database_owner,
        (SELECT pg_catalog.pg_encoding_to_char(encoding)::text
         FROM pg_catalog.pg_database
         WHERE datname = $1) AS target_database_encoding,
        (SELECT datallowconn
         FROM pg_catalog.pg_database
         WHERE datname = $1) AS target_database_allows_connections,
        (SELECT datconnlimit
         FROM pg_catalog.pg_database
         WHERE datname = $1) AS target_database_connection_limit,
        (SELECT NOT EXISTS (
           SELECT 1
           FROM pg_catalog.aclexplode(
             COALESCE(database_state.datacl, pg_catalog.acldefault('d', database_state.datdba))
           ) AS database_acl
           WHERE database_acl.grantee = 0
         )
         FROM pg_catalog.pg_database AS database_state
         WHERE database_state.datname = $1)
          AS target_database_public_privileges_revoked,
        (SELECT (
           SELECT COUNT(*)::bigint::text
           FROM pg_catalog.aclexplode(
             COALESCE(
               database_state.datacl,
               pg_catalog.acldefault('d', database_state.datdba)
             )
           ) AS database_acl
           INNER JOIN pg_catalog.pg_roles AS grantee_role
             ON grantee_role.oid = database_acl.grantee
           WHERE grantee_role.rolname = $2
         )
         FROM pg_catalog.pg_database AS database_state
         WHERE database_state.datname = $1)
          AS target_database_target_privilege_count,
        (SELECT NOT EXISTS (
           SELECT 1
           FROM pg_catalog.aclexplode(
             COALESCE(
               database_state.datacl,
               pg_catalog.acldefault('d', database_state.datdba)
             )
           ) AS database_acl
           INNER JOIN pg_catalog.pg_roles AS grantee_role
             ON grantee_role.oid = database_acl.grantee
           WHERE grantee_role.rolname = $2
             AND database_acl.is_grantable
         )
         FROM pg_catalog.pg_database AS database_state
         WHERE database_state.datname = $1)
          AS target_database_target_has_no_grant_option,
        (SELECT has_database_privilege(target_role.oid, database_state.oid, 'CONNECT')
         FROM pg_catalog.pg_database AS database_state
         CROSS JOIN pg_catalog.pg_roles AS target_role
         WHERE database_state.datname = $1
           AND target_role.rolname = $2)
          AS target_database_target_has_connect,
        (SELECT has_database_privilege(target_role.oid, database_state.oid, 'CREATE')
         FROM pg_catalog.pg_database AS database_state
         CROSS JOIN pg_catalog.pg_roles AS target_role
         WHERE database_state.datname = $1
           AND target_role.rolname = $2)
          AS target_database_target_has_create,
        (SELECT has_database_privilege(target_role.oid, database_state.oid, 'TEMPORARY')
         FROM pg_catalog.pg_database AS database_state
         CROSS JOIN pg_catalog.pg_roles AS target_role
         WHERE database_state.datname = $1
           AND target_role.rolname = $2)
          AS target_database_target_has_temporary,
        (SELECT (
           SELECT COUNT(*)::bigint::text
           FROM pg_catalog.aclexplode(
             COALESCE(
               database_state.datacl,
               pg_catalog.acldefault('d', database_state.datdba)
             )
           ) AS database_acl
           WHERE database_acl.grantee <> 0
             AND database_acl.grantee <> database_state.datdba
             AND database_acl.grantee <> COALESCE((
               SELECT target_role.oid
               FROM pg_catalog.pg_roles AS target_role
               WHERE target_role.rolname = $2
             ), 0)
         )
         FROM pg_catalog.pg_database AS database_state
         WHERE database_state.datname = $1)
          AS target_database_unexpected_grantee_count,
        (SELECT COUNT(*)::bigint::text
         FROM pg_catalog.pg_roles
         WHERE rolname = $2) AS target_role_count,
        (SELECT rolcanlogin
         FROM pg_catalog.pg_roles
         WHERE rolname = $2) AS target_role_can_login,
        (SELECT rolsuper
         FROM pg_catalog.pg_roles
         WHERE rolname = $2) AS target_role_is_superuser,
        (SELECT rolcreatedb
         FROM pg_catalog.pg_roles
         WHERE rolname = $2) AS target_role_can_create_database,
        (SELECT rolcreaterole
         FROM pg_catalog.pg_roles
         WHERE rolname = $2) AS target_role_can_create_role,
        (SELECT rolinherit
         FROM pg_catalog.pg_roles
         WHERE rolname = $2) AS target_role_inherits,
        (SELECT rolreplication
         FROM pg_catalog.pg_roles
         WHERE rolname = $2) AS target_role_can_replicate,
        (SELECT rolbypassrls
         FROM pg_catalog.pg_roles
         WHERE rolname = $2) AS target_role_can_bypass_rls,
        (SELECT rolconnlimit
         FROM pg_catalog.pg_roles
         WHERE rolname = $2) AS target_role_connection_limit,
        (SELECT rolvaliduntil IS NULL
         FROM pg_catalog.pg_roles
         WHERE rolname = $2) AS target_role_has_no_valid_until,
        (SELECT (
           SELECT COUNT(*)::bigint::text
           FROM pg_catalog.pg_auth_members AS membership
           WHERE membership.member = target_role.oid
         )
         FROM pg_catalog.pg_roles AS target_role
         WHERE target_role.rolname = $2) AS target_role_parent_membership_count,
        (SELECT (
           SELECT COUNT(*)::bigint::text
           FROM pg_catalog.pg_auth_members AS membership
           WHERE membership.roleid = target_role.oid
             AND membership.member = admin_role.oid
         )
         FROM pg_catalog.pg_roles AS target_role
         CROSS JOIN pg_catalog.pg_roles AS admin_role
         WHERE target_role.rolname = $2
           AND admin_role.rolname = current_user)
          AS target_role_creator_membership_count,
        (SELECT (
           SELECT bool_and(membership.admin_option)
           FROM pg_catalog.pg_auth_members AS membership
           WHERE membership.roleid = target_role.oid
             AND membership.member = admin_role.oid
         )
         FROM pg_catalog.pg_roles AS target_role
         CROSS JOIN pg_catalog.pg_roles AS admin_role
         WHERE target_role.rolname = $2
           AND admin_role.rolname = current_user)
          AS target_role_creator_admin_option,
        (SELECT (
           SELECT bool_and(
             (to_jsonb(membership)->>'inherit_option')::boolean
           )
           FROM pg_catalog.pg_auth_members AS membership
           WHERE membership.roleid = target_role.oid
             AND membership.member = admin_role.oid
         )
         FROM pg_catalog.pg_roles AS target_role
         CROSS JOIN pg_catalog.pg_roles AS admin_role
         WHERE target_role.rolname = $2
           AND admin_role.rolname = current_user)
          AS target_role_creator_inherit_option,
        (SELECT (
           SELECT bool_and(
             (to_jsonb(membership)->>'set_option')::boolean
           )
           FROM pg_catalog.pg_auth_members AS membership
           WHERE membership.roleid = target_role.oid
             AND membership.member = admin_role.oid
         )
         FROM pg_catalog.pg_roles AS target_role
         CROSS JOIN pg_catalog.pg_roles AS admin_role
         WHERE target_role.rolname = $2
           AND admin_role.rolname = current_user)
          AS target_role_creator_set_option,
        (SELECT (
           SELECT COUNT(*)::bigint::text
           FROM pg_catalog.pg_auth_members AS membership
           WHERE membership.roleid = target_role.oid
             AND membership.member <> admin_role.oid
         )
         FROM pg_catalog.pg_roles AS target_role
         CROSS JOIN pg_catalog.pg_roles AS admin_role
         WHERE target_role.rolname = $2
           AND admin_role.rolname = current_user)
          AS target_role_other_member_count
    ) AS target_state
  `,
  targetState: `
    SELECT
      current_setting('server_version_num')::integer AS server_version_num,
      current_setting('createrole_self_grant', true)::text
        AS createrole_self_grant,
      (SELECT COUNT(*)::bigint::text
       FROM pg_catalog.pg_database
       WHERE datname = $1) AS target_database_count,
      (SELECT pg_catalog.pg_get_userbyid(datdba)::text
       FROM pg_catalog.pg_database
       WHERE datname = $1) AS target_database_owner,
      (SELECT pg_catalog.pg_encoding_to_char(encoding)::text
       FROM pg_catalog.pg_database
       WHERE datname = $1) AS target_database_encoding,
      (SELECT datallowconn
       FROM pg_catalog.pg_database
       WHERE datname = $1) AS target_database_allows_connections,
      (SELECT datconnlimit
       FROM pg_catalog.pg_database
       WHERE datname = $1) AS target_database_connection_limit,
      (SELECT NOT EXISTS (
         SELECT 1
         FROM pg_catalog.aclexplode(
           COALESCE(database_state.datacl, pg_catalog.acldefault('d', database_state.datdba))
         ) AS database_acl
         WHERE database_acl.grantee = 0
       )
       FROM pg_catalog.pg_database AS database_state
       WHERE database_state.datname = $1)
        AS target_database_public_privileges_revoked,
      (SELECT (
         SELECT COUNT(*)::bigint::text
         FROM pg_catalog.aclexplode(
           COALESCE(
             database_state.datacl,
             pg_catalog.acldefault('d', database_state.datdba)
           )
         ) AS database_acl
         INNER JOIN pg_catalog.pg_roles AS grantee_role
           ON grantee_role.oid = database_acl.grantee
         WHERE grantee_role.rolname = $2
       )
       FROM pg_catalog.pg_database AS database_state
       WHERE database_state.datname = $1)
        AS target_database_target_privilege_count,
      (SELECT NOT EXISTS (
         SELECT 1
         FROM pg_catalog.aclexplode(
           COALESCE(
             database_state.datacl,
             pg_catalog.acldefault('d', database_state.datdba)
           )
         ) AS database_acl
         INNER JOIN pg_catalog.pg_roles AS grantee_role
           ON grantee_role.oid = database_acl.grantee
         WHERE grantee_role.rolname = $2
           AND database_acl.is_grantable
       )
       FROM pg_catalog.pg_database AS database_state
       WHERE database_state.datname = $1)
        AS target_database_target_has_no_grant_option,
      (SELECT has_database_privilege(target_role.oid, database_state.oid, 'CONNECT')
       FROM pg_catalog.pg_database AS database_state
       CROSS JOIN pg_catalog.pg_roles AS target_role
       WHERE database_state.datname = $1
         AND target_role.rolname = $2)
        AS target_database_target_has_connect,
      (SELECT has_database_privilege(target_role.oid, database_state.oid, 'CREATE')
       FROM pg_catalog.pg_database AS database_state
       CROSS JOIN pg_catalog.pg_roles AS target_role
       WHERE database_state.datname = $1
         AND target_role.rolname = $2)
        AS target_database_target_has_create,
      (SELECT has_database_privilege(target_role.oid, database_state.oid, 'TEMPORARY')
       FROM pg_catalog.pg_database AS database_state
       CROSS JOIN pg_catalog.pg_roles AS target_role
       WHERE database_state.datname = $1
         AND target_role.rolname = $2)
        AS target_database_target_has_temporary,
      (SELECT (
         SELECT COUNT(*)::bigint::text
         FROM pg_catalog.aclexplode(
           COALESCE(
             database_state.datacl,
             pg_catalog.acldefault('d', database_state.datdba)
           )
         ) AS database_acl
         WHERE database_acl.grantee <> 0
           AND database_acl.grantee <> database_state.datdba
           AND database_acl.grantee <> COALESCE((
             SELECT target_role.oid
             FROM pg_catalog.pg_roles AS target_role
             WHERE target_role.rolname = $2
           ), 0)
       )
       FROM pg_catalog.pg_database AS database_state
       WHERE database_state.datname = $1)
        AS target_database_unexpected_grantee_count,
      (SELECT COUNT(*)::bigint::text
       FROM pg_catalog.pg_roles
       WHERE rolname = $2) AS target_role_count,
      (SELECT rolcanlogin
       FROM pg_catalog.pg_roles
       WHERE rolname = $2) AS target_role_can_login,
      (SELECT rolsuper
       FROM pg_catalog.pg_roles
       WHERE rolname = $2) AS target_role_is_superuser,
      (SELECT rolcreatedb
       FROM pg_catalog.pg_roles
       WHERE rolname = $2) AS target_role_can_create_database,
      (SELECT rolcreaterole
       FROM pg_catalog.pg_roles
       WHERE rolname = $2) AS target_role_can_create_role,
      (SELECT rolinherit
       FROM pg_catalog.pg_roles
       WHERE rolname = $2) AS target_role_inherits,
      (SELECT rolreplication
       FROM pg_catalog.pg_roles
       WHERE rolname = $2) AS target_role_can_replicate,
      (SELECT rolbypassrls
       FROM pg_catalog.pg_roles
       WHERE rolname = $2) AS target_role_can_bypass_rls,
      (SELECT rolconnlimit
       FROM pg_catalog.pg_roles
       WHERE rolname = $2) AS target_role_connection_limit,
      (SELECT rolvaliduntil IS NULL
       FROM pg_catalog.pg_roles
       WHERE rolname = $2) AS target_role_has_no_valid_until,
      (SELECT (
         SELECT COUNT(*)::bigint::text
         FROM pg_catalog.pg_auth_members AS membership
         WHERE membership.member = target_role.oid
       )
       FROM pg_catalog.pg_roles AS target_role
       WHERE target_role.rolname = $2) AS target_role_parent_membership_count,
      (SELECT (
         SELECT COUNT(*)::bigint::text
         FROM pg_catalog.pg_auth_members AS membership
         WHERE membership.roleid = target_role.oid
           AND membership.member = admin_role.oid
       )
       FROM pg_catalog.pg_roles AS target_role
       CROSS JOIN pg_catalog.pg_roles AS admin_role
       WHERE target_role.rolname = $2
         AND admin_role.rolname = current_user)
        AS target_role_creator_membership_count,
      (SELECT (
         SELECT bool_and(membership.admin_option)
         FROM pg_catalog.pg_auth_members AS membership
         WHERE membership.roleid = target_role.oid
           AND membership.member = admin_role.oid
       )
       FROM pg_catalog.pg_roles AS target_role
       CROSS JOIN pg_catalog.pg_roles AS admin_role
       WHERE target_role.rolname = $2
         AND admin_role.rolname = current_user)
        AS target_role_creator_admin_option,
      (SELECT (
         SELECT bool_and(
           (to_jsonb(membership)->>'inherit_option')::boolean
         )
         FROM pg_catalog.pg_auth_members AS membership
         WHERE membership.roleid = target_role.oid
           AND membership.member = admin_role.oid
       )
       FROM pg_catalog.pg_roles AS target_role
       CROSS JOIN pg_catalog.pg_roles AS admin_role
       WHERE target_role.rolname = $2
         AND admin_role.rolname = current_user)
        AS target_role_creator_inherit_option,
      (SELECT (
         SELECT bool_and(
           (to_jsonb(membership)->>'set_option')::boolean
         )
         FROM pg_catalog.pg_auth_members AS membership
         WHERE membership.roleid = target_role.oid
           AND membership.member = admin_role.oid
       )
       FROM pg_catalog.pg_roles AS target_role
       CROSS JOIN pg_catalog.pg_roles AS admin_role
       WHERE target_role.rolname = $2
         AND admin_role.rolname = current_user)
        AS target_role_creator_set_option,
      (SELECT (
         SELECT COUNT(*)::bigint::text
         FROM pg_catalog.pg_auth_members AS membership
         WHERE membership.roleid = target_role.oid
           AND membership.member <> admin_role.oid
       )
       FROM pg_catalog.pg_roles AS target_role
       CROSS JOIN pg_catalog.pg_roles AS admin_role
       WHERE target_role.rolname = $2
         AND admin_role.rolname = current_user)
        AS target_role_other_member_count
  `,
  applicationIdentity: `
    SELECT
      current_database()::text AS database_name,
      current_user::text AS user_name,
      (
        inet_server_addr() << inet '10.0.0.0/8'
        OR inet_server_addr() << inet '172.16.0.0/12'
        OR inet_server_addr() << inet '192.168.0.0/16'
      )::boolean AS server_is_private,
      role_state.rolcanlogin AS can_login,
      role_state.rolsuper AS is_superuser,
      role_state.rolcreatedb AS can_create_database,
      role_state.rolcreaterole AS can_create_role,
      role_state.rolinherit AS inherits,
      role_state.rolreplication AS can_replicate,
      role_state.rolbypassrls AS can_bypass_rls,
      role_state.rolconnlimit AS connection_limit,
      (
        SELECT COUNT(*)::bigint::text
        FROM pg_catalog.pg_auth_members AS membership
        WHERE membership.member = role_state.oid
      ) AS parent_membership_count,
      pg_has_role(
        current_user,
        'azure_pg_admin',
        'MEMBER'
      )::boolean AS is_azure_pg_admin,
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_database AS database_state
        WHERE database_state.datname = current_database()
          AND database_state.datdba = role_state.oid
      ) AS is_database_owner,
      has_database_privilege(
        current_user,
        current_database(),
        'CONNECT'
      )::boolean AS can_connect_to_database,
      has_database_privilege(
        current_user,
        current_database(),
        'CREATE'
      )::boolean AS can_create_in_database,
      has_database_privilege(
        current_user,
        current_database(),
        'TEMPORARY'
      )::boolean AS can_create_temporary_objects,
      has_schema_privilege(
        current_user,
        'public',
        'CREATE'
      )::boolean AS can_create_in_public_schema,
      has_schema_privilege(
        current_user,
        'public',
        'USAGE'
      )::boolean AS can_use_public_schema
    FROM pg_catalog.pg_roles AS role_state
    WHERE role_state.rolname = current_user
  `,
  schemaAdminIdentity: `
    SELECT
      current_database()::text AS database_name,
      current_user::text AS user_name,
      (
        inet_server_addr() << inet '10.0.0.0/8'
        OR inet_server_addr() << inet '172.16.0.0/12'
        OR inet_server_addr() << inet '192.168.0.0/16'
      )::boolean AS server_is_private,
      pg_has_role(
        current_user,
        'azure_pg_admin',
        'MEMBER'
      )::boolean AS admin_is_azure_pg_admin,
      (
        SELECT COUNT(*)::bigint::text
        FROM pg_catalog.pg_namespace
        WHERE nspname = 'drizzle'
      ) AS drizzle_schema_count,
      (
        SELECT COUNT(*)::bigint::text
        FROM pg_catalog.pg_namespace
        WHERE nspname <> 'public'
          AND nspname <> 'information_schema'
          AND nspname !~ '^pg_'
      ) AS unexpected_schema_count
  `,
  schemaState: `
    SELECT
      namespace_state.nspname::text AS schema_name,
      pg_catalog.pg_get_userbyid(namespace_state.nspowner)::text
        AS schema_owner,
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            namespace_state.nspacl,
            pg_catalog.acldefault('n', namespace_state.nspowner)
          )
        ) AS schema_acl
        WHERE schema_acl.grantee = 0
      ) AS public_privileges_revoked,
      (
        SELECT COUNT(*)::bigint::text
        FROM pg_catalog.aclexplode(
          COALESCE(
            namespace_state.nspacl,
            pg_catalog.acldefault('n', namespace_state.nspowner)
          )
        ) AS schema_acl
        INNER JOIN pg_catalog.pg_roles AS grantee_role
          ON grantee_role.oid = schema_acl.grantee
        WHERE grantee_role.rolname = $1
          AND schema_acl.privilege_type IN ('USAGE', 'CREATE')
      ) AS target_privilege_count,
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            namespace_state.nspacl,
            pg_catalog.acldefault('n', namespace_state.nspowner)
          )
        ) AS schema_acl
        INNER JOIN pg_catalog.pg_roles AS grantee_role
          ON grantee_role.oid = schema_acl.grantee
        WHERE grantee_role.rolname = $1
          AND schema_acl.is_grantable
      ) AS target_has_no_grant_option,
      (
        SELECT COUNT(*)::bigint::text
        FROM pg_catalog.aclexplode(
          COALESCE(
            namespace_state.nspacl,
            pg_catalog.acldefault('n', namespace_state.nspowner)
          )
        ) AS schema_acl
        WHERE schema_acl.grantee <> 0
          AND schema_acl.grantee <> namespace_state.nspowner
          AND schema_acl.grantee <> COALESCE((
            SELECT target_role.oid
            FROM pg_catalog.pg_roles AS target_role
            WHERE target_role.rolname = $1
          ), 0)
      ) AS unexpected_grantee_count,
      has_schema_privilege($1, namespace_state.oid, 'USAGE')::boolean
        AS target_has_usage,
      has_schema_privilege($1, namespace_state.oid, 'CREATE')::boolean
        AS target_has_create,
      (
        SELECT COUNT(*)::bigint::text
        FROM pg_catalog.pg_namespace AS other_namespace
        WHERE other_namespace.nspname <> 'public'
          AND other_namespace.nspname <> 'information_schema'
          AND other_namespace.nspname !~ '^pg_'
      ) AS unexpected_schema_count
    FROM pg_catalog.pg_namespace AS namespace_state
    WHERE namespace_state.nspname = 'public'
  `,
  begin: "BEGIN",
  configureRole: `
    SELECT
      length(set_config('issue75_bootstrap.target_user', $1, true)) > 0
        AS target_user_configured,
      length(set_config('issue75_bootstrap.target_verifier', $2, true)) > 0
        AS target_verifier_configured
  `,
  createRole: `
    DO $issue75_bootstrap$
    DECLARE
      target_user text := current_setting(
        'issue75_bootstrap.target_user',
        true
      );
      target_verifier text := current_setting(
        'issue75_bootstrap.target_verifier',
        true
      );
    BEGIN
      IF target_user IS NULL
        OR target_user !~ '^issue75_[a-z0-9][a-z0-9_]{0,54}$'
        OR target_verifier IS NULL
        OR target_verifier !~ '^SCRAM-SHA-256\\$4096:[A-Za-z0-9+/]+={0,2}\\$[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$'
      THEN
        RAISE EXCEPTION USING ERRCODE = '22023';
      END IF;

      EXECUTE format(
        'CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT %s',
        target_user,
        target_verifier,
        ${ROLE_CONNECTION_LIMIT}
      );
    END
    $issue75_bootstrap$
  `,
  commit: "COMMIT",
  rollback: "ROLLBACK",
  revokePublicSchema: `
    REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC
  `,
});

class BootstrapFailure extends Error {
  constructor(kind, reason, ambiguous = false) {
    super(reason);
    this.name = "BootstrapFailure";
    this.kind = kind;
    this.reason = reason;
    this.ambiguous = ambiguous;
  }
}

function failure(kind, reason, ambiguous = false) {
  return new BootstrapFailure(kind, reason, ambiguous);
}

function isServerConfirmedFailure(error) {
  return (
    typeof error?.code === "string" &&
    /^[0-9A-Z]{5}$/.test(error.code) &&
    !error.code.startsWith("E")
  );
}

function normalizeFailure(error, kind = "internal", reason = "internal_error") {
  return error instanceof BootstrapFailure ? error : failure(kind, reason);
}

function baseLog(status, result, reason, progress) {
  return {
    component: COMPONENT,
    schemaVersion: SCHEMA_VERSION,
    status,
    result,
    reason,
    databaseCreatedConfirmed: progress.databaseCreatedConfirmed,
    roleCreatedConfirmed: progress.roleCreatedConfirmed,
    cleanupAttempted: progress.cleanupAttempted,
    cleanupConfirmed: progress.cleanupConfirmed,
  };
}

function failedOutcome(bootstrapFailure, result, progress) {
  const normalized = normalizeFailure(bootstrapFailure);
  return {
    exitCode: DB_BOOTSTRAP_EXIT_CODES[normalized.kind],
    log: baseLog("failed", result, normalized.reason, progress),
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

function oneRow(result) {
  if (!result || !Array.isArray(result.rows) || result.rows.length !== 1) {
    throw failure("verify", "unexpected_database_state");
  }
  return result.rows[0];
}

function parseCount(value) {
  if (typeof value !== "string" || !/^[01]$/.test(value)) {
    throw failure("verify", "unexpected_database_state");
  }
  return Number(value);
}

function requireNullable(value, validator) {
  if (value === null || value === undefined) return null;
  if (!validator(value)) {
    throw failure("verify", "unexpected_database_state");
  }
  return value;
}

function parseTargetState(row) {
  const databaseCount = parseCount(row?.target_database_count);
  const roleCount = parseCount(row?.target_role_count);
  const serverVersionNum = row?.server_version_num;
  if (!Number.isInteger(serverVersionNum)) {
    throw failure("verify", "unexpected_database_state");
  }
  const state = {
    serverVersionNum,
    createroleSelfGrant: requireNullable(
      row?.createrole_self_grant,
      (value) => typeof value === "string",
    ),
    databaseCount,
    databaseOwner: requireNullable(
      row?.target_database_owner,
      (value) => typeof value === "string",
    ),
    databaseEncoding: requireNullable(
      row?.target_database_encoding,
      (value) => typeof value === "string",
    ),
    databaseAllowsConnections: requireNullable(
      row?.target_database_allows_connections,
      (value) => typeof value === "boolean",
    ),
    databaseConnectionLimit: requireNullable(
      row?.target_database_connection_limit,
      (value) => Number.isInteger(value),
    ),
    databasePublicPrivilegesRevoked: requireNullable(
      row?.target_database_public_privileges_revoked,
      (value) => typeof value === "boolean",
    ),
    databaseTargetPrivilegeCount: requireNullable(
      row?.target_database_target_privilege_count,
      (value) => typeof value === "string" && /^\d+$/.test(value),
    ),
    databaseTargetHasNoGrantOption: requireNullable(
      row?.target_database_target_has_no_grant_option,
      (value) => typeof value === "boolean",
    ),
    databaseTargetHasConnect: requireNullable(
      row?.target_database_target_has_connect,
      (value) => typeof value === "boolean",
    ),
    databaseTargetHasCreate: requireNullable(
      row?.target_database_target_has_create,
      (value) => typeof value === "boolean",
    ),
    databaseTargetHasTemporary: requireNullable(
      row?.target_database_target_has_temporary,
      (value) => typeof value === "boolean",
    ),
    databaseUnexpectedGranteeCount: requireNullable(
      row?.target_database_unexpected_grantee_count,
      (value) => typeof value === "string" && /^\d+$/.test(value),
    ),
    roleCount,
    roleCanLogin: requireNullable(
      row?.target_role_can_login,
      (value) => typeof value === "boolean",
    ),
    roleIsSuperuser: requireNullable(
      row?.target_role_is_superuser,
      (value) => typeof value === "boolean",
    ),
    roleCanCreateDatabase: requireNullable(
      row?.target_role_can_create_database,
      (value) => typeof value === "boolean",
    ),
    roleCanCreateRole: requireNullable(
      row?.target_role_can_create_role,
      (value) => typeof value === "boolean",
    ),
    roleInherits: requireNullable(
      row?.target_role_inherits,
      (value) => typeof value === "boolean",
    ),
    roleCanReplicate: requireNullable(
      row?.target_role_can_replicate,
      (value) => typeof value === "boolean",
    ),
    roleCanBypassRls: requireNullable(
      row?.target_role_can_bypass_rls,
      (value) => typeof value === "boolean",
    ),
    roleConnectionLimit: requireNullable(
      row?.target_role_connection_limit,
      (value) => Number.isInteger(value),
    ),
    roleHasNoValidUntil: requireNullable(
      row?.target_role_has_no_valid_until,
      (value) => typeof value === "boolean",
    ),
    roleParentMembershipCount: requireNullable(
      row?.target_role_parent_membership_count,
      (value) => typeof value === "string" && /^\d+$/.test(value),
    ),
    roleCreatorMembershipCount: requireNullable(
      row?.target_role_creator_membership_count,
      (value) => typeof value === "string" && /^\d+$/.test(value),
    ),
    roleCreatorAdminOption: requireNullable(
      row?.target_role_creator_admin_option,
      (value) => typeof value === "boolean",
    ),
    roleCreatorInheritOption: requireNullable(
      row?.target_role_creator_inherit_option,
      (value) => typeof value === "boolean",
    ),
    roleCreatorSetOption: requireNullable(
      row?.target_role_creator_set_option,
      (value) => typeof value === "boolean",
    ),
    roleOtherMemberCount: requireNullable(
      row?.target_role_other_member_count,
      (value) => typeof value === "string" && /^\d+$/.test(value),
    ),
  };

  const databaseValues = [
    state.databaseOwner,
    state.databaseEncoding,
    state.databaseAllowsConnections,
    state.databaseConnectionLimit,
    state.databasePublicPrivilegesRevoked,
    state.databaseTargetPrivilegeCount,
    state.databaseTargetHasNoGrantOption,
    state.databaseTargetHasConnect,
    state.databaseTargetHasCreate,
    state.databaseTargetHasTemporary,
    state.databaseUnexpectedGranteeCount,
  ];
  const roleValues = [
    state.roleCanLogin,
    state.roleIsSuperuser,
    state.roleCanCreateDatabase,
    state.roleCanCreateRole,
    state.roleInherits,
    state.roleCanReplicate,
    state.roleCanBypassRls,
    state.roleConnectionLimit,
    state.roleHasNoValidUntil,
    state.roleParentMembershipCount,
    state.roleCreatorMembershipCount,
    state.roleOtherMemberCount,
  ];
  const creatorMembershipOptionValues = [
    state.roleCreatorAdminOption,
    state.roleCreatorInheritOption,
    state.roleCreatorSetOption,
  ];
  if (
    (databaseCount === 0 && databaseValues.some((value) => value !== null)) ||
    (databaseCount === 1 && databaseValues.some((value) => value === null)) ||
    (roleCount === 0 &&
      [...roleValues, ...creatorMembershipOptionValues].some(
        (value) => value !== null,
      )) ||
    (roleCount === 1 && roleValues.some((value) => value === null))
  ) {
    throw failure("verify", "unexpected_database_state");
  }

  return state;
}

function isEmptyTargetState(state) {
  return state.databaseCount === 0 && state.roleCount === 0;
}

function isExactRole(state) {
  const hasExpectedCreatorMembership =
    state.serverVersionNum >= 150000 && state.serverVersionNum < 160000
      ? state.createroleSelfGrant === null &&
        state.roleCreatorMembershipCount === "0" &&
        state.roleCreatorAdminOption === null &&
        state.roleCreatorInheritOption === null &&
        state.roleCreatorSetOption === null
      : state.serverVersionNum >= 160000 &&
        state.serverVersionNum < 170000 &&
        state.createroleSelfGrant === "" &&
        state.roleCreatorMembershipCount === "1" &&
        state.roleCreatorAdminOption === true &&
        state.roleCreatorInheritOption === false &&
        state.roleCreatorSetOption === false;
  return (
    state.roleCount === 1 &&
    state.roleCanLogin === true &&
    state.roleIsSuperuser === false &&
    state.roleCanCreateDatabase === false &&
    state.roleCanCreateRole === false &&
    state.roleInherits === false &&
    state.roleCanReplicate === false &&
    state.roleCanBypassRls === false &&
    state.roleConnectionLimit === ROLE_CONNECTION_LIMIT &&
    state.roleHasNoValidUntil === true &&
    state.roleParentMembershipCount === "0" &&
    hasExpectedCreatorMembership &&
    state.roleOtherMemberCount === "0"
  );
}

function isRoleOnlyState(state) {
  return state.databaseCount === 0 && isExactRole(state);
}

function isExactDatabaseCore(state, config) {
  return (
    state.databaseCount === 1 &&
    state.databaseOwner === config.adminUser &&
    state.databaseEncoding === "UTF8" &&
    state.databaseAllowsConnections === true &&
    state.databaseConnectionLimit === DATABASE_CONNECTION_LIMIT
  );
}

function isExactFinalState(state, config) {
  return (
    isExactRole(state) &&
    isExactDatabaseCore(state, config) &&
    state.databasePublicPrivilegesRevoked === true &&
    state.databaseTargetPrivilegeCount === "2" &&
    state.databaseTargetHasNoGrantOption === true &&
    state.databaseTargetHasConnect === true &&
    state.databaseTargetHasCreate === true &&
    state.databaseTargetHasTemporary === false &&
    state.databaseUnexpectedGranteeCount === "0"
  );
}

function containsProductionCandidate(value) {
  return PRODUCTION_CANDIDATE.test(value.toLowerCase());
}

export function createScramVerifier(password) {
  if (!STRONG_ASCII_PASSWORD.test(password)) {
    throw failure("config", "invalid_config");
  }

  const salt = randomBytes(SCRAM_SALT_LENGTH);
  const passwordBytes = Buffer.from(password, "ascii");
  const saltedPassword = pbkdf2Sync(
    passwordBytes,
    salt,
    SCRAM_ITERATIONS,
    SCRAM_KEY_LENGTH,
    "sha256",
  );
  const clientKey = createHmac("sha256", saltedPassword)
    .update("Client Key", "ascii")
    .digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", saltedPassword)
    .update("Server Key", "ascii")
    .digest();
  const verifier =
    `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString("base64")}` +
    `$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;

  passwordBytes.fill(0);
  saltedPassword.fill(0);
  clientKey.fill(0);
  storedKey.fill(0);
  serverKey.fill(0);
  return verifier;
}

function readSecret(environment, name, minimumLength, maximumLength) {
  const value = environment[name];
  if (
    typeof value !== "string" ||
    value.length < minimumLength ||
    value.length > maximumLength ||
    /[\0\r\n]/.test(value)
  ) {
    throw failure("config", "invalid_config");
  }
  return value;
}

export function readBootstrapConfig(environment = process.env) {
  if (environment.KOHO_BOOTSTRAP_DATABASE_SCOPE !== REQUIRED_DATABASE_SCOPE) {
    throw failure("config", "invalid_config");
  }

  const expectedHost = readSecret(
    environment,
    "KOHO_BOOTSTRAP_EXPECTED_DATABASE_HOST",
    1,
    253,
  );
  const rawAdminUrl = readSecret(
    environment,
    "KOHO_BOOTSTRAP_ADMIN_DATABASE_URL",
    1,
    8_192,
  );
  const targetDatabaseName = readSecret(
    environment,
    "KOHO_BOOTSTRAP_TARGET_DATABASE_NAME",
    1,
    63,
  );
  const targetUser = readSecret(
    environment,
    "KOHO_BOOTSTRAP_TARGET_DATABASE_USER",
    1,
    63,
  );
  const targetPassword = readSecret(
    environment,
    "KOHO_BOOTSTRAP_TARGET_DATABASE_PASSWORD",
    16,
    256,
  );

  if (
    expectedHost !== expectedHost.toLowerCase() ||
    !AZURE_POSTGRES_HOST.test(expectedHost) ||
    !expectedHost.split(".", 1)[0].includes("issue75") ||
    containsProductionCandidate(expectedHost.split(".", 1)[0]) ||
    !TARGET_IDENTIFIER.test(targetDatabaseName) ||
    !TARGET_IDENTIFIER.test(targetUser) ||
    targetDatabaseName.includes("__") ||
    targetUser.includes("__") ||
    containsProductionCandidate(targetDatabaseName) ||
    containsProductionCandidate(targetUser) ||
    targetDatabaseName === targetUser ||
    !STRONG_ASCII_PASSWORD.test(targetPassword) ||
    targetPassword === targetDatabaseName ||
    targetPassword === targetUser
  ) {
    throw failure("config", "invalid_config");
  }

  let adminUrl;
  let adminDatabaseName;
  let adminUser;
  let adminPassword;
  try {
    adminUrl = new URL(rawAdminUrl);
    adminDatabaseName = decodeURIComponent(adminUrl.pathname.slice(1));
    adminUser = decodeURIComponent(adminUrl.username);
    adminPassword = decodeURIComponent(adminUrl.password);
  } catch {
    throw failure("config", "invalid_config");
  }

  const queryEntries = [...adminUrl.searchParams.entries()];
  if (
    (adminUrl.protocol !== "postgres:" &&
      adminUrl.protocol !== "postgresql:") ||
    adminUrl.host !== expectedHost ||
    adminUrl.hostname !== adminUrl.hostname.toLowerCase() ||
    (adminUrl.port !== "" && adminUrl.port !== "5432") ||
    adminDatabaseName !== "postgres" ||
    adminUrl.pathname !== "/postgres" ||
    adminUrl.username.length === 0 ||
    adminUrl.password.length === 0 ||
    adminUrl.hash !== "" ||
    queryEntries.length !== 1 ||
    queryEntries[0][0] !== "sslmode" ||
    queryEntries[0][1] !== "verify-full" ||
    !ADMIN_IDENTIFIER.test(adminUser) ||
    !adminUser.includes("issue75") ||
    containsProductionCandidate(adminUser) ||
    adminUser === targetUser ||
    adminPassword === targetPassword
  ) {
    throw failure("config", "invalid_config");
  }

  return Object.freeze({
    adminDatabaseUrl: rawAdminUrl,
    adminUser,
    expectedHost,
    targetDatabaseName,
    targetUser,
    targetPassword,
  });
}

export function createBootstrapClient(databaseUrl, Client = pg.Client) {
  const connectionUrl = new URL(databaseUrl);
  connectionUrl.searchParams.set("sslmode", "verify-full");
  return new Client({
    connectionString: connectionUrl.toString(),
    application_name: "issue75_db_bootstrap",
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
    lock_timeout: LOCK_TIMEOUT_MS,
    keepAlive: true,
  });
}

export function createApplicationClient(databaseUrl, Client = pg.Client) {
  const connectionUrl = new URL(databaseUrl);
  connectionUrl.searchParams.set("sslmode", "verify-full");
  return new Client({
    connectionString: connectionUrl.toString(),
    application_name: "issue75_db_bootstrap_verify",
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
    lock_timeout: LOCK_TIMEOUT_MS,
    keepAlive: true,
  });
}

export function createSchemaAdminClient(databaseUrl, Client = pg.Client) {
  const connectionUrl = new URL(databaseUrl);
  connectionUrl.searchParams.set("sslmode", "verify-full");
  return new Client({
    connectionString: connectionUrl.toString(),
    application_name: "issue75_db_bootstrap_schema",
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
    lock_timeout: LOCK_TIMEOUT_MS,
    keepAlive: true,
  });
}

function schemaAdminDatabaseUrl(config) {
  const connectionUrl = new URL(config.adminDatabaseUrl);
  connectionUrl.pathname = `/${config.targetDatabaseName}`;
  connectionUrl.search = "?sslmode=verify-full";
  return connectionUrl.toString();
}

function applicationDatabaseUrl(config) {
  const connectionUrl = new URL(config.adminDatabaseUrl);
  connectionUrl.username = config.targetUser;
  connectionUrl.password = config.targetPassword;
  connectionUrl.pathname = `/${config.targetDatabaseName}`;
  connectionUrl.search = "?sslmode=verify-full";
  return connectionUrl.toString();
}

async function safeQuery(
  client,
  name,
  text,
  values,
  kind,
  failedReason,
  timedOutReason,
) {
  try {
    return await resolvedTimeout(
      client.query({
        name,
        text,
        values,
        query_timeout: QUERY_TIMEOUT_MS,
      }),
      QUERY_TIMEOUT_MS,
      failure(kind, timedOutReason, true),
    );
  } catch (error) {
    if (error instanceof BootstrapFailure) throw error;
    throw failure(kind, failedReason, !isServerConfirmedFailure(error));
  }
}

function validateSchemaAdminIdentity(row, config) {
  if (
    row?.database_name !== config.targetDatabaseName ||
    row?.user_name !== config.adminUser ||
    row?.server_is_private !== true ||
    row?.admin_is_azure_pg_admin !== true ||
    row?.drizzle_schema_count !== "0" ||
    row?.unexpected_schema_count !== "0"
  ) {
    throw failure("verify", "schema_admin_identity_mismatch");
  }
}

function validateSchemaState(result, config) {
  if (!result || !Array.isArray(result.rows) || result.rows.length !== 1) {
    throw failure("verify", "schema_state_mismatch");
  }
  const row = result.rows[0];
  if (
    row?.schema_name !== "public" ||
    row?.schema_owner !== "azure_pg_admin" ||
    row?.public_privileges_revoked !== true ||
    row?.target_privilege_count !== "2" ||
    row?.target_has_no_grant_option !== true ||
    row?.unexpected_grantee_count !== "0" ||
    row?.target_has_usage !== true ||
    row?.target_has_create !== true ||
    row?.unexpected_schema_count !== "0" ||
    containsProductionCandidate(config.targetUser)
  ) {
    throw failure("verify", "schema_state_mismatch");
  }
}

function validateApplicationIdentity(row, config) {
  if (
    row?.database_name !== config.targetDatabaseName ||
    row?.user_name !== config.targetUser ||
    row?.server_is_private !== true ||
    row?.can_login !== true ||
    row?.is_superuser !== false ||
    row?.can_create_database !== false ||
    row?.can_create_role !== false ||
    row?.inherits !== false ||
    row?.can_replicate !== false ||
    row?.can_bypass_rls !== false ||
    row?.connection_limit !== ROLE_CONNECTION_LIMIT ||
    row?.parent_membership_count !== "0" ||
    row?.is_azure_pg_admin !== false ||
    row?.is_database_owner !== false ||
    row?.can_connect_to_database !== true ||
    row?.can_create_in_database !== true ||
    row?.can_create_temporary_objects !== false ||
    row?.can_create_in_public_schema !== true ||
    row?.can_use_public_schema !== true
  ) {
    throw failure("verify", "application_identity_mismatch");
  }
}

async function configureTargetSchema(config, dependencies, progress) {
  let client;
  let operationFailure = null;
  let idleClientErrorObserved = false;
  let clientEnded = false;
  const onIdleError = () => {
    idleClientErrorObserved = true;
  };

  try {
    try {
      client = dependencies.createSchemaAdminClient(
        schemaAdminDatabaseUrl(config),
      );
      client.on?.("error", onIdleError);
      await resolvedTimeout(
        client.connect(),
        CONNECT_TIMEOUT_MS,
        failure("verify", "schema_admin_connect_timed_out"),
      );
    } catch (error) {
      if (error instanceof BootstrapFailure) throw error;
      throw failure("verify", "schema_admin_connect_failed");
    }

    validateSchemaAdminIdentity(
      oneRow(
        await safeQuery(
          client,
          "issue75-bootstrap-schema-admin-identity",
          SQL.schemaAdminIdentity,
          [],
          "verify",
          "schema_admin_identity_failed",
          "schema_admin_identity_timed_out",
        ),
      ),
      config,
    );

    let transactionStarted = false;
    let schemaFailure = null;
    let schemaCommitAmbiguous = false;
    try {
      await safeQuery(
        client,
        "issue75-bootstrap-schema-begin",
        SQL.begin,
        [],
        "create",
        "schema_privilege_failed",
        "schema_privilege_timed_out",
      );
      transactionStarted = true;
      await safeQuery(
        client,
        "issue75-bootstrap-schema-revoke-public",
        SQL.revokePublicSchema,
        [],
        "create",
        "schema_privilege_failed",
        "schema_privilege_timed_out",
      );
      await safeQuery(
        client,
        "issue75-bootstrap-schema-grant-public-target",
        `GRANT USAGE, CREATE ON SCHEMA public TO ${config.targetUser}`,
        [],
        "create",
        "schema_privilege_failed",
        "schema_privilege_timed_out",
      );
      validateSchemaState(
        await safeQuery(
          client,
          "issue75-bootstrap-schema-state",
          SQL.schemaState,
          [config.targetUser],
          "verify",
          "schema_state_failed",
          "schema_state_timed_out",
        ),
        config,
      );
      try {
        await safeQuery(
          client,
          "issue75-bootstrap-schema-commit",
          SQL.commit,
          [],
          "create",
          "schema_commit_failed",
          "schema_commit_timed_out",
        );
      } catch (error) {
        const normalized = normalizeFailure(
          error,
          "create",
          "schema_commit_failed",
        );
        schemaCommitAmbiguous = normalized.ambiguous;
        throw normalized;
      }
      transactionStarted = false;
    } catch (error) {
      schemaFailure = normalizeFailure(
        error,
        "create",
        "schema_privilege_failed",
      );
      if (transactionStarted) {
        progress.cleanupAttempted = true;
        try {
          await safeQuery(
            client,
            "issue75-bootstrap-schema-rollback",
            SQL.rollback,
            [],
            "cleanup",
            "schema_rollback_failed",
            "schema_rollback_timed_out",
          );
          transactionStarted = false;
          progress.cleanupConfirmed = true;
        } catch (error) {
          // Never retry a rollback with an unconfirmed result.
          throw normalizeFailure(error, "cleanup", "schema_rollback_failed");
        }
      }

      if (schemaCommitAmbiguous) {
        try {
          validateSchemaState(
            await safeQuery(
              client,
              "issue75-bootstrap-schema-reconcile",
              SQL.schemaState,
              [config.targetUser],
              "verify",
              "schema_state_failed",
              "schema_state_timed_out",
            ),
            config,
          );
          schemaFailure = null;
        } catch {
          // Do not retry mutations when their result cannot be confirmed.
        }
      }
    }

    if (schemaFailure !== null) throw schemaFailure;
  } catch (error) {
    operationFailure = normalizeFailure(
      error,
      "verify",
      "schema_state_unconfirmed",
    );
  } finally {
    if (client !== undefined) {
      try {
        await resolvedTimeout(
          client.end(),
          CLEANUP_TIMEOUT_MS,
          failure("cleanup", "schema_client_cleanup_timed_out"),
        );
        clientEnded = true;
      } catch (error) {
        progress.cleanupAttempted = true;
        progress.cleanupConfirmed = false;
        operationFailure = normalizeFailure(
          error,
          "cleanup",
          "schema_client_cleanup_failed",
        );
      }
      if (clientEnded) client.removeListener?.("error", onIdleError);
    }
  }

  if (operationFailure === null && idleClientErrorObserved) {
    throw failure("verify", "schema_idle_client_error");
  }
  if (operationFailure !== null) throw operationFailure;
}

async function verifyApplicationAccess(config, dependencies, progress) {
  let client;
  let operationFailure = null;
  let idleClientErrorObserved = false;
  let clientEnded = false;
  const onIdleError = () => {
    idleClientErrorObserved = true;
  };

  try {
    try {
      client = dependencies.createApplicationClient(
        applicationDatabaseUrl(config),
      );
      client.on?.("error", onIdleError);
      await resolvedTimeout(
        client.connect(),
        CONNECT_TIMEOUT_MS,
        failure("verify", "application_connect_timed_out"),
      );
    } catch (error) {
      if (error instanceof BootstrapFailure) throw error;
      throw failure("verify", "application_connect_failed");
    }

    validateApplicationIdentity(
      oneRow(
        await safeQuery(
          client,
          "issue75-bootstrap-application-identity",
          SQL.applicationIdentity,
          [],
          "verify",
          "application_identity_failed",
          "application_identity_timed_out",
        ),
      ),
      config,
    );
  } catch (error) {
    operationFailure = normalizeFailure(
      error,
      "verify",
      "application_identity_unconfirmed",
    );
  } finally {
    if (client !== undefined) {
      try {
        await resolvedTimeout(
          client.end(),
          CLEANUP_TIMEOUT_MS,
          failure("cleanup", "application_client_cleanup_timed_out"),
        );
        clientEnded = true;
      } catch (error) {
        progress.cleanupAttempted = true;
        progress.cleanupConfirmed = false;
        operationFailure = normalizeFailure(
          error,
          "cleanup",
          "application_client_cleanup_failed",
        );
      }
      if (clientEnded) client.removeListener?.("error", onIdleError);
    }
  }

  if (operationFailure === null && idleClientErrorObserved) {
    throw failure("verify", "application_idle_client_error");
  }
  if (operationFailure !== null) throw operationFailure;
}

function stateQuery(client, name, config, kind = "verify") {
  return safeQuery(
    client,
    name,
    SQL.targetState,
    [config.targetDatabaseName, config.targetUser],
    kind,
    "state_query_failed",
    "state_query_timed_out",
  ).then(oneRow).then(parseTargetState);
}

function validatePreflight(row, config) {
  const targetState = parseTargetState(row);
  if (
    row?.database_name !== "postgres" ||
    row?.user_name !== config.adminUser ||
    row?.server_is_private !== true ||
    row?.admin_can_login !== true ||
    row?.admin_can_create_database !== true ||
    row?.admin_can_create_role !== true ||
    row?.admin_is_superuser !== false ||
    row?.admin_can_replicate !== false ||
    row?.admin_can_bypass_rls !== false ||
    row?.password_encryption_is_scram_sha_256 !== true ||
    row?.parameter_logging_is_disabled !== true ||
    row?.error_parameter_logging_is_disabled !== true ||
    row?.statement_logging_is_disabled !== true ||
    row?.duration_statement_logging_is_disabled !== true ||
    row?.sampled_statement_logging_is_disabled !== true ||
    row?.transaction_statement_sampling_is_disabled !== true ||
    row?.debug_query_logging_is_disabled !== true ||
    targetState.serverVersionNum < 160000 ||
    targetState.serverVersionNum >= 170000 ||
    row?.server_version_is_supported !== true ||
    row?.scram_iterations_are_supported !== true ||
    row?.createrole_self_grant_is_safe !== true ||
    row?.error_log_verbosity_is_safe !== true ||
    row?.error_statement_logging_is_disabled !== true ||
    row?.pgaudit_logging_is_disabled !== true ||
    row?.nested_statement_tracking_is_disabled !== true ||
    row?.auto_explain_logging_is_disabled !== true ||
    row?.query_store_capture_is_disabled !== true ||
    row?.wait_sampling_capture_is_disabled !== true ||
    row?.admin_is_azure_pg_admin !== true ||
    row?.unexpected_database_count !== "0" ||
    row?.unexpected_login_role_count !== "0"
  ) {
    throw failure("state", "database_identity_mismatch");
  }
  if (!isEmptyTargetState(targetState)) {
    throw failure("state", "existing_target_object");
  }
}

function createDatabaseSql(config) {
  return `
    CREATE DATABASE ${config.targetDatabaseName}
      WITH TEMPLATE = template0
      ENCODING = 'UTF8'
      CONNECTION LIMIT = ${DATABASE_CONNECTION_LIMIT}
  `;
}

function revokePublicDatabasePrivilegesSql(config) {
  return `
    REVOKE ALL PRIVILEGES
      ON DATABASE ${config.targetDatabaseName}
      FROM PUBLIC
  `;
}

function grantTargetDatabasePrivilegesSql(config) {
  return `
    GRANT CONNECT, CREATE
      ON DATABASE ${config.targetDatabaseName}
      TO ${config.targetUser}
  `;
}

function dropRoleSql(config) {
  return `DROP ROLE ${config.targetUser}`;
}

async function rollbackRoleCreation(client, config, progress) {
  progress.cleanupAttempted = true;
  try {
    await safeQuery(
      client,
      "issue75-bootstrap-role-rollback",
      SQL.rollback,
      [],
      "cleanup",
      "transaction_rollback_failed",
      "transaction_rollback_timed_out",
    );
  } catch {
    // Catalog reconciliation below is authoritative when it remains readable.
  }

  try {
    const state = await stateQuery(
      client,
      "issue75-bootstrap-role-rollback-state",
      config,
    );
    if (isEmptyTargetState(state)) {
      progress.cleanupConfirmed = true;
      return { result: "rolled_back", failure: null };
    }
    if (isRoleOnlyState(state)) {
      progress.roleCreatedConfirmed = true;
    }
    return {
      result: "unknown",
      failure: failure("cleanup", "transaction_rollback_unconfirmed"),
    };
  } catch {
    return {
      result: "unknown",
      failure: failure("cleanup", "transaction_rollback_unconfirmed"),
    };
  }
}

async function cleanupRoleAfterDatabaseFailure(client, config, progress) {
  progress.cleanupAttempted = true;
  let dropFailure = null;
  try {
    await safeQuery(
      client,
      "issue75-bootstrap-cleanup-role",
      dropRoleSql(config),
      [],
      "cleanup",
      "cleanup_failed",
      "cleanup_timed_out",
    );
  } catch (error) {
    dropFailure = normalizeFailure(error, "cleanup", "cleanup_failed");
  }

  try {
    const state = await stateQuery(
      client,
      "issue75-bootstrap-cleanup-state",
      config,
    );
    if (isEmptyTargetState(state)) {
      progress.roleCreatedConfirmed = false;
      progress.databaseCreatedConfirmed = false;
      progress.cleanupConfirmed = true;
      return null;
    }
  } catch {
    // A failed reconciliation must not trigger another destructive statement.
  }

  return dropFailure ?? failure("cleanup", "cleanup_unconfirmed");
}

export async function runDatabaseBootstrap(options = {}) {
  const dependencies = {
    createAdminClient: createBootstrapClient,
    createSchemaAdminClient,
    createApplicationClient,
    ...options.dependencies,
  };
  const progress = {
    databaseCreatedConfirmed: false,
    roleCreatedConfirmed: false,
    cleanupAttempted: false,
    cleanupConfirmed: false,
  };
  let result = "not_started";
  let config;

  try {
    config = readBootstrapConfig(options.environment ?? process.env);
  } catch (error) {
    return failedOutcome(error, result, progress);
  }

  let client;
  let bootstrapFailure = null;
  let idleClientErrorObserved = false;
  let mutationStarted = false;
  let clientEnded = false;
  const onIdleError = () => {
    idleClientErrorObserved = true;
  };

  try {
    try {
      client = dependencies.createAdminClient(config.adminDatabaseUrl);
      client.on?.("error", onIdleError);
      await resolvedTimeout(
        client.connect(),
        CONNECT_TIMEOUT_MS,
        failure("connect", "connect_timed_out"),
      );
    } catch (error) {
      if (error instanceof BootstrapFailure) throw error;
      throw failure("connect", "connect_failed");
    }

    const lockRow = oneRow(
      await safeQuery(
        client,
        "issue75-bootstrap-advisory-lock",
        SQL.advisoryLock,
        [ADVISORY_LOCK_KEY],
        "state",
        "advisory_lock_failed",
        "advisory_lock_timed_out",
      ),
    );
    if (lockRow?.lock_acquired !== true) {
      throw failure("state", "bootstrap_already_running");
    }

    const preflightRow = oneRow(
      await safeQuery(
        client,
        "issue75-bootstrap-preflight",
        SQL.preflight,
        [config.targetDatabaseName, config.targetUser],
        "state",
        "preflight_failed",
        "preflight_timed_out",
      ),
    );
    validatePreflight(preflightRow, config);
    const targetVerifier = createScramVerifier(config.targetPassword);

    let roleTransactionStarted = false;
    try {
      await safeQuery(
        client,
        "issue75-bootstrap-role-begin",
        SQL.begin,
        [],
        "create",
        "role_create_failed",
        "role_create_timed_out",
      );
      roleTransactionStarted = true;
      const configured = oneRow(
        await safeQuery(
          client,
          "issue75-bootstrap-role-verifier",
          SQL.configureRole,
          [config.targetUser, targetVerifier],
          "create",
          "role_create_failed",
          "role_create_timed_out",
        ),
      );
      if (
        configured?.target_user_configured !== true ||
        configured?.target_verifier_configured !== true
      ) {
        throw failure("create", "role_create_failed");
      }

      mutationStarted = true;
      result = "unknown";
      await safeQuery(
        client,
        "issue75-bootstrap-role-create",
        SQL.createRole,
        [],
        "create",
        "role_create_failed",
        "role_create_timed_out",
      );
      const roleState = await stateQuery(
        client,
        "issue75-bootstrap-role-state",
        config,
      );
      if (!isRoleOnlyState(roleState)) {
        throw failure("verify", "role_state_mismatch");
      }
      await safeQuery(
        client,
        "issue75-bootstrap-role-commit",
        SQL.commit,
        [],
        "create",
        "role_commit_failed",
        "role_commit_timed_out",
      );
      roleTransactionStarted = false;
      progress.roleCreatedConfirmed = true;
    } catch (error) {
      const roleFailure = normalizeFailure(error, "create", "role_create_failed");
      if (roleTransactionStarted) {
        const rollback = await rollbackRoleCreation(client, config, progress);
        result = rollback.result;
        throw rollback.failure ?? roleFailure;
      }
      throw roleFailure;
    }

    let databaseCreateFailure = null;
    try {
      await safeQuery(
        client,
        "issue75-bootstrap-database-create",
        createDatabaseSql(config),
        [],
        "create",
        "database_create_failed",
        "database_create_timed_out",
      );
      progress.databaseCreatedConfirmed = true;
    } catch (error) {
      databaseCreateFailure = normalizeFailure(
        error,
        "create",
        "database_create_failed",
      );
    }

    if (databaseCreateFailure !== null) {
      let state;
      try {
        state = await stateQuery(
          client,
          "issue75-bootstrap-database-reconcile",
          config,
        );
      } catch {
        result = "unknown";
        throw databaseCreateFailure;
      }

      if (isExactRole(state) && isExactDatabaseCore(state, config)) {
        if (!databaseCreateFailure.ambiguous) {
          result = "unknown";
          throw failure("state", "existing_target_object");
        }
        progress.roleCreatedConfirmed = true;
        progress.databaseCreatedConfirmed = true;
      } else if (isRoleOnlyState(state)) {
        const cleanupFailure = await cleanupRoleAfterDatabaseFailure(
          client,
          config,
          progress,
        );
        if (cleanupFailure !== null) {
          result = "unknown";
          throw cleanupFailure;
        }
        result = "rolled_back";
        throw databaseCreateFailure;
      } else {
        result = "unknown";
        throw databaseCreateFailure;
      }
    }

    let stateBeforePrivileges;
    try {
      stateBeforePrivileges = await stateQuery(
        client,
        "issue75-bootstrap-database-state",
        config,
      );
    } catch (error) {
      result = "unknown";
      throw normalizeFailure(error, "verify", "database_state_unconfirmed");
    }
    if (
      !isExactRole(stateBeforePrivileges) ||
      !isExactDatabaseCore(stateBeforePrivileges, config)
    ) {
      result = "unknown";
      throw failure("verify", "database_state_mismatch");
    }
    progress.roleCreatedConfirmed = true;
    progress.databaseCreatedConfirmed = true;

    const databasePrivilegesAlreadyExact = isExactFinalState(
      stateBeforePrivileges,
      config,
    );
    if (!databasePrivilegesAlreadyExact) {
      try {
        await safeQuery(
          client,
          "issue75-bootstrap-database-revoke-public",
          revokePublicDatabasePrivilegesSql(config),
          [],
          "create",
          "database_privilege_failed",
          "database_privilege_timed_out",
        );
      } catch (error) {
        result = "unknown";
        throw normalizeFailure(
          error,
          "create",
          "database_privilege_failed",
        );
      }
    }

    await configureTargetSchema(config, dependencies, progress);

    if (!databasePrivilegesAlreadyExact) {
      let privilegeFailure = null;
      try {
        await safeQuery(
          client,
          "issue75-bootstrap-database-grant-target",
          grantTargetDatabasePrivilegesSql(config),
          [],
          "create",
          "database_privilege_failed",
          "database_privilege_timed_out",
        );
      } catch (error) {
        privilegeFailure = normalizeFailure(
          error,
          "create",
          "database_privilege_failed",
        );
      }
      if (privilegeFailure !== null) {
        if (!privilegeFailure.ambiguous) {
          result = "unknown";
          throw privilegeFailure;
        }
        try {
          const reconciled = await stateQuery(
            client,
            "issue75-bootstrap-database-privilege-reconcile",
            config,
          );
          if (!isExactFinalState(reconciled, config)) {
            result = "unknown";
            throw privilegeFailure;
          }
        } catch (error) {
          result = "unknown";
          throw normalizeFailure(
            error,
            privilegeFailure.kind,
            privilegeFailure.reason,
          );
        }
      }
    }

    let finalState;
    try {
      finalState = await stateQuery(
        client,
        "issue75-bootstrap-final-state",
        config,
      );
    } catch (error) {
      result = "unknown";
      throw normalizeFailure(error, "verify", "final_state_unconfirmed");
    }
    if (!isExactFinalState(finalState, config)) {
      result = "unknown";
      throw failure("verify", "final_state_mismatch");
    }

    progress.roleCreatedConfirmed = true;
    progress.databaseCreatedConfirmed = true;
    await verifyApplicationAccess(config, dependencies, progress);
    result = "confirmed";
  } catch (error) {
    bootstrapFailure = normalizeFailure(error);
  } finally {
    if (client !== undefined) {
      try {
        await resolvedTimeout(
          client.end(),
          CLEANUP_TIMEOUT_MS,
          failure("cleanup", "cleanup_timed_out"),
        );
        clientEnded = true;
      } catch (error) {
        progress.cleanupAttempted = true;
        progress.cleanupConfirmed = false;
        bootstrapFailure = normalizeFailure(error, "cleanup", "cleanup_failed");
        result = "unknown";
      }
      if (clientEnded) {
        client.removeListener?.("error", onIdleError);
      }
    }
  }

  if (bootstrapFailure === null && idleClientErrorObserved) {
    bootstrapFailure = failure("verify", "idle_client_error");
    result = mutationStarted ? "unknown" : "not_started";
  }

  if (bootstrapFailure !== null) {
    return failedOutcome(bootstrapFailure, result, progress);
  }

  return {
    exitCode: DB_BOOTSTRAP_EXIT_CODES.success,
    log: baseLog("succeeded", "confirmed", null, progress),
  };
}

export async function main() {
  let outcome;
  try {
    outcome = await runDatabaseBootstrap();
  } catch {
    outcome = failedOutcome(
      failure("internal", "internal_error"),
      "unknown",
      {
        databaseCreatedConfirmed: false,
        roleCreatedConfirmed: false,
        cleanupAttempted: false,
        cleanupConfirmed: false,
      },
    );
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
