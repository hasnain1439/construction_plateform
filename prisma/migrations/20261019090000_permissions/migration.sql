-- Permission-based access control: role templates per company, their permissions, per-user
-- overrides, User.roleId / permVersion and Invitation.roleId. Templates and the migration of
-- canSeeFinancials PMs to overrides are written by `npm run backfill:permissions` (idempotent).
-- Until then a user without roleId resolves to the code template of their role (+ the financial
-- bundle when canSeeFinancials), so access is unchanged either way.

-- CreateEnum
CREATE TYPE "RoleBase" AS ENUM ('PM', 'MUNSHI', 'OTHER');

-- CreateEnum
CREATE TYPE "PermissionScope" AS ENUM ('ASSIGNED_PROJECTS', 'ALL_PROJECTS');

-- CreateEnum
CREATE TYPE "PermissionEffect" AS ENUM ('ALLOW', 'DENY');

-- AlterTable
ALTER TABLE "Invitation" ADD COLUMN     "roleId" UUID;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "permVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "roleId" UUID;

-- CreateTable
CREATE TABLE "Role" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameRoman" TEXT,
    "nameUrdu" TEXT,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "baseRole" "RoleBase" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "permissionKey" TEXT NOT NULL,
    "scope" "PermissionScope" NOT NULL DEFAULT 'ASSIGNED_PROJECTS',
    "maxAmountPaisa" BIGINT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPermissionOverride" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "permissionKey" TEXT NOT NULL,
    "effect" "PermissionEffect" NOT NULL,
    "scope" "PermissionScope",
    "maxAmountPaisa" BIGINT,
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "UserPermissionOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Role_tenantId_id_key" ON "Role"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Role_tenantId_key_key" ON "Role"("tenantId", "key");

-- CreateIndex
CREATE INDEX "RolePermission_tenantId_roleId_idx" ON "RolePermission"("tenantId", "roleId");

-- CreateIndex
CREATE UNIQUE INDEX "RolePermission_roleId_permissionKey_key" ON "RolePermission"("roleId", "permissionKey");

-- CreateIndex
CREATE INDEX "UserPermissionOverride_tenantId_userId_idx" ON "UserPermissionOverride"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserPermissionOverride_userId_permissionKey_key" ON "UserPermissionOverride"("userId", "permissionKey");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_roleId_fkey" FOREIGN KEY ("tenantId", "roleId") REFERENCES "Role"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_tenantId_roleId_fkey" FOREIGN KEY ("tenantId", "roleId") REFERENCES "Role"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPermissionOverride" ADD CONSTRAINT "UserPermissionOverride_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPermissionOverride" ADD CONSTRAINT "UserPermissionOverride_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_tenantId_roleId_fkey" FOREIGN KEY ("tenantId", "roleId") REFERENCES "Role"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- Row-level security (tenant isolation) + app_user access
ALTER TABLE "Role" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Role" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Role"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "RolePermission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RolePermission" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "RolePermission"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "UserPermissionOverride" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserPermissionOverride" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "UserPermissionOverride"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Roles are never deleted by the app (deactivate by moving users off them); role permissions and
-- overrides are replaced as a set, so they need DELETE.
GRANT SELECT, INSERT, UPDATE ON "Role" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "RolePermission" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "UserPermissionOverride" TO app_user;

-- ─── Change tracking ────────────────────────────────────────────────────────────────────────────
-- Phones don't pull these tables: the effective permissions come with /auth/me and every
-- /sync/pull (`access`). A change of a user's permissions bumps User.permVersion; that records a
-- 'UserAccess' change for the user, and their next incremental pull answers resetRequired (the
-- tables / fields / projects they may pull changed).
CREATE TRIGGER sync_track_access AFTER UPDATE OF "permVersion" ON "User"
  FOR EACH ROW WHEN (OLD."permVersion" IS DISTINCT FROM NEW."permVersion")
  EXECUTE FUNCTION sync_track('UserAccess', 'id', '', 'id');
