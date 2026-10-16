-- Step 16 (part 1): equipment & shuttering.
-- * Equipment: the company register (machines and bulk items such as plates / props / scaffold),
--   with an internal hire rate per unit per day and a replacement value (paisa).
-- * EquipmentMovement: append-only ledger; balances per StockLocation (yard = Central Store,
--   transit, sites) = SUM(quantity) per (equipment, rentalId). app_user: SELECT + INSERT only.
-- * EquipmentTransfer (+ items): dispatch / transfer / return through transit, received with counts;
--   the gap becomes EquipmentLoss rows.
-- * EquipmentRental (+ items, returns, return items): yard hire from a Supplier; deposit, damage
--   charges and rent go to the supplier ledger (SupplierLedgerEntry ADJUSTMENT with refType RENTAL_*).
-- * EquipmentLoss: missing / damaged, charged to PROJECT (P&L LOSSES), SUBCONTRACTOR (sub-contract
--   ledger DEDUCTION) or WRITE_OFF.
-- * EquipmentCharge: daily INTERNAL_HIRE / RENTAL cost per (day, baseKey); corrections are new rows
--   (seq 1, 2, ...). Append-only for app_user. Feeds the project P&L bucket EQUIPMENT.
-- Every table: ENABLE + FORCE RLS, tenant_isolation, composite (tenantId, id) FKs.

-- CreateEnum
CREATE TYPE "EquipmentKind" AS ENUM ('MACHINE', 'BULK');

-- CreateEnum
CREATE TYPE "EquipmentCategory" AS ENUM ('SHUTTERING_PLATE', 'PROP', 'SCAFFOLDING', 'MIXER', 'VIBRATOR', 'GENERATOR', 'PUMP', 'TOOL', 'OTHER');

