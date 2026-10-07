-- CreateEnum
CREATE TYPE "SiteCondition" AS ENUM ('NORMAL', 'RAIN', 'POWER_CUT', 'WATER_SHORTAGE', 'CURING', 'LABOUR_SHORT', 'MATERIAL_SHORT', 'OTHER');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'MISSING_DAILY_LOG';

-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN     "clientId" UUID;

-- CreateTable
CREATE TABLE "DailyLog" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "logDate" DATE NOT NULL,
    "note" TEXT,
    "conditions" "SiteCondition"[] DEFAULT ARRAY[]::"SiteCondition"[],
    "workDone" TEXT,
    "photoAttachmentIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "voiceAttachmentIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "createdById" UUID NOT NULL,
    "clientId" UUID,
    "deviceCreatedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DailyLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DailyLog_tenantId_projectId_logDate_idx" ON "DailyLog"("tenantId", "projectId", "logDate");

-- CreateIndex
CREATE UNIQUE INDEX "DailyLog_tenantId_id_key" ON "DailyLog"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DailyLog_projectId_logDate_createdById_key" ON "DailyLog"("projectId", "logDate", "createdById");

-- CreateIndex
CREATE UNIQUE INDEX "DailyLog_tenantId_clientId_key" ON "DailyLog"("tenantId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_tenantId_clientId_key" ON "Attachment"("tenantId", "clientId");

-- AddForeignKey
ALTER TABLE "DailyLog" ADD CONSTRAINT "DailyLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyLog" ADD CONSTRAINT "DailyLog_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DailyLog" ADD CONSTRAINT "DailyLog_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- Row-level security (tenant isolation) + app_user access
ALTER TABLE "DailyLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DailyLog" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "DailyLog"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Logs are edited by their author on the same day; never deleted by the app.
GRANT SELECT, INSERT, UPDATE ON "DailyLog" TO app_user;
