-- Several permission roles per member: effective permissions = union of the roles (widest scope,
-- highest approval limit — "no limit" wins) + ALLOW − DENY overrides. User.roleId stays as the
-- primary role (= position 0) for compatibility (/auth/me permissionRole, older clients).
-- Invitation.roleIds: every role given on accept (roleId = the first).

-- CreateTable
CREATE TABLE "UserRoleAssignment" (
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserRoleAssignment_pkey" PRIMARY KEY ("userId","roleId")
);

-- CreateIndex
CREATE INDEX "UserRoleAssignment_tenantId_roleId_idx" ON "UserRoleAssignment"("tenantId", "roleId");

-- AddForeignKey
ALTER TABLE "UserRoleAssignment" ADD CONSTRAINT "UserRoleAssignment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRoleAssignment" ADD CONSTRAINT "UserRoleAssignment_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRoleAssignment" ADD CONSTRAINT "UserRoleAssignment_tenantId_roleId_fkey" FOREIGN KEY ("tenantId", "roleId") REFERENCES "Role"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Invitation" ADD COLUMN     "roleIds" UUID[];

-- Row-level security (tenant isolation) + app_user access (assignments are replaced as a set).
ALTER TABLE "UserRoleAssignment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserRoleAssignment" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "UserRoleAssignment"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "UserRoleAssignment" TO app_user;

-- Backfill: every member's current role becomes their first (primary) assignment.
INSERT INTO "UserRoleAssignment" ("tenantId", "userId", "roleId", "position")
SELECT u."tenantId", u.id, u."roleId", 0 FROM "User" u WHERE u."roleId" IS NOT NULL
ON CONFLICT DO NOTHING;

-- Pending invitations keep their single role as the list.
UPDATE "Invitation" SET "roleIds" = ARRAY["roleId"] WHERE "roleId" IS NOT NULL;