-- CreateEnum
CREATE TYPE "EquipmentMovementType" AS ENUM ('OPENING_IN', 'PURCHASE_IN', 'TRANSFER_OUT', 'TRANSIT_IN', 'TRANSIT_OUT', 'RECEIPT_IN', 'RENTAL_IN', 'RENTAL_RETURN_OUT', 'LOSS_OUT', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "EquipmentTransferKind" AS ENUM ('DISPATCH', 'TRANSFER', 'RETURN');

-- CreateEnum
CREATE TYPE "EquipmentTransferStatus" AS ENUM ('ON_THE_WAY', 'RECEIVED', 'RECEIVED_WITH_GAP', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EquipmentRentalStatus" AS ENUM ('ACTIVE', 'RETURNED', 'CLOSED');

-- CreateEnum
CREATE TYPE "EquipmentLossKind" AS ENUM ('MISSING', 'DAMAGED');

-- CreateEnum
CREATE TYPE "EquipmentLossStatus" AS ENUM ('REPORTED', 'CHARGED');

-- CreateEnum
CREATE TYPE "EquipmentLossSource" AS ENUM ('REPORT', 'TRANSFER_GAP');

-- CreateEnum
CREATE TYPE "EquipmentLossChargeTo" AS ENUM ('PROJECT', 'SUBCONTRACTOR', 'WRITE_OFF');

-- CreateEnum
CREATE TYPE "EquipmentChargeKind" AS ENUM ('INTERNAL_HIRE', 'RENTAL');

-- CreateTable
CREATE TABLE "Equipment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "kind" "EquipmentKind" NOT NULL,
    "category" "EquipmentCategory" NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'nos',
    "serialNo" TEXT,
    "hireRatePaisaPerDay" BIGINT NOT NULL DEFAULT 0,
    "replacementValuePaisa" BIGINT NOT NULL DEFAULT 0,
    "coverageSqftPerUnit" DECIMAL(10,3),
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Equipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EquipmentMovement" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "equipmentId" UUID NOT NULL,
    "rentalId" UUID,
    "quantity" DECIMAL(14,3) NOT NULL,
    "type" "EquipmentMovementType" NOT NULL,
    "refType" TEXT NOT NULL,
    "refId" UUID NOT NULL,
    "note" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EquipmentMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EquipmentTransfer" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "kind" "EquipmentTransferKind" NOT NULL,
    "fromLocationId" UUID NOT NULL,
    "toLocationId" UUID NOT NULL,
    "status" "EquipmentTransferStatus" NOT NULL DEFAULT 'ON_THE_WAY',
    "vehicleNo" TEXT,
    "driverName" TEXT,
    "note" TEXT,
    "sentAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedById" UUID,
    "receivedAt" TIMESTAMPTZ(3),
    "receiveNote" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EquipmentTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EquipmentTransferItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "transferId" UUID NOT NULL,
    "equipmentId" UUID NOT NULL,
    "rentalId" UUID,
    "sentQty" DECIMAL(14,3) NOT NULL,
    "receivedQty" DECIMAL(14,3),
    "damagedQty" DECIMAL(14,3),
    "note" TEXT,
    "photoAttachmentId" UUID,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "EquipmentTransferItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EquipmentRental" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "supplierId" UUID NOT NULL,
    "projectId" UUID,
    "locationId" UUID NOT NULL,
    "status" "EquipmentRentalStatus" NOT NULL DEFAULT 'ACTIVE',
    "startDate" DATE NOT NULL,
    "expectedEndDate" DATE,
    "returnedDate" DATE,
    "closedAt" TIMESTAMPTZ(3),
    "depositPaisa" BIGINT NOT NULL DEFAULT 0,
    "depositRefundedPaisa" BIGINT NOT NULL DEFAULT 0,
    "damageChargesPaisa" BIGINT NOT NULL DEFAULT 0,
    "rentChargedPaisa" BIGINT NOT NULL DEFAULT 0,
    "reference" TEXT,
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EquipmentRental_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EquipmentRentalItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "rentalId" UUID NOT NULL,
    "equipmentId" UUID NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "ratePaisaPerDay" BIGINT NOT NULL,
    "returnedQty" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "missingQty" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "EquipmentRentalItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EquipmentRentalReturn" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "rentalId" UUID NOT NULL,
    "returnDate" DATE NOT NULL,
    "fromLocationId" UUID NOT NULL,
    "damageChargesPaisa" BIGINT NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EquipmentRentalReturn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EquipmentRentalReturnItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "returnId" UUID NOT NULL,
    "rentalItemId" UUID NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "damagedQty" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "missingQty" DECIMAL(14,3) NOT NULL DEFAULT 0,

    CONSTRAINT "EquipmentRentalReturnItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EquipmentLoss" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "kind" "EquipmentLossKind" NOT NULL,
    "source" "EquipmentLossSource" NOT NULL DEFAULT 'REPORT',
    "status" "EquipmentLossStatus" NOT NULL DEFAULT 'REPORTED',
    "equipmentId" UUID NOT NULL,
    "rentalId" UUID,
    "locationId" UUID NOT NULL,
    "projectId" UUID,
    "transferId" UUID,
    "qty" DECIMAL(14,3) NOT NULL,
    "valuePaisa" BIGINT NOT NULL DEFAULT 0,
    "chargedTo" "EquipmentLossChargeTo",
    "subcontractAssignmentId" UUID,
    "photoAttachmentId" UUID,
    "note" TEXT,
    "reportedById" UUID,
    "reportedAt" TIMESTAMPTZ(3) NOT NULL,
    "chargedById" UUID,
    "chargedAt" TIMESTAMPTZ(3),
    "chargeNote" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EquipmentLoss_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EquipmentCharge" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "kind" "EquipmentChargeKind" NOT NULL,
    "baseKey" TEXT NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "projectId" UUID,
    "locationId" UUID,
    "equipmentId" UUID NOT NULL,
    "rentalId" UUID,
    "rentalItemId" UUID,
    "qty" DECIMAL(14,3) NOT NULL,
    "ratePaisa" BIGINT NOT NULL,
    "amountPaisa" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EquipmentCharge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Equipment_tenantId_category_idx" ON "Equipment"("tenantId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "Equipment_tenantId_id_key" ON "Equipment"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Equipment_tenantId_name_key" ON "Equipment"("tenantId", "name");

-- CreateIndex
CREATE INDEX "EquipmentMovement_tenantId_locationId_equipmentId_occurredA_idx" ON "EquipmentMovement"("tenantId", "locationId", "equipmentId", "occurredAt");

-- CreateIndex
CREATE INDEX "EquipmentMovement_tenantId_equipmentId_occurredAt_idx" ON "EquipmentMovement"("tenantId", "equipmentId", "occurredAt");

-- CreateIndex
CREATE INDEX "EquipmentMovement_tenantId_rentalId_idx" ON "EquipmentMovement"("tenantId", "rentalId");

-- CreateIndex
CREATE INDEX "EquipmentMovement_tenantId_refType_refId_idx" ON "EquipmentMovement"("tenantId", "refType", "refId");

-- CreateIndex
CREATE INDEX "EquipmentTransfer_tenantId_toLocationId_status_idx" ON "EquipmentTransfer"("tenantId", "toLocationId", "status");

-- CreateIndex
CREATE INDEX "EquipmentTransfer_tenantId_fromLocationId_status_idx" ON "EquipmentTransfer"("tenantId", "fromLocationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EquipmentTransfer_tenantId_id_key" ON "EquipmentTransfer"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EquipmentTransfer_tenantId_number_key" ON "EquipmentTransfer"("tenantId", "number");

-- CreateIndex
CREATE INDEX "EquipmentTransferItem_tenantId_transferId_idx" ON "EquipmentTransferItem"("tenantId", "transferId");

-- CreateIndex
CREATE UNIQUE INDEX "EquipmentTransferItem_tenantId_id_key" ON "EquipmentTransferItem"("tenantId", "id");

-- CreateIndex
CREATE INDEX "EquipmentRental_tenantId_status_idx" ON "EquipmentRental"("tenantId", "status");

-- CreateIndex
CREATE INDEX "EquipmentRental_tenantId_projectId_idx" ON "EquipmentRental"("tenantId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "EquipmentRental_tenantId_id_key" ON "EquipmentRental"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EquipmentRental_tenantId_number_key" ON "EquipmentRental"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "EquipmentRentalItem_tenantId_id_key" ON "EquipmentRentalItem"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EquipmentRentalItem_tenantId_rentalId_equipmentId_key" ON "EquipmentRentalItem"("tenantId", "rentalId", "equipmentId");

-- CreateIndex
CREATE INDEX "EquipmentRentalReturn_tenantId_rentalId_idx" ON "EquipmentRentalReturn"("tenantId", "rentalId");

-- CreateIndex
CREATE UNIQUE INDEX "EquipmentRentalReturn_tenantId_id_key" ON "EquipmentRentalReturn"("tenantId", "id");

-- CreateIndex
CREATE INDEX "EquipmentRentalReturnItem_tenantId_returnId_idx" ON "EquipmentRentalReturnItem"("tenantId", "returnId");

-- CreateIndex
CREATE INDEX "EquipmentLoss_tenantId_status_idx" ON "EquipmentLoss"("tenantId", "status");

-- CreateIndex
CREATE INDEX "EquipmentLoss_tenantId_projectId_idx" ON "EquipmentLoss"("tenantId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "EquipmentLoss_tenantId_id_key" ON "EquipmentLoss"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EquipmentLoss_tenantId_number_key" ON "EquipmentLoss"("tenantId", "number");

-- CreateIndex
CREATE INDEX "EquipmentCharge_tenantId_projectId_date_idx" ON "EquipmentCharge"("tenantId", "projectId", "date");

-- CreateIndex
CREATE INDEX "EquipmentCharge_tenantId_kind_date_idx" ON "EquipmentCharge"("tenantId", "kind", "date");

-- CreateIndex
CREATE INDEX "EquipmentCharge_tenantId_rentalId_idx" ON "EquipmentCharge"("tenantId", "rentalId");

-- CreateIndex
CREATE UNIQUE INDEX "EquipmentCharge_tenantId_date_baseKey_seq_key" ON "EquipmentCharge"("tenantId", "date", "baseKey", "seq");

-- AddForeignKey
ALTER TABLE "Equipment" ADD CONSTRAINT "Equipment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquipmentMovement" ADD CONSTRAINT "EquipmentMovement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquipmentMovement" ADD CONSTRAINT "EquipmentMovement_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "StockLocation"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentMovement" ADD CONSTRAINT "EquipmentMovement_tenantId_equipmentId_fkey" FOREIGN KEY ("tenantId", "equipmentId") REFERENCES "Equipment"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentMovement" ADD CONSTRAINT "EquipmentMovement_tenantId_rentalId_fkey" FOREIGN KEY ("tenantId", "rentalId") REFERENCES "EquipmentRental"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentMovement" ADD CONSTRAINT "EquipmentMovement_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentTransfer" ADD CONSTRAINT "EquipmentTransfer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquipmentTransfer" ADD CONSTRAINT "EquipmentTransfer_tenantId_fromLocationId_fkey" FOREIGN KEY ("tenantId", "fromLocationId") REFERENCES "StockLocation"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentTransfer" ADD CONSTRAINT "EquipmentTransfer_tenantId_toLocationId_fkey" FOREIGN KEY ("tenantId", "toLocationId") REFERENCES "StockLocation"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentTransfer" ADD CONSTRAINT "EquipmentTransfer_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentTransfer" ADD CONSTRAINT "EquipmentTransfer_tenantId_receivedById_fkey" FOREIGN KEY ("tenantId", "receivedById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentTransferItem" ADD CONSTRAINT "EquipmentTransferItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquipmentTransferItem" ADD CONSTRAINT "EquipmentTransferItem_tenantId_transferId_fkey" FOREIGN KEY ("tenantId", "transferId") REFERENCES "EquipmentTransfer"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentTransferItem" ADD CONSTRAINT "EquipmentTransferItem_tenantId_equipmentId_fkey" FOREIGN KEY ("tenantId", "equipmentId") REFERENCES "Equipment"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentTransferItem" ADD CONSTRAINT "EquipmentTransferItem_tenantId_rentalId_fkey" FOREIGN KEY ("tenantId", "rentalId") REFERENCES "EquipmentRental"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentTransferItem" ADD CONSTRAINT "EquipmentTransferItem_tenantId_photoAttachmentId_fkey" FOREIGN KEY ("tenantId", "photoAttachmentId") REFERENCES "Attachment"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentRental" ADD CONSTRAINT "EquipmentRental_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquipmentRental" ADD CONSTRAINT "EquipmentRental_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Supplier"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentRental" ADD CONSTRAINT "EquipmentRental_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentRental" ADD CONSTRAINT "EquipmentRental_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "StockLocation"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentRental" ADD CONSTRAINT "EquipmentRental_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentRentalItem" ADD CONSTRAINT "EquipmentRentalItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquipmentRentalItem" ADD CONSTRAINT "EquipmentRentalItem_tenantId_rentalId_fkey" FOREIGN KEY ("tenantId", "rentalId") REFERENCES "EquipmentRental"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentRentalItem" ADD CONSTRAINT "EquipmentRentalItem_tenantId_equipmentId_fkey" FOREIGN KEY ("tenantId", "equipmentId") REFERENCES "Equipment"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentRentalReturn" ADD CONSTRAINT "EquipmentRentalReturn_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquipmentRentalReturn" ADD CONSTRAINT "EquipmentRentalReturn_tenantId_rentalId_fkey" FOREIGN KEY ("tenantId", "rentalId") REFERENCES "EquipmentRental"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentRentalReturn" ADD CONSTRAINT "EquipmentRentalReturn_tenantId_fromLocationId_fkey" FOREIGN KEY ("tenantId", "fromLocationId") REFERENCES "StockLocation"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentRentalReturn" ADD CONSTRAINT "EquipmentRentalReturn_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentRentalReturnItem" ADD CONSTRAINT "EquipmentRentalReturnItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquipmentRentalReturnItem" ADD CONSTRAINT "EquipmentRentalReturnItem_tenantId_returnId_fkey" FOREIGN KEY ("tenantId", "returnId") REFERENCES "EquipmentRentalReturn"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentRentalReturnItem" ADD CONSTRAINT "EquipmentRentalReturnItem_tenantId_rentalItemId_fkey" FOREIGN KEY ("tenantId", "rentalItemId") REFERENCES "EquipmentRentalItem"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentLoss" ADD CONSTRAINT "EquipmentLoss_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquipmentLoss" ADD CONSTRAINT "EquipmentLoss_tenantId_equipmentId_fkey" FOREIGN KEY ("tenantId", "equipmentId") REFERENCES "Equipment"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentLoss" ADD CONSTRAINT "EquipmentLoss_tenantId_rentalId_fkey" FOREIGN KEY ("tenantId", "rentalId") REFERENCES "EquipmentRental"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentLoss" ADD CONSTRAINT "EquipmentLoss_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "StockLocation"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentLoss" ADD CONSTRAINT "EquipmentLoss_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentLoss" ADD CONSTRAINT "EquipmentLoss_tenantId_transferId_fkey" FOREIGN KEY ("tenantId", "transferId") REFERENCES "EquipmentTransfer"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentLoss" ADD CONSTRAINT "EquipmentLoss_tenantId_subcontractAssignmentId_fkey" FOREIGN KEY ("tenantId", "subcontractAssignmentId") REFERENCES "SubcontractAssignment"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentLoss" ADD CONSTRAINT "EquipmentLoss_tenantId_photoAttachmentId_fkey" FOREIGN KEY ("tenantId", "photoAttachmentId") REFERENCES "Attachment"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentLoss" ADD CONSTRAINT "EquipmentLoss_tenantId_reportedById_fkey" FOREIGN KEY ("tenantId", "reportedById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentLoss" ADD CONSTRAINT "EquipmentLoss_tenantId_chargedById_fkey" FOREIGN KEY ("tenantId", "chargedById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentCharge" ADD CONSTRAINT "EquipmentCharge_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquipmentCharge" ADD CONSTRAINT "EquipmentCharge_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentCharge" ADD CONSTRAINT "EquipmentCharge_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "StockLocation"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentCharge" ADD CONSTRAINT "EquipmentCharge_tenantId_equipmentId_fkey" FOREIGN KEY ("tenantId", "equipmentId") REFERENCES "Equipment"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentCharge" ADD CONSTRAINT "EquipmentCharge_tenantId_rentalId_fkey" FOREIGN KEY ("tenantId", "rentalId") REFERENCES "EquipmentRental"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EquipmentCharge" ADD CONSTRAINT "EquipmentCharge_tenantId_rentalItemId_fkey" FOREIGN KEY ("tenantId", "rentalItemId") REFERENCES "EquipmentRentalItem"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Row-level security (tenant isolation) + app_user access
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Equipment', 'EquipmentMovement', 'EquipmentTransfer', 'EquipmentTransferItem',
    'EquipmentRental', 'EquipmentRentalItem', 'EquipmentRentalReturn', 'EquipmentRentalReturnItem',
    'EquipmentLoss', 'EquipmentCharge'
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

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "Equipment", "EquipmentTransfer", "EquipmentTransferItem",
  "EquipmentRental", "EquipmentRentalItem", "EquipmentRentalReturn", "EquipmentRentalReturnItem",
  "EquipmentLoss"
TO app_user;
-- The equipment ledger and the daily charges are append-only for the app: no UPDATE / DELETE.
GRANT SELECT, INSERT ON "EquipmentMovement", "EquipmentCharge" TO app_user;

-- Offline sync change tracking (see 20261016100000_sync_changes): equipment register, per-location
-- stock (virtual EquipmentStock, keyed by location), transfers, rentals and losses.
DO $$
DECLARE
  t text[];
BEGIN
  FOREACH t SLICE 1 IN ARRAY ARRAY[
    ['Equipment', 'Equipment', 'id', '', ''],
    ['EquipmentMovement', 'EquipmentStock', 'locationId', '', ''],
    ['EquipmentTransfer', 'EquipmentTransfer', 'id', '', ''],
    ['EquipmentTransferItem', 'EquipmentTransfer', 'transferId', '', ''],
    ['EquipmentRental', 'EquipmentRental', 'id', 'projectId', ''],
    ['EquipmentRentalItem', 'EquipmentRental', 'rentalId', '', ''],
    ['EquipmentLoss', 'EquipmentLoss', 'id', 'projectId', '']
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER sync_track AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION sync_track(%L, %L, %L, %L)',
      t[1], t[2], t[3], t[4], t[5]
    );
  END LOOP;
END
$$;
