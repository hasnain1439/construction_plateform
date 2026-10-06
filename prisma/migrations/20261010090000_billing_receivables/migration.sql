-- CreateEnum
CREATE TYPE "InvoiceType" AS ENUM ('STAGE', 'RUNNING_BILL', 'RECOVERABLE', 'RETENTION', 'OTHER');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PARTLY_PAID', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InvoiceLineSource" AS ENUM ('BILLING_STAGE', 'BILLING_PROGRESS', 'CASH_ENTRY', 'RETENTION', 'MANUAL');

-- CreateEnum
CREATE TYPE "ClientPaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'CHEQUE', 'JAZZCASH', 'EASYPAISA', 'RAAST');

-- CreateEnum
CREATE TYPE "ClientPaymentStatus" AS ENUM ('CLEARED', 'PENDING', 'BOUNCED');

-- CreateEnum
CREATE TYPE "BillingEventType" AS ENUM ('INVOICE_OVERDUE', 'CHEQUE_BOUNCED', 'STAGE_READY_UNBILLED', 'PREVIOUS_STAGE_UNPAID');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AttachmentKind" ADD VALUE 'INVOICE_PDF';
ALTER TYPE "AttachmentKind" ADD VALUE 'RECEIPT_PDF';
ALTER TYPE "AttachmentKind" ADD VALUE 'STATEMENT_PDF';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "BillingStageStatus" ADD VALUE 'READY';
ALTER TYPE "BillingStageStatus" ADD VALUE 'PARTLY_PAID';

-- AlterTable
ALTER TABLE "CashEntry" ADD COLUMN     "billedInvoiceId" UUID;

-- AlterTable
ALTER TABLE "ProjectBillingStage" ADD COLUMN     "expectedDate" DATE,
ADD COLUMN     "milestoneId" UUID,
ADD COLUMN     "proofAttachmentIds" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "readyAt" TIMESTAMPTZ(3),
ADD COLUMN     "readyById" UUID,
ADD COLUMN     "readyNote" TEXT;

