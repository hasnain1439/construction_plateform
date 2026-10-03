-- Phase 1 step 3A: subscription lifecycle (company side), manual payments with slips.
-- Hand-edited from `prisma migrate diff`: enum values and columns are RENAMED so existing
-- data is kept. No new tables, so RLS policies and grants from the init migration apply.

-- Enums ─────────────────────────────────────────────────────────────────────
ALTER TYPE "SubscriptionStatus" RENAME VALUE 'PAST_DUE' TO 'GRACE';
ALTER TYPE "SubscriptionStatus" RENAME VALUE 'EXPIRED' TO 'LAPSED';

ALTER TYPE "PaymentStatus" RENAME VALUE 'PENDING' TO 'PENDING_REVIEW';
ALTER TYPE "PaymentStatus" RENAME VALUE 'PAID' TO 'APPROVED';
ALTER TYPE "PaymentStatus" RENAME VALUE 'FAILED' TO 'REJECTED';

CREATE TYPE "PaymentMethod" AS ENUM ('JAZZCASH', 'EASYPAISA', 'RAAST', 'IBFT');
ALTER TYPE "AttachmentKind" ADD VALUE 'PAYMENT_SLIP';
ALTER TYPE "ProjectStatus" ADD VALUE 'READ_ONLY';

-- Plan ──────────────────────────────────────────────────────────────────────
ALTER TABLE "Plan" RENAME COLUMN "maxProjects" TO "maxActiveProjects";
ALTER TABLE "Plan" ADD COLUMN "features" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Subscription ──────────────────────────────────────────────────────────────
ALTER TABLE "Subscription"
  ADD COLUMN "currentPeriodStart" TIMESTAMPTZ(3),
  ADD COLUMN "graceEndsAt" TIMESTAMPTZ(3),
  ADD COLUMN "pendingPlanId" UUID,
  ADD COLUMN "pendingEffectiveOn" TIMESTAMPTZ(3),
  ADD COLUMN "keepActiveProjectIds" UUID[] DEFAULT ARRAY[]::UUID[],
  ADD COLUMN "lastReminderSentAt" TIMESTAMPTZ(3);
CREATE INDEX "Subscription_status_idx" ON "Subscription"("status");
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_pendingPlanId_fkey"
  FOREIGN KEY ("pendingPlanId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- SubscriptionPayment ───────────────────────────────────────────────────────
-- Nothing wrote this table before this step, so the new NOT NULL columns are safe.
ALTER TABLE "SubscriptionPayment" RENAME COLUMN "reference" TO "transactionId";
ALTER TABLE "SubscriptionPayment" RENAME COLUMN "paidAt" TO "reviewedAt";
ALTER TABLE "SubscriptionPayment" ALTER COLUMN "transactionId" SET NOT NULL;
ALTER TABLE "SubscriptionPayment" ALTER COLUMN "method" TYPE "PaymentMethod" USING (upper("method")::"PaymentMethod");
ALTER TABLE "SubscriptionPayment"
  ADD COLUMN "planId" UUID NOT NULL,
  ADD COLUMN "paidOn" DATE NOT NULL,
  ADD COLUMN "rejectReason" TEXT,
  ADD COLUMN "attachmentId" UUID,
  ADD COLUMN "submittedById" UUID,
  ADD COLUMN "receiptNo" TEXT,
  ALTER COLUMN "status" SET DEFAULT 'PENDING_REVIEW',
  ALTER COLUMN "periodStart" DROP NOT NULL,
  ALTER COLUMN "periodEnd" DROP NOT NULL;
CREATE UNIQUE INDEX "SubscriptionPayment_transactionId_key" ON "SubscriptionPayment"("transactionId");
CREATE UNIQUE INDEX "SubscriptionPayment_receiptNo_key" ON "SubscriptionPayment"("receiptNo");
CREATE INDEX "SubscriptionPayment_status_idx" ON "SubscriptionPayment"("status");
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_tenantId_attachmentId_fkey"
  FOREIGN KEY ("tenantId", "attachmentId") REFERENCES "Attachment"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_tenantId_submittedById_fkey"
  FOREIGN KEY ("tenantId", "submittedById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
