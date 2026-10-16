-- Step 14 · Control & alerts: variance, burn rate, projected margin, alert engine.
--
-- Tenant table (ENABLE + FORCE RLS, tenant_isolation, GRANTs to app_user, composite FKs):
--   "ControlAlert" — one row per (tenant, dedupeKey) of the control alert engine: OPEN while its
--   rule keeps finding it, RESOLVED when it no longer does, reopened when it comes back. `rule`
--   is a registry key (src/modules/control/alerts/registry.ts), so plug-in rules (Step 16
--   EQUIPMENT_IDLE) need no migration. Texts / details never carry money.
-- NotificationType: CONTROL_ALERT (in-app notification of an opened / reopened alert).
-- TenantSettings ("Alerts & Limits"): behindPlanAlertPoints (15), lateFinishGraceDays (3),
--   quotaAlertPercent (100), spendAheadAlertPoints (10), controlAlertsEnabled (true); the
--   existing overuseAlertPercent (10) drives material overuse.
-- No sync tracking: the Munshi app has no control data.

-- CreateEnum
CREATE TYPE "ControlAlertStatus" AS ENUM ('OPEN', 'RESOLVED');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'CONTROL_ALERT';

-- AlterTable
ALTER TABLE "TenantSettings" ADD COLUMN     "behindPlanAlertPoints" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "controlAlertsEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lateFinishGraceDays" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "quotaAlertPercent" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "spendAheadAlertPoints" INTEGER NOT NULL DEFAULT 10;

-- CreateTable
CREATE TABLE "ControlAlert" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "projectId" UUID,
    "rule" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "severity" "NotificationSeverity" NOT NULL,
    "status" "ControlAlertStatus" NOT NULL DEFAULT 'OPEN',
    "refType" TEXT NOT NULL,
    "refId" UUID,
    "textKey" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "details" JSONB NOT NULL,
    "actionUrl" TEXT NOT NULL,
    "openedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),
    "notifiedAt" TIMESTAMPTZ(3),
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ControlAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ControlAlert_tenantId_status_lastSeenAt_idx" ON "ControlAlert"("tenantId", "status", "lastSeenAt");

-- CreateIndex
CREATE INDEX "ControlAlert_tenantId_projectId_rule_idx" ON "ControlAlert"("tenantId", "projectId", "rule");

-- CreateIndex
CREATE UNIQUE INDEX "ControlAlert_tenantId_id_key" ON "ControlAlert"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ControlAlert_tenantId_dedupeKey_key" ON "ControlAlert"("tenantId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "ControlAlert" ADD CONSTRAINT "ControlAlert_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ControlAlert" ADD CONSTRAINT "ControlAlert_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- Checks
ALTER TABLE "TenantSettings" ADD CONSTRAINT "TenantSettings_controlThresholds_check" CHECK (
  "behindPlanAlertPoints" BETWEEN 5 AND 50
  AND "lateFinishGraceDays" BETWEEN 0 AND 30
  AND "quotaAlertPercent" BETWEEN 50 AND 150
  AND "spendAheadAlertPoints" BETWEEN 1 AND 50
);
ALTER TABLE "ControlAlert" ADD CONSTRAINT "ControlAlert_resolved_check" CHECK (("status" = 'RESOLVED') = ("resolvedAt" IS NOT NULL));

-- Row-level security on the new tenant table
ALTER TABLE "ControlAlert" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ControlAlert" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ControlAlert"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "ControlAlert" TO app_user;
