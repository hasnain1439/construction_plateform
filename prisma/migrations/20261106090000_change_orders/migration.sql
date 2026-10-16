-- Step 15 · Change orders: owner-requested extra / omitted work with a mini BoQ, proof of the
-- owner's approval and the billing link; site instructions recorded by the Munshi.
-- * ChangeOrder: per-project number (CO-001), type ADDITION / DEDUCTION, status DRAFT → SENT →
--   APPROVED / REJECTED → IN_PROGRESS → COMPLETED → BILLED, markup %, cost + signed owner total
--   (paisa), days impact + affected milestone ids, proof (WhatsApp screenshot / signed slip / verbal
--   note + attachment ids), billing mode (next stage invoice / own VARIATION invoice), source
--   (manual / site instruction / snag with CHANGE_ORDER attribution).
-- * ChangeOrderLine: material / labour / other lines — quantity (Decimal), cost rate + amount,
--   owner price rate + amount (markup applied).
-- * SiteInstruction: Munshi photo + note (offline clientId), NEW → CONVERTED / DISMISSED.
-- * InvoiceType VARIATION, InvoiceLineSource CHANGE_ORDER, NotificationType SITE_INSTRUCTION_CREATED.
-- Every new table: ENABLE + FORCE RLS, tenant_isolation policy, explicit grants to app_user.
-- SiteInstruction is tracked for offline sync (sync_track trigger).

-- CreateEnum
CREATE TYPE "ChangeOrderType" AS ENUM ('ADDITION', 'DEDUCTION');

-- CreateEnum
CREATE TYPE "ChangeOrderStatus" AS ENUM ('DRAFT', 'SENT', 'APPROVED', 'REJECTED', 'IN_PROGRESS', 'COMPLETED', 'BILLED');

-- CreateEnum
CREATE TYPE "ChangeOrderProofType" AS ENUM ('WHATSAPP_SCREENSHOT', 'SIGNED_SLIP', 'VERBAL');

-- CreateEnum
CREATE TYPE "ChangeOrderSource" AS ENUM ('MANUAL', 'SITE_INSTRUCTION', 'SNAG');

-- CreateEnum
CREATE TYPE "ChangeOrderLineKind" AS ENUM ('MATERIAL', 'LABOUR', 'OTHER');

-- CreateEnum
CREATE TYPE "ChangeOrderBillingMode" AS ENUM ('NEXT_STAGE', 'VARIATION');

-- CreateEnum
CREATE TYPE "SiteInstructionStatus" AS ENUM ('NEW', 'CONVERTED', 'DISMISSED');

-- AlterEnum
ALTER TYPE "InvoiceType" ADD VALUE 'VARIATION';

-- AlterEnum
ALTER TYPE "InvoiceLineSource" ADD VALUE 'CHANGE_ORDER';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'SITE_INSTRUCTION_CREATED';

-- CreateTable
CREATE TABLE "ChangeOrder" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" "ChangeOrderType" NOT NULL,
    "status" "ChangeOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "source" "ChangeOrderSource" NOT NULL DEFAULT 'MANUAL',
    "siteInstructionId" UUID,
    "snagId" UUID,
    "estimateId" UUID,
    "markupPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "costPaisa" BIGINT NOT NULL DEFAULT 0,
    "totalPaisa" BIGINT NOT NULL DEFAULT 0,
    "daysImpact" INTEGER NOT NULL DEFAULT 0,
    "affectedMilestoneIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "proofType" "ChangeOrderProofType",
    "proofNote" TEXT,
    "proofAttachmentIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "billingMode" "ChangeOrderBillingMode",
    "sentAt" TIMESTAMPTZ(3),
    "approvedOn" DATE,
    "approvedAt" TIMESTAMPTZ(3),
    "approvedById" UUID,
    "rejectedAt" TIMESTAMPTZ(3),
    "rejectionReason" TEXT,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "billedAt" TIMESTAMPTZ(3),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ChangeOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeOrderLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "changeOrderId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "kind" "ChangeOrderLineKind" NOT NULL,
    "materialId" UUID,
    "laborRateId" UUID,
    "description" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "ratePaisa" BIGINT NOT NULL,
    "rateSource" TEXT NOT NULL,
    "amountPaisa" BIGINT NOT NULL,
    "priceRatePaisa" BIGINT NOT NULL,
    "priceAmountPaisa" BIGINT NOT NULL,

    CONSTRAINT "ChangeOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteInstruction" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "note" TEXT NOT NULL,
    "photoIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "status" "SiteInstructionStatus" NOT NULL DEFAULT 'NEW',
    "dismissReason" TEXT,
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "clientId" UUID,
    "deviceCreatedAt" TIMESTAMPTZ(3),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SiteInstruction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChangeOrder_tenantId_projectId_status_idx" ON "ChangeOrder"("tenantId", "projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ChangeOrder_tenantId_id_key" ON "ChangeOrder"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ChangeOrder_projectId_number_key" ON "ChangeOrder"("projectId", "number");

-- CreateIndex
CREATE INDEX "ChangeOrderLine_tenantId_changeOrderId_idx" ON "ChangeOrderLine"("tenantId", "changeOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "ChangeOrderLine_tenantId_id_key" ON "ChangeOrderLine"("tenantId", "id");

-- CreateIndex
CREATE INDEX "SiteInstruction_tenantId_projectId_status_idx" ON "SiteInstruction"("tenantId", "projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SiteInstruction_tenantId_id_key" ON "SiteInstruction"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SiteInstruction_projectId_number_key" ON "SiteInstruction"("projectId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "SiteInstruction_tenantId_clientId_key" ON "SiteInstruction"("tenantId", "clientId");

-- AddForeignKey
ALTER TABLE "ChangeOrder" ADD CONSTRAINT "ChangeOrder_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeOrder" ADD CONSTRAINT "ChangeOrder_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ChangeOrder" ADD CONSTRAINT "ChangeOrder_tenantId_siteInstructionId_fkey" FOREIGN KEY ("tenantId", "siteInstructionId") REFERENCES "SiteInstruction"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ChangeOrder" ADD CONSTRAINT "ChangeOrder_tenantId_snagId_fkey" FOREIGN KEY ("tenantId", "snagId") REFERENCES "Snag"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ChangeOrderLine" ADD CONSTRAINT "ChangeOrderLine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeOrderLine" ADD CONSTRAINT "ChangeOrderLine_tenantId_changeOrderId_fkey" FOREIGN KEY ("tenantId", "changeOrderId") REFERENCES "ChangeOrder"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ChangeOrderLine" ADD CONSTRAINT "ChangeOrderLine_tenantId_materialId_fkey" FOREIGN KEY ("tenantId", "materialId") REFERENCES "Material"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ChangeOrderLine" ADD CONSTRAINT "ChangeOrderLine_tenantId_laborRateId_fkey" FOREIGN KEY ("tenantId", "laborRateId") REFERENCES "LaborRate"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "SiteInstruction" ADD CONSTRAINT "SiteInstruction_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteInstruction" ADD CONSTRAINT "SiteInstruction_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ─── Row-level security + grants ────────────────────────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ChangeOrder', 'ChangeOrderLine', 'SiteInstruction']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON "ChangeOrder" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "ChangeOrderLine" TO app_user;
GRANT SELECT, INSERT, UPDATE ON "SiteInstruction" TO app_user;

-- ─── Offline sync change tracking (see 20261016100000_sync_changes) ────────
CREATE TRIGGER sync_track AFTER INSERT OR UPDATE OR DELETE ON "SiteInstruction" FOR EACH ROW EXECUTE FUNCTION sync_track('SiteInstruction', 'id', 'projectId', '');
