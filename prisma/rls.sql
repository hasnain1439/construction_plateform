-- ============================================================================
-- Row-level security + role privileges.
--
-- Source of truth for tenant isolation. It is copied into the migration that
-- creates the tables (prisma/migrations/*_init_core_auth/migration.sql). When a
-- later migration adds a tenant-scoped table, add the same three statements
-- (ENABLE, FORCE, POLICY) and an explicit GRANT to app_user in that migration.
--
-- The API sets the tenant per transaction (src/core/db/withTenant.ts):
--     SELECT set_config('app.tenant_id', '<uuid>', true);
-- With no tenant set, current_setting(..., true) is NULL/'' and every policy
-- matches zero rows — queries fail closed.
--
-- Requires roles app_user and app_admin (prisma/roles.sql or `npm run db:setup`).
-- ============================================================================

-- ─── Tenant: a company can only see its own row ────────────────────────────
ALTER TABLE "Tenant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Tenant" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Tenant"
  USING ("id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ─── Every table with a tenantId column ────────────────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'TenantSettings', 'Subscription', 'SubscriptionPayment', 'User', 'Project',
    'UserProjectAccess', 'Invitation', 'Device', 'Session', 'CompanyHoliday',
    'Attachment', 'AuditLog', 'OtpCode'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING ("tenantId" = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK ("tenantId" = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END
$$;

-- ─── Privileges ────────────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA public TO app_user, app_admin;

-- app_admin (BYPASSRLS): everything the auth + platform-admin code needs.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_admin;

-- app_user (RLS applies): tenant tables only, granted explicitly so a new table
-- is unreachable until someone has thought about its RLS policy.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "Tenant", "TenantSettings", "Subscription", "SubscriptionPayment", "User",
  "Project", "UserProjectAccess", "Invitation", "Device", "Session",
  "CompanyHoliday", "Attachment", "AuditLog"
TO app_user;
-- Shared reference data, read-only for tenants.
GRANT SELECT ON "Plan", "PlatformHoliday" TO app_user;
-- app_user never touches PlatformAdmin, PlatformAdminSession or OtpCode.

-- Migration bookkeeping is off-limits to both app roles.
-- (Conditional: Prisma's shadow database has no bookkeeping table.)
DO $$
BEGIN
  IF to_regclass('public."_prisma_migrations"') IS NOT NULL THEN
    REVOKE ALL ON TABLE "_prisma_migrations" FROM app_user, app_admin;
  END IF;
END
$$;