-- AlterTable
ALTER TABLE "TenantSettings" ADD COLUMN     "paymentTermsDays" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "pmCanRecordPayments" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "taxLabel" TEXT,
ADD COLUMN     "taxRatePercent" DECIMAL(5,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "BillingProgress" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "description" TEXT NOT NULL,
    "attachmentIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "billedInvoiceId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BillingProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "clientId" UUID,
    "number" TEXT,
    "type" "InvoiceType" NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "billingStageId" UUID,
    "issueDate" DATE,
    "dueDate" DATE,
    "subtotalPaisa" BIGINT NOT NULL DEFAULT 0,
    "taxPaisa" BIGINT NOT NULL DEFAULT 0,
    "taxLabel" TEXT,
    "taxRatePercent" DECIMAL(5,2),
    "totalPaisa" BIGINT NOT NULL DEFAULT 0,
    "paidPaisa" BIGINT NOT NULL DEFAULT 0,
    "pendingPaisa" BIGINT NOT NULL DEFAULT 0,
    "balancePaisa" BIGINT NOT NULL DEFAULT 0,
    "notes" TEXT,
    "forceNote" TEXT,
    "cancelReason" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelledById" UUID,
    "pdfAttachmentId" UUID,
    "createdById" UUID,
    "issuedById" UUID,
    "issuedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,3),
    "unit" TEXT,
    "ratePaisa" BIGINT,
    "amountPaisa" BIGINT NOT NULL,
    "sourceType" "InvoiceLineSource" NOT NULL,
    "sourceId" UUID,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientPayment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "clientId" UUID,
    "number" TEXT NOT NULL,
    "receivedOn" DATE NOT NULL,
    "amountPaisa" BIGINT NOT NULL,
    "method" "ClientPaymentMethod" NOT NULL,
    "bankName" TEXT,
    "reference" TEXT,
    "chequeNo" TEXT,
    "chequeDate" DATE,
    "status" "ClientPaymentStatus" NOT NULL,
    "whtDeductedPaisa" BIGINT NOT NULL DEFAULT 0,
    "receivedById" UUID,
    "attachmentId" UUID,
    "receiptAttachmentId" UUID,
    "note" TEXT,
    "bounceReason" TEXT,
    "clearedAt" TIMESTAMPTZ(3),
    "bouncedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ClientPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAllocation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "amountPaisa" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingEvent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "type" "BillingEventType" NOT NULL,
    "refType" TEXT NOT NULL,
    "refId" UUID NOT NULL,
    "details" JSONB,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),

    CONSTRAINT "BillingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillingProgress_tenantId_projectId_date_idx" ON "BillingProgress"("tenantId", "projectId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "BillingProgress_tenantId_id_key" ON "BillingProgress"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_projectId_status_idx" ON "Invoice"("tenantId", "projectId", "status");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_status_dueDate_idx" ON "Invoice"("tenantId", "status", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_tenantId_id_key" ON "Invoice"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_tenantId_number_key" ON "Invoice"("tenantId", "number");

-- CreateIndex
CREATE INDEX "InvoiceLine_tenantId_invoiceId_idx" ON "InvoiceLine"("tenantId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceLine_tenantId_id_key" ON "InvoiceLine"("tenantId", "id");

-- CreateIndex
CREATE INDEX "ClientPayment_tenantId_projectId_receivedOn_idx" ON "ClientPayment"("tenantId", "projectId", "receivedOn");

-- CreateIndex
CREATE UNIQUE INDEX "ClientPayment_tenantId_id_key" ON "ClientPayment"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ClientPayment_tenantId_number_key" ON "ClientPayment"("tenantId", "number");

-- CreateIndex
CREATE INDEX "PaymentAllocation_tenantId_invoiceId_idx" ON "PaymentAllocation"("tenantId", "invoiceId");

-- CreateIndex
CREATE INDEX "PaymentAllocation_tenantId_paymentId_idx" ON "PaymentAllocation"("tenantId", "paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAllocation_tenantId_id_key" ON "PaymentAllocation"("tenantId", "id");

-- CreateIndex
CREATE INDEX "BillingEvent_tenantId_resolvedAt_idx" ON "BillingEvent"("tenantId", "resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingEvent_tenantId_id_key" ON "BillingEvent"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BillingEvent_tenantId_type_refId_key" ON "BillingEvent"("tenantId", "type", "refId");

-- AddForeignKey
ALTER TABLE "BillingProgress" ADD CONSTRAINT "BillingProgress_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingProgress" ADD CONSTRAINT "BillingProgress_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_clientId_fkey" FOREIGN KEY ("tenantId", "clientId") REFERENCES "Client"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_billingStageId_fkey" FOREIGN KEY ("tenantId", "billingStageId") REFERENCES "ProjectBillingStage"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_tenantId_invoiceId_fkey" FOREIGN KEY ("tenantId", "invoiceId") REFERENCES "Invoice"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientPayment" ADD CONSTRAINT "ClientPayment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientPayment" ADD CONSTRAINT "ClientPayment_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClientPayment" ADD CONSTRAINT "ClientPayment_tenantId_clientId_fkey" FOREIGN KEY ("tenantId", "clientId") REFERENCES "Client"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_tenantId_paymentId_fkey" FOREIGN KEY ("tenantId", "paymentId") REFERENCES "ClientPayment"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_tenantId_invoiceId_fkey" FOREIGN KEY ("tenantId", "invoiceId") REFERENCES "Invoice"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "BillingEvent" ADD CONSTRAINT "BillingEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingEvent" ADD CONSTRAINT "BillingEvent_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- Row-level security (tenant isolation) + app_user access
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['BillingProgress', 'Invoice', 'InvoiceLine', 'ClientPayment', 'PaymentAllocation', 'BillingEvent']
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

-- Draft invoices (and their lines) and unbilled progress can be deleted.
GRANT SELECT, INSERT, UPDATE, DELETE ON "BillingProgress", "Invoice", "InvoiceLine" TO app_user;
-- Payments are locked once recorded (only the cheque status changes); never deleted.
GRANT SELECT, INSERT, UPDATE ON "ClientPayment", "BillingEvent" TO app_user;
-- Allocations are append-only (a bounced cheque's allocations stop counting, they are not removed).
GRANT SELECT, INSERT ON "PaymentAllocation" TO app_user;
