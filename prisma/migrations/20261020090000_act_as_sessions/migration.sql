-- Super admin act-as hardening: every act-as request needs a live ActAsSession (started with a
-- reason, READ_ONLY by default, WRITE only with a second reason, 60 minutes by default).
-- The company's owners get a PLATFORM_SUPPORT_ACCESS notification when a session starts.

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'PLATFORM_SUPPORT_ACCESS';

-- CreateEnum
CREATE TYPE "ActAsMode" AS ENUM ('READ_ONLY', 'WRITE');

-- CreateTable
CREATE TABLE "ActAsSession" (
    "id" UUID NOT NULL,
    "adminId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "mode" "ActAsMode" NOT NULL DEFAULT 'READ_ONLY',
    "writeReason" TEXT,
    "writeEnabledAt" TIMESTAMPTZ(3),
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "endedAt" TIMESTAMPTZ(3),
    CONSTRAINT "ActAsSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActAsSession_adminId_endedAt_idx" ON "ActAsSession"("adminId", "endedAt");

-- CreateIndex
CREATE INDEX "ActAsSession_tenantId_startedAt_idx" ON "ActAsSession"("tenantId", "startedAt");

-- AddForeignKey
ALTER TABLE "ActAsSession" ADD CONSTRAINT "ActAsSession_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "PlatformAdmin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActAsSession" ADD CONSTRAINT "ActAsSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security: the platform (app_admin) manages sessions; a company (app_user) may only
-- read its own rows. app_admin gets access through the default privileges of the init migration.
ALTER TABLE "ActAsSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ActAsSession" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ActAsSession"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT ON "ActAsSession" TO app_user;
