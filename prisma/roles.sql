-- Application database roles for LOCAL DEVELOPMENT (passwords match .env defaults).
-- Run once as a superuser:  psql -U postgres -f prisma/roles.sql
-- (`npm run db:setup` does the same using the URLs in .env.)
-- In production create these roles with strong passwords via your infra tooling.
--
--   app_user  : the API's normal connection. Row-level security APPLIES.
--   app_admin : BYPASSRLS. Only for cross-tenant auth lookups and platform-admin code.
--
-- Table privileges are granted by the migrations (see prisma/rls.sql).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN NOBYPASSRLS PASSWORD 'app_user_dev_pw';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN
    CREATE ROLE app_admin LOGIN BYPASSRLS PASSWORD 'app_admin_dev_pw';
  END IF;
END
$$;
