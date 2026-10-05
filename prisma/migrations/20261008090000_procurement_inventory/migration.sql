-- CreateEnum
CREATE TYPE "StockLocationType" AS ENUM ('STORE', 'SITE', 'TRANSIT');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('PURCHASE_IN', 'PURCHASE_RETURN_OUT', 'DISPATCH_OUT', 'TRANSIT_IN', 'TRANSIT_OUT', 'RECEIPT_IN', 'OWNER_DELIVERY_IN', 'USAGE_OUT', 'COUNT_ADJUSTMENT', 'CORRECTION');

-- CreateEnum
CREATE TYPE "DeliverTo" AS ENUM ('STORE', 'SITE');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('OPEN', 'PARTLY_RECEIVED', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PurchasePaymentMode" AS ENUM ('UDHAAR', 'CASH', 'PARTIAL');

-- CreateEnum
CREATE TYPE "PaidFrom" AS ENUM ('OFFICE_CASH', 'BANK', 'CHEQUE', 'JAZZCASH', 'EASYPAISA', 'SITE_CASH');

-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('SAVED', 'PENDING_RATE', 'PENDING_RECEIPT', 'RECEIVED', 'RECEIVED_WITH_SHORTAGE');

-- CreateEnum
CREATE TYPE "SupplierLedgerType" AS ENUM ('OPENING', 'PURCHASE', 'RETURN', 'PAYMENT', 'PAYMENT_REVERSAL', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "SupplierPaymentMethod" AS ENUM ('CASH', 'BANK', 'CHEQUE', 'JAZZCASH', 'EASYPAISA');

-- CreateEnum
CREATE TYPE "SupplierPaymentStatus" AS ENUM ('CLEARED', 'PENDING', 'BOUNCED');

-- CreateEnum
CREATE TYPE "DispatchStatus" AS ENUM ('ON_THE_WAY', 'RECEIVED', 'RECEIVED_WITH_SHORTAGE', 'RECEIVED_WITH_EXCESS', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ShortageKind" AS ENUM ('DISPATCH_SHORT', 'DAMAGED', 'EXCESS', 'SUPPLIER_SHORT');

-- CreateEnum
CREATE TYPE "ShortageSource" AS ENUM ('DISPATCH', 'PURCHASE');

-- CreateEnum
CREATE TYPE "ShortageStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ShortageResolution" AS ENUM ('SEND_REMAINING', 'RETURN_TO_STORE', 'ACCEPT_LOSS', 'RECOVER_FROM_DRIVER', 'SUPPLIER_CREDIT');

-- CreateEnum
CREATE TYPE "StockCountReason" AS ENUM ('HARDENED_IN_RAIN', 'BREAKAGE', 'THEFT_SUSPECTED', 'MEASUREMENT', 'OTHER');

-- AlterEnum
ALTER TYPE "AttachmentKind" ADD VALUE 'CHALLAN';

-- AlterTable
ALTER TABLE "TenantSettings" ADD COLUMN     "blindCountEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "TenantCounter" (
    "tenantId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TenantCounter_pkey" PRIMARY KEY ("tenantId","key")
);

-- CreateTable
CREATE TABLE "StockLocation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "type" "StockLocationType" NOT NULL,
    "name" TEXT NOT NULL,
    "projectId" UUID,
    "systemKey" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StockLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "materialId" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unitCostPaisa" BIGINT NOT NULL,
    "valuePaisa" BIGINT NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "refType" TEXT NOT NULL,
    "refId" UUID NOT NULL,
    "ownerSupplied" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LowStockLevel" (
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "materialId" UUID NOT NULL,
    "minQty" DECIMAL(14,3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LowStockLevel_pkey" PRIMARY KEY ("locationId","materialId")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "supplierId" UUID NOT NULL,
    "deliverTo" "DeliverTo" NOT NULL,
    "locationId" UUID NOT NULL,
    "projectId" UUID,
    "expectedDate" DATE,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "purchaseOrderId" UUID NOT NULL,
    "materialId" UUID NOT NULL,
    "orderedQty" DECIMAL(14,3) NOT NULL,
    "ratePaisa" BIGINT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PurchaseOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Purchase" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "supplierId" UUID NOT NULL,
    "deliverTo" "DeliverTo" NOT NULL,
    "locationId" UUID NOT NULL,
    "projectId" UUID,
    "purchaseOrderId" UUID,
    "challanNo" TEXT NOT NULL,
    "vehicleNo" TEXT,
    "purchaseDate" DATE NOT NULL,
    "paymentMode" "PurchasePaymentMode" NOT NULL,
    "paidNowPaisa" BIGINT NOT NULL DEFAULT 0,
    "paidFrom" "PaidFrom",
    "totalPaisa" BIGINT NOT NULL DEFAULT 0,
    "status" "PurchaseStatus" NOT NULL,
    "challanAttachmentId" UUID NOT NULL,
    "billAttachmentId" UUID,
    "note" TEXT,
    "receivedById" UUID,
    "receivedAt" TIMESTAMPTZ(3),
    "ratesSetAt" TIMESTAMPTZ(3),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "purchaseId" UUID NOT NULL,
    "materialId" UUID NOT NULL,
    "challanQty" DECIMAL(14,3) NOT NULL,
    "countedQty" DECIMAL(14,3),
    "damagedQty" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "ratePaisa" BIGINT,
    "amountPaisa" BIGINT NOT NULL DEFAULT 0,
    "note" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PurchaseItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseCorrection" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "purchaseId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "deltaPaisa" BIGINT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseReturn" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "purchaseId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "totalPaisa" BIGINT NOT NULL,
    "attachmentId" UUID,
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseReturn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseReturnItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "returnId" UUID NOT NULL,
    "materialId" UUID NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "ratePaisa" BIGINT NOT NULL,
    "amountPaisa" BIGINT NOT NULL,

    CONSTRAINT "PurchaseReturnItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierLedgerEntry" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "type" "SupplierLedgerType" NOT NULL,
    "amountPaisa" BIGINT NOT NULL,
    "refType" TEXT,
    "refId" UUID,
    "projectId" UUID,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierPayment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "amountPaisa" BIGINT NOT NULL,
    "method" "SupplierPaymentMethod" NOT NULL,
    "reference" TEXT,
    "chequeNo" TEXT,
    "chequeDate" DATE,
    "status" "SupplierPaymentStatus" NOT NULL,
    "paidOn" DATE NOT NULL,
    "note" TEXT,
    "purchaseId" UUID,
    "projectId" UUID,
    "statusChangedAt" TIMESTAMPTZ(3),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dispatch" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "fromLocationId" UUID NOT NULL,
    "toLocationId" UUID NOT NULL,
    "vehicleNo" TEXT,
    "driverName" TEXT,
    "driverPhone" TEXT,
    "dispatchedAt" TIMESTAMPTZ(3) NOT NULL,
    "loadPhotoAttachmentId" UUID,
    "note" TEXT,
    "status" "DispatchStatus" NOT NULL DEFAULT 'ON_THE_WAY',
    "receivedById" UUID,
    "receivedAt" TIMESTAMPTZ(3),
    "receiveNote" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Dispatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DispatchItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "dispatchId" UUID NOT NULL,
    "materialId" UUID NOT NULL,
    "sentQty" DECIMAL(14,3) NOT NULL,
    "unitCostPaisa" BIGINT NOT NULL,
    "receivedQty" DECIMAL(14,3),
    "damagedQty" DECIMAL(14,3),
    "note" TEXT,
    "photoAttachmentId" UUID,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DispatchItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shortage" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "kind" "ShortageKind" NOT NULL,
    "source" "ShortageSource" NOT NULL,
    "dispatchId" UUID,
    "purchaseId" UUID,
    "projectId" UUID,
    "locationId" UUID NOT NULL,
    "materialId" UUID NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "valuePaisa" BIGINT NOT NULL,
    "status" "ShortageStatus" NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "resolution" "ShortageResolution",
    "resolutionNote" TEXT,
    "recoveredAmountPaisa" BIGINT,
    "newDispatchId" UUID,
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Shortage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnerDelivery" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "note" TEXT,
    "photoAttachmentIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnerDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnerDeliveryItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "deliveryId" UUID NOT NULL,
    "materialId" UUID NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,

    CONSTRAINT "OwnerDeliveryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialUsage" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "usageDate" DATE NOT NULL,
    "note" TEXT,
    "milestoneId" UUID,
    "deviceCreatedAt" TIMESTAMPTZ(3),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaterialUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialUsageItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "usageId" UUID NOT NULL,
    "materialId" UUID NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "ownerSupplied" BOOLEAN NOT NULL DEFAULT false,
    "valuePaisa" BIGINT NOT NULL,

    CONSTRAINT "MaterialUsageItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCount" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "locationId" UUID NOT NULL,
    "countedAt" TIMESTAMPTZ(3) NOT NULL,
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCountItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "countId" UUID NOT NULL,
    "materialId" UUID NOT NULL,
    "ownerSupplied" BOOLEAN NOT NULL DEFAULT false,
    "systemQty" DECIMAL(14,3) NOT NULL,
    "countedQty" DECIMAL(14,3) NOT NULL,
    "difference" DECIMAL(14,3) NOT NULL,
    "reason" "StockCountReason",
    "note" TEXT,
    "valuePaisa" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "StockCountItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StockLocation_tenantId_id_key" ON "StockLocation"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "StockLocation_tenantId_projectId_key" ON "StockLocation"("tenantId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "StockLocation_tenantId_systemKey_key" ON "StockLocation"("tenantId", "systemKey");

-- CreateIndex
CREATE INDEX "StockMovement_tenantId_locationId_materialId_occurredAt_idx" ON "StockMovement"("tenantId", "locationId", "materialId", "occurredAt");

-- CreateIndex
CREATE INDEX "StockMovement_tenantId_refType_refId_idx" ON "StockMovement"("tenantId", "refType", "refId");

-- CreateIndex
CREATE INDEX "StockMovement_tenantId_materialId_occurredAt_idx" ON "StockMovement"("tenantId", "materialId", "occurredAt");

-- CreateIndex
CREATE INDEX "LowStockLevel_tenantId_idx" ON "LowStockLevel"("tenantId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_tenantId_status_idx" ON "PurchaseOrder"("tenantId", "status");

-- CreateIndex
CREATE INDEX "PurchaseOrder_tenantId_supplierId_idx" ON "PurchaseOrder"("tenantId", "supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_tenantId_id_key" ON "PurchaseOrder"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_tenantId_number_key" ON "PurchaseOrder"("tenantId", "number");

-- CreateIndex
CREATE INDEX "PurchaseOrderItem_tenantId_purchaseOrderId_idx" ON "PurchaseOrderItem"("tenantId", "purchaseOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderItem_tenantId_id_key" ON "PurchaseOrderItem"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Purchase_tenantId_supplierId_purchaseDate_idx" ON "Purchase"("tenantId", "supplierId", "purchaseDate");

-- CreateIndex
CREATE INDEX "Purchase_tenantId_status_idx" ON "Purchase"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Purchase_tenantId_projectId_idx" ON "Purchase"("tenantId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Purchase_tenantId_id_key" ON "Purchase"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Purchase_tenantId_number_key" ON "Purchase"("tenantId", "number");

-- CreateIndex
CREATE INDEX "PurchaseItem_tenantId_purchaseId_idx" ON "PurchaseItem"("tenantId", "purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseItem_tenantId_id_key" ON "PurchaseItem"("tenantId", "id");

-- CreateIndex
CREATE INDEX "PurchaseCorrection_tenantId_purchaseId_idx" ON "PurchaseCorrection"("tenantId", "purchaseId");

-- CreateIndex
CREATE INDEX "PurchaseReturn_tenantId_purchaseId_idx" ON "PurchaseReturn"("tenantId", "purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseReturn_tenantId_id_key" ON "PurchaseReturn"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseReturn_tenantId_number_key" ON "PurchaseReturn"("tenantId", "number");

-- CreateIndex
CREATE INDEX "PurchaseReturnItem_tenantId_returnId_idx" ON "PurchaseReturnItem"("tenantId", "returnId");

-- CreateIndex
CREATE INDEX "SupplierLedgerEntry_tenantId_supplierId_occurredAt_idx" ON "SupplierLedgerEntry"("tenantId", "supplierId", "occurredAt");

-- CreateIndex
CREATE INDEX "SupplierPayment_tenantId_supplierId_paidOn_idx" ON "SupplierPayment"("tenantId", "supplierId", "paidOn");

-- CreateIndex
CREATE INDEX "SupplierPayment_tenantId_status_idx" ON "SupplierPayment"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierPayment_tenantId_id_key" ON "SupplierPayment"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Dispatch_tenantId_status_idx" ON "Dispatch"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Dispatch_tenantId_toLocationId_status_idx" ON "Dispatch"("tenantId", "toLocationId", "status");

-- CreateIndex
CREATE INDEX "Dispatch_tenantId_fromLocationId_status_idx" ON "Dispatch"("tenantId", "fromLocationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Dispatch_tenantId_id_key" ON "Dispatch"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Dispatch_tenantId_number_key" ON "Dispatch"("tenantId", "number");

-- CreateIndex
CREATE INDEX "DispatchItem_tenantId_dispatchId_idx" ON "DispatchItem"("tenantId", "dispatchId");

-- CreateIndex
CREATE UNIQUE INDEX "DispatchItem_tenantId_id_key" ON "DispatchItem"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Shortage_tenantId_status_createdAt_idx" ON "Shortage"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Shortage_tenantId_projectId_idx" ON "Shortage"("tenantId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Shortage_tenantId_id_key" ON "Shortage"("tenantId", "id");

-- CreateIndex
CREATE INDEX "OwnerDelivery_tenantId_projectId_deliveryDate_idx" ON "OwnerDelivery"("tenantId", "projectId", "deliveryDate");

-- CreateIndex
CREATE UNIQUE INDEX "OwnerDelivery_tenantId_id_key" ON "OwnerDelivery"("tenantId", "id");

-- CreateIndex
CREATE INDEX "OwnerDeliveryItem_tenantId_deliveryId_idx" ON "OwnerDeliveryItem"("tenantId", "deliveryId");

-- CreateIndex
CREATE INDEX "MaterialUsage_tenantId_projectId_usageDate_idx" ON "MaterialUsage"("tenantId", "projectId", "usageDate");

-- CreateIndex
CREATE UNIQUE INDEX "MaterialUsage_tenantId_id_key" ON "MaterialUsage"("tenantId", "id");

-- CreateIndex
CREATE INDEX "MaterialUsageItem_tenantId_usageId_idx" ON "MaterialUsageItem"("tenantId", "usageId");

-- CreateIndex
CREATE INDEX "StockCount_tenantId_locationId_countedAt_idx" ON "StockCount"("tenantId", "locationId", "countedAt");

-- CreateIndex
CREATE UNIQUE INDEX "StockCount_tenantId_id_key" ON "StockCount"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "StockCount_tenantId_number_key" ON "StockCount"("tenantId", "number");

-- CreateIndex
CREATE INDEX "StockCountItem_tenantId_countId_idx" ON "StockCountItem"("tenantId", "countId");

-- AddForeignKey
ALTER TABLE "TenantCounter" ADD CONSTRAINT "TenantCounter_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLocation" ADD CONSTRAINT "StockLocation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLocation" ADD CONSTRAINT "StockLocation_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "StockLocation"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_tenantId_materialId_fkey" FOREIGN KEY ("tenantId", "materialId") REFERENCES "Material"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "LowStockLevel" ADD CONSTRAINT "LowStockLevel_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LowStockLevel" ADD CONSTRAINT "LowStockLevel_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "StockLocation"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LowStockLevel" ADD CONSTRAINT "LowStockLevel_tenantId_materialId_fkey" FOREIGN KEY ("tenantId", "materialId") REFERENCES "Material"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Supplier"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "StockLocation"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_tenantId_purchaseOrderId_fkey" FOREIGN KEY ("tenantId", "purchaseOrderId") REFERENCES "PurchaseOrder"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_tenantId_materialId_fkey" FOREIGN KEY ("tenantId", "materialId") REFERENCES "Material"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Supplier"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "StockLocation"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_tenantId_purchaseOrderId_fkey" FOREIGN KEY ("tenantId", "purchaseOrderId") REFERENCES "PurchaseOrder"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_tenantId_challanAttachmentId_fkey" FOREIGN KEY ("tenantId", "challanAttachmentId") REFERENCES "Attachment"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_tenantId_billAttachmentId_fkey" FOREIGN KEY ("tenantId", "billAttachmentId") REFERENCES "Attachment"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_tenantId_receivedById_fkey" FOREIGN KEY ("tenantId", "receivedById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PurchaseItem" ADD CONSTRAINT "PurchaseItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseItem" ADD CONSTRAINT "PurchaseItem_tenantId_purchaseId_fkey" FOREIGN KEY ("tenantId", "purchaseId") REFERENCES "Purchase"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseItem" ADD CONSTRAINT "PurchaseItem_tenantId_materialId_fkey" FOREIGN KEY ("tenantId", "materialId") REFERENCES "Material"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PurchaseCorrection" ADD CONSTRAINT "PurchaseCorrection_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseCorrection" ADD CONSTRAINT "PurchaseCorrection_tenantId_purchaseId_fkey" FOREIGN KEY ("tenantId", "purchaseId") REFERENCES "Purchase"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseCorrection" ADD CONSTRAINT "PurchaseCorrection_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PurchaseReturn" ADD CONSTRAINT "PurchaseReturn_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReturn" ADD CONSTRAINT "PurchaseReturn_tenantId_purchaseId_fkey" FOREIGN KEY ("tenantId", "purchaseId") REFERENCES "Purchase"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PurchaseReturn" ADD CONSTRAINT "PurchaseReturn_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Supplier"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PurchaseReturn" ADD CONSTRAINT "PurchaseReturn_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "StockLocation"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PurchaseReturn" ADD CONSTRAINT "PurchaseReturn_tenantId_attachmentId_fkey" FOREIGN KEY ("tenantId", "attachmentId") REFERENCES "Attachment"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PurchaseReturn" ADD CONSTRAINT "PurchaseReturn_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PurchaseReturnItem" ADD CONSTRAINT "PurchaseReturnItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReturnItem" ADD CONSTRAINT "PurchaseReturnItem_tenantId_returnId_fkey" FOREIGN KEY ("tenantId", "returnId") REFERENCES "PurchaseReturn"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReturnItem" ADD CONSTRAINT "PurchaseReturnItem_tenantId_materialId_fkey" FOREIGN KEY ("tenantId", "materialId") REFERENCES "Material"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "SupplierLedgerEntry" ADD CONSTRAINT "SupplierLedgerEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierLedgerEntry" ADD CONSTRAINT "SupplierLedgerEntry_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Supplier"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "SupplierLedgerEntry" ADD CONSTRAINT "SupplierLedgerEntry_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "SupplierLedgerEntry" ADD CONSTRAINT "SupplierLedgerEntry_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Supplier"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_tenantId_purchaseId_fkey" FOREIGN KEY ("tenantId", "purchaseId") REFERENCES "Purchase"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Dispatch" ADD CONSTRAINT "Dispatch_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispatch" ADD CONSTRAINT "Dispatch_tenantId_fromLocationId_fkey" FOREIGN KEY ("tenantId", "fromLocationId") REFERENCES "StockLocation"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Dispatch" ADD CONSTRAINT "Dispatch_tenantId_toLocationId_fkey" FOREIGN KEY ("tenantId", "toLocationId") REFERENCES "StockLocation"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Dispatch" ADD CONSTRAINT "Dispatch_tenantId_loadPhotoAttachmentId_fkey" FOREIGN KEY ("tenantId", "loadPhotoAttachmentId") REFERENCES "Attachment"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Dispatch" ADD CONSTRAINT "Dispatch_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Dispatch" ADD CONSTRAINT "Dispatch_tenantId_receivedById_fkey" FOREIGN KEY ("tenantId", "receivedById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DispatchItem" ADD CONSTRAINT "DispatchItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchItem" ADD CONSTRAINT "DispatchItem_tenantId_dispatchId_fkey" FOREIGN KEY ("tenantId", "dispatchId") REFERENCES "Dispatch"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchItem" ADD CONSTRAINT "DispatchItem_tenantId_materialId_fkey" FOREIGN KEY ("tenantId", "materialId") REFERENCES "Material"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DispatchItem" ADD CONSTRAINT "DispatchItem_tenantId_photoAttachmentId_fkey" FOREIGN KEY ("tenantId", "photoAttachmentId") REFERENCES "Attachment"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Shortage" ADD CONSTRAINT "Shortage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shortage" ADD CONSTRAINT "Shortage_tenantId_dispatchId_fkey" FOREIGN KEY ("tenantId", "dispatchId") REFERENCES "Dispatch"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Shortage" ADD CONSTRAINT "Shortage_tenantId_purchaseId_fkey" FOREIGN KEY ("tenantId", "purchaseId") REFERENCES "Purchase"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Shortage" ADD CONSTRAINT "Shortage_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Shortage" ADD CONSTRAINT "Shortage_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "StockLocation"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Shortage" ADD CONSTRAINT "Shortage_tenantId_materialId_fkey" FOREIGN KEY ("tenantId", "materialId") REFERENCES "Material"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Shortage" ADD CONSTRAINT "Shortage_tenantId_newDispatchId_fkey" FOREIGN KEY ("tenantId", "newDispatchId") REFERENCES "Dispatch"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Shortage" ADD CONSTRAINT "Shortage_tenantId_resolvedById_fkey" FOREIGN KEY ("tenantId", "resolvedById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "OwnerDelivery" ADD CONSTRAINT "OwnerDelivery_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnerDelivery" ADD CONSTRAINT "OwnerDelivery_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "OwnerDelivery" ADD CONSTRAINT "OwnerDelivery_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "OwnerDeliveryItem" ADD CONSTRAINT "OwnerDeliveryItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnerDeliveryItem" ADD CONSTRAINT "OwnerDeliveryItem_tenantId_deliveryId_fkey" FOREIGN KEY ("tenantId", "deliveryId") REFERENCES "OwnerDelivery"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnerDeliveryItem" ADD CONSTRAINT "OwnerDeliveryItem_tenantId_materialId_fkey" FOREIGN KEY ("tenantId", "materialId") REFERENCES "Material"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "MaterialUsage" ADD CONSTRAINT "MaterialUsage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialUsage" ADD CONSTRAINT "MaterialUsage_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "MaterialUsage" ADD CONSTRAINT "MaterialUsage_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "MaterialUsageItem" ADD CONSTRAINT "MaterialUsageItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialUsageItem" ADD CONSTRAINT "MaterialUsageItem_tenantId_usageId_fkey" FOREIGN KEY ("tenantId", "usageId") REFERENCES "MaterialUsage"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialUsageItem" ADD CONSTRAINT "MaterialUsageItem_tenantId_materialId_fkey" FOREIGN KEY ("tenantId", "materialId") REFERENCES "Material"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "StockLocation"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "StockCountItem" ADD CONSTRAINT "StockCountItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountItem" ADD CONSTRAINT "StockCountItem_tenantId_countId_fkey" FOREIGN KEY ("tenantId", "countId") REFERENCES "StockCount"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountItem" ADD CONSTRAINT "StockCountItem_tenantId_materialId_fkey" FOREIGN KEY ("tenantId", "materialId") REFERENCES "Material"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;



-- Row-level security (tenant isolation) + app_user access
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'TenantCounter', 'StockLocation', 'StockMovement', 'LowStockLevel',
    'PurchaseOrder', 'PurchaseOrderItem', 'Purchase', 'PurchaseItem', 'PurchaseCorrection',
    'PurchaseReturn', 'PurchaseReturnItem', 'SupplierLedgerEntry', 'SupplierPayment',
    'Dispatch', 'DispatchItem', 'Shortage', 'OwnerDelivery', 'OwnerDeliveryItem',
    'MaterialUsage', 'MaterialUsageItem', 'StockCount', 'StockCountItem'
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
  "TenantCounter", "StockLocation", "LowStockLevel",
  "PurchaseOrder", "PurchaseOrderItem", "Purchase", "PurchaseItem", "PurchaseCorrection",
  "PurchaseReturn", "PurchaseReturnItem", "SupplierPayment",
  "Dispatch", "DispatchItem", "Shortage", "OwnerDelivery", "OwnerDeliveryItem",
  "MaterialUsage", "MaterialUsageItem", "StockCount", "StockCountItem"
TO app_user;
-- The two ledgers are append-only for the app: no UPDATE / DELETE.
GRANT SELECT, INSERT ON "StockMovement", "SupplierLedgerEntry" TO app_user;

-- Backfill: every company gets a Central Store + one in-transit location,
-- every non-draft project a site location.
INSERT INTO "StockLocation" ("id", "tenantId", "type", "name", "systemKey", "updatedAt")
SELECT uuidv7(), t."id", 'STORE', 'Central Store', 'CENTRAL_STORE', now() FROM "Tenant" t
ON CONFLICT ("tenantId", "systemKey") DO NOTHING;

INSERT INTO "StockLocation" ("id", "tenantId", "type", "name", "systemKey", "updatedAt")
SELECT uuidv7(), t."id", 'TRANSIT', 'In transit', 'TRANSIT', now() FROM "Tenant" t
ON CONFLICT ("tenantId", "systemKey") DO NOTHING;

INSERT INTO "StockLocation" ("id", "tenantId", "type", "name", "projectId", "updatedAt")
SELECT uuidv7(), p."tenantId", 'SITE', p."name", p."id", now() FROM "Project" p
WHERE p."status" <> 'DRAFT'
ON CONFLICT ("tenantId", "projectId") DO NOTHING;
