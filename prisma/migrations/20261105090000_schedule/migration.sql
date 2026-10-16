-- Step 13 · Schedule: milestones, curing, holidays, stoppages, delays.
--
-- Tenant tables (ENABLE + FORCE RLS, tenant_isolation, GRANTs to app_user, composite FKs):
--   "Schedule" (one per project, the current plan's version / start / teams, Step 15 hook
--   changeOrderDays), "ScheduleStage" (FOUNDATION_PLINTH … FINISHING), "Milestone" (current plan,
--   status, progress, actuals, curing days, billing-stage link), "MilestoneDependency" (FS / SS +
--   lag in calendar days), "MilestoneQuota" (material quantities from the APPROVED estimate — no
--   money), "MilestoneUpdate" (site progress log, append-only), "StoppageDay" (dates, reason,
--   category, PENDING / APPROVED / REJECTED).
-- Frozen tables: "ScheduleBaseline" (the first plan) and "SchedulePlanVersion" (every revised
--   plan) — app_user may only SELECT / INSERT them (no UPDATE / DELETE).
-- Quantities are DECIMAL. MilestoneQuota.materialId has no FK on purpose (snapshot reference,
-- like EstimateLine.materialId). Milestone.billingStageId → ProjectBillingStage with
-- ON DELETE SET NULL ("billingStageId") (the wizard may replace a project's stages).
-- TenantSettings: ramadanDayFactor (0.75) + ramadanPeriods (null = built-in dates).
-- Offline sync: Milestone (+ its quotas / dependencies, and usage entries linked to a milestone)
-- and StoppageDay are change-tracked for /sync/pull.

-- CreateEnum
CREATE TYPE "MilestoneStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'CURING', 'DONE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "DependencyType" AS ENUM ('FS', 'SS');

-- CreateEnum
CREATE TYPE "StoppageReason" AS ENUM ('RAIN', 'SMOG_BAN', 'HOLIDAY', 'OWNER_HOLD', 'MATERIAL_SHORT', 'LABOUR_SHORT', 'OTHER');

-- CreateEnum
CREATE TYPE "StoppageStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DelayCategory" AS ENUM ('OWNER', 'EXCUSABLE', 'CONTRACTOR');

-- AlterTable
ALTER TABLE "TenantSettings" ADD COLUMN     "ramadanDayFactor" DECIMAL(3,2) NOT NULL DEFAULT 0.75,
ADD COLUMN     "ramadanPeriods" JSONB;

-- CreateTable
CREATE TABLE "Schedule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "estimateId" UUID NOT NULL,
    "startDate" DATE NOT NULL,
    "teams" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 1,
    "planFloor" DATE,
    "changeOrderDays" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "generatedById" UUID,
    "generatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replannedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleStage" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "scheduleId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "stageKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Milestone" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "scheduleId" UUID NOT NULL,
    "stageId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "workDays" DECIMAL(8,2) NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "plannedStart" DATE NOT NULL,
    "plannedEnd" DATE NOT NULL,
    "curingDays" INTEGER NOT NULL DEFAULT 0,
    "startNoEarlierThan" DATE,
    "status" "MilestoneStatus" NOT NULL DEFAULT 'PLANNED',
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "actualStart" DATE,
    "actualEnd" DATE,
    "billingStageId" UUID,
    "basis" JSONB NOT NULL DEFAULT '[]',
    "lastProgressAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Milestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MilestoneDependency" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "milestoneId" UUID NOT NULL,
    "dependsOnId" UUID NOT NULL,
    "type" "DependencyType" NOT NULL DEFAULT 'FS',
    "lagDays" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MilestoneDependency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MilestoneQuota" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "milestoneId" UUID NOT NULL,
    "materialId" UUID,
    "material" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "plannedQty" DECIMAL(16,4) NOT NULL,
    "ownerSupplied" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MilestoneQuota_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MilestoneUpdate" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "milestoneId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "status" "MilestoneStatus" NOT NULL,
    "progressPercent" INTEGER NOT NULL,
    "previousStatus" "MilestoneStatus" NOT NULL,
    "previousProgress" INTEGER NOT NULL,
    "note" TEXT,
    "photoAttachmentIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "clientId" UUID,
    "deviceCreatedAt" TIMESTAMPTZ(3),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MilestoneUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleBaseline" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "scheduleId" UUID NOT NULL,
    "estimateId" UUID NOT NULL,
    "startDate" DATE NOT NULL,
    "plannedEnd" DATE NOT NULL,
    "milestones" JSONB NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleBaseline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchedulePlanVersion" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "scheduleId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "plannedEnd" DATE NOT NULL,
    "milestones" JSONB NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchedulePlanVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoppageDay" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "dates" DATE[],
    "reason" "StoppageReason" NOT NULL,
    "category" "DelayCategory" NOT NULL,
    "status" "StoppageStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "photoAttachmentIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "clientId" UUID,
    "deviceCreatedAt" TIMESTAMPTZ(3),
    "reportedById" UUID,
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StoppageDay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Schedule_tenantId_id_key" ON "Schedule"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Schedule_tenantId_projectId_key" ON "Schedule"("tenantId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleStage_tenantId_id_key" ON "ScheduleStage"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleStage_tenantId_scheduleId_stageKey_key" ON "ScheduleStage"("tenantId", "scheduleId", "stageKey");

-- CreateIndex
CREATE INDEX "Milestone_tenantId_projectId_plannedStart_idx" ON "Milestone"("tenantId", "projectId", "plannedStart");

-- CreateIndex
CREATE UNIQUE INDEX "Milestone_tenantId_id_key" ON "Milestone"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Milestone_tenantId_scheduleId_key_key" ON "Milestone"("tenantId", "scheduleId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "MilestoneDependency_tenantId_id_key" ON "MilestoneDependency"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MilestoneDependency_tenantId_milestoneId_dependsOnId_key" ON "MilestoneDependency"("tenantId", "milestoneId", "dependsOnId");

-- CreateIndex
CREATE INDEX "MilestoneQuota_tenantId_milestoneId_idx" ON "MilestoneQuota"("tenantId", "milestoneId");

-- CreateIndex
CREATE UNIQUE INDEX "MilestoneQuota_tenantId_id_key" ON "MilestoneQuota"("tenantId", "id");

-- CreateIndex
CREATE INDEX "MilestoneUpdate_tenantId_milestoneId_createdAt_idx" ON "MilestoneUpdate"("tenantId", "milestoneId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MilestoneUpdate_tenantId_id_key" ON "MilestoneUpdate"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MilestoneUpdate_tenantId_clientId_key" ON "MilestoneUpdate"("tenantId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleBaseline_tenantId_id_key" ON "ScheduleBaseline"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleBaseline_tenantId_scheduleId_key" ON "ScheduleBaseline"("tenantId", "scheduleId");

-- CreateIndex
CREATE UNIQUE INDEX "SchedulePlanVersion_tenantId_id_key" ON "SchedulePlanVersion"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SchedulePlanVersion_tenantId_scheduleId_version_key" ON "SchedulePlanVersion"("tenantId", "scheduleId", "version");

-- CreateIndex
CREATE INDEX "StoppageDay_tenantId_projectId_status_idx" ON "StoppageDay"("tenantId", "projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StoppageDay_tenantId_id_key" ON "StoppageDay"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "StoppageDay_tenantId_clientId_key" ON "StoppageDay"("tenantId", "clientId");

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_tenantId_estimateId_fkey" FOREIGN KEY ("tenantId", "estimateId") REFERENCES "Estimate"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_tenantId_generatedById_fkey" FOREIGN KEY ("tenantId", "generatedById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ScheduleStage" ADD CONSTRAINT "ScheduleStage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleStage" ADD CONSTRAINT "ScheduleStage_tenantId_scheduleId_fkey" FOREIGN KEY ("tenantId", "scheduleId") REFERENCES "Schedule"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Milestone" ADD CONSTRAINT "Milestone_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Milestone" ADD CONSTRAINT "Milestone_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Milestone" ADD CONSTRAINT "Milestone_tenantId_scheduleId_fkey" FOREIGN KEY ("tenantId", "scheduleId") REFERENCES "Schedule"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Milestone" ADD CONSTRAINT "Milestone_tenantId_stageId_fkey" FOREIGN KEY ("tenantId", "stageId") REFERENCES "ScheduleStage"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Milestone" ADD CONSTRAINT "Milestone_tenantId_billingStageId_fkey" FOREIGN KEY ("tenantId", "billingStageId") REFERENCES "ProjectBillingStage"("tenantId", "id") ON DELETE SET NULL ("billingStageId") ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "MilestoneDependency" ADD CONSTRAINT "MilestoneDependency_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MilestoneDependency" ADD CONSTRAINT "MilestoneDependency_tenantId_milestoneId_fkey" FOREIGN KEY ("tenantId", "milestoneId") REFERENCES "Milestone"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MilestoneDependency" ADD CONSTRAINT "MilestoneDependency_tenantId_dependsOnId_fkey" FOREIGN KEY ("tenantId", "dependsOnId") REFERENCES "Milestone"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MilestoneQuota" ADD CONSTRAINT "MilestoneQuota_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MilestoneQuota" ADD CONSTRAINT "MilestoneQuota_tenantId_milestoneId_fkey" FOREIGN KEY ("tenantId", "milestoneId") REFERENCES "Milestone"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MilestoneUpdate" ADD CONSTRAINT "MilestoneUpdate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MilestoneUpdate" ADD CONSTRAINT "MilestoneUpdate_tenantId_milestoneId_fkey" FOREIGN KEY ("tenantId", "milestoneId") REFERENCES "Milestone"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MilestoneUpdate" ADD CONSTRAINT "MilestoneUpdate_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ScheduleBaseline" ADD CONSTRAINT "ScheduleBaseline_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleBaseline" ADD CONSTRAINT "ScheduleBaseline_tenantId_scheduleId_fkey" FOREIGN KEY ("tenantId", "scheduleId") REFERENCES "Schedule"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleBaseline" ADD CONSTRAINT "ScheduleBaseline_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "SchedulePlanVersion" ADD CONSTRAINT "SchedulePlanVersion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchedulePlanVersion" ADD CONSTRAINT "SchedulePlanVersion_tenantId_scheduleId_fkey" FOREIGN KEY ("tenantId", "scheduleId") REFERENCES "Schedule"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchedulePlanVersion" ADD CONSTRAINT "SchedulePlanVersion_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "StoppageDay" ADD CONSTRAINT "StoppageDay_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoppageDay" ADD CONSTRAINT "StoppageDay_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoppageDay" ADD CONSTRAINT "StoppageDay_tenantId_reportedById_fkey" FOREIGN KEY ("tenantId", "reportedById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "StoppageDay" ADD CONSTRAINT "StoppageDay_tenantId_decidedById_fkey" FOREIGN KEY ("tenantId", "decidedById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- Range checks
ALTER TABLE "Milestone" ADD CONSTRAINT "Milestone_progress_check" CHECK ("progressPercent" BETWEEN 0 AND 100);
ALTER TABLE "Milestone" ADD CONSTRAINT "Milestone_dates_check" CHECK ("plannedEnd" >= "plannedStart");
ALTER TABLE "MilestoneDependency" ADD CONSTRAINT "MilestoneDependency_not_self_check" CHECK ("milestoneId" <> "dependsOnId");
ALTER TABLE "TenantSettings" ADD CONSTRAINT "TenantSettings_ramadanDayFactor_check" CHECK ("ramadanDayFactor" > 0 AND "ramadanDayFactor" <= 1);

-- Row-level security on every new tenant table
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Schedule', 'ScheduleStage', 'Milestone', 'MilestoneDependency', 'MilestoneQuota', 'MilestoneUpdate', 'ScheduleBaseline', 'SchedulePlanVersion', 'StoppageDay']
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

GRANT SELECT, INSERT, UPDATE, DELETE ON "Schedule", "ScheduleStage", "Milestone", "MilestoneDependency", "MilestoneQuota", "StoppageDay" TO app_user;
-- Append-only / frozen: no UPDATE, no DELETE for the app.
GRANT SELECT, INSERT ON "MilestoneUpdate", "ScheduleBaseline", "SchedulePlanVersion" TO app_user;

-- Offline sync change tracking (sync_track: logical table, id column, project column, user column)
CREATE TRIGGER sync_track AFTER INSERT OR UPDATE OR DELETE ON "Milestone" FOR EACH ROW EXECUTE FUNCTION sync_track('Milestone', 'id', 'projectId', '');
CREATE TRIGGER sync_track AFTER INSERT OR UPDATE OR DELETE ON "MilestoneQuota" FOR EACH ROW EXECUTE FUNCTION sync_track('Milestone', 'milestoneId', '', '');
CREATE TRIGGER sync_track AFTER INSERT OR UPDATE OR DELETE ON "MilestoneDependency" FOR EACH ROW EXECUTE FUNCTION sync_track('Milestone', 'milestoneId', '', '');
CREATE TRIGGER sync_track AFTER INSERT OR UPDATE OR DELETE ON "StoppageDay" FOR EACH ROW EXECUTE FUNCTION sync_track('StoppageDay', 'id', 'projectId', '');
-- A usage entry linked to a milestone changes that milestone's quota used.
CREATE TRIGGER sync_track_milestone AFTER INSERT OR UPDATE ON "MaterialUsage" FOR EACH ROW WHEN (NEW."milestoneId" IS NOT NULL) EXECUTE FUNCTION sync_track('Milestone', 'milestoneId', '', '');
CREATE TRIGGER sync_track_milestone_delete AFTER DELETE ON "MaterialUsage" FOR EACH ROW WHEN (OLD."milestoneId" IS NOT NULL) EXECUTE FUNCTION sync_track('Milestone', 'milestoneId', '', '');
