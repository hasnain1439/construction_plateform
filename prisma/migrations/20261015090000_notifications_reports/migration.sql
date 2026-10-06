-- CreateEnum
CREATE TYPE "NotificationSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('DISPATCH_CREATED', 'SHORTAGE_CREATED', 'LOW_STOCK', 'PURCHASE_PENDING_RATE', 'SETTLEMENT_SUBMITTED', 'SETTLEMENT_RETURNED', 'EXPENSE_PENDING_APPROVAL', 'TOPUP_REQUESTED', 'FLOAT_SENT', 'MEASUREMENT_RECORDED', 'SUBCONTRACTOR_OVERPAID', 'INVOICE_OVERDUE', 'CHEQUE_BOUNCED', 'STAGE_READY_UNBILLED', 'PREVIOUS_STAGE_UNPAID', 'SUBSCRIPTION_RENEWAL', 'SUBSCRIPTION_PAYMENT_APPROVED', 'SUBSCRIPTION_PAYMENT_REJECTED', 'INVITE_ACCEPTED');

-- AlterEnum
ALTER TYPE "AttachmentKind" ADD VALUE 'REPORT';

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "severity" "NotificationSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "projectId" UUID,
    "refType" TEXT NOT NULL,
    "refId" UUID NOT NULL,
    "actionUrl" TEXT,
    "readAt" TIMESTAMPTZ(3),
    "smsSentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_tenantId_userId_readAt_createdAt_idx" ON "Notification"("tenantId", "userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_tenantId_type_refId_userId_createdAt_idx" ON "Notification"("tenantId", "type", "refId", "userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_tenantId_id_key" ON "Notification"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- Row-level security (tenant isolation) + app_user access
ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Notification" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Notification"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Notifications are only marked read (never edited otherwise or deleted by the app).
GRANT SELECT, INSERT, UPDATE ON "Notification" TO app_user;
