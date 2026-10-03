-- Phase 1 step 2: attachments, company profile/settings/holidays, team management.
-- Hand-edited from `prisma migrate diff` so existing data is renamed, not dropped.
-- No new tables: RLS policies and app_user grants from the init migration still apply.

-- CreateEnum
CREATE TYPE "AttachmentKind" AS ENUM ('LOGO', 'PROFILE_PHOTO', 'SITE_PHOTO', 'RECEIPT', 'DOCUMENT', 'VOICE_NOTE');
CREATE TYPE "HolidayType" AS ENUM ('NON_WORKING', 'PARTIAL');

-- UserStatus: DISABLED → INACTIVE (keeps existing rows)
ALTER TYPE "UserStatus" RENAME VALUE 'DISABLED' TO 'INACTIVE';
ALTER TABLE "User" ADD COLUMN "deactivatedAt" TIMESTAMPTZ(3);

-- Attachment: kind replaces the stored url (URLs are now signed on demand)
ALTER TABLE "Attachment" ADD COLUMN "kind" "AttachmentKind" NOT NULL DEFAULT 'DOCUMENT';
ALTER TABLE "Attachment" ALTER COLUMN "kind" DROP DEFAULT;
ALTER TABLE "Attachment" DROP COLUMN "url";

-- CompanyHoliday: single date → date range + type
DROP INDEX "CompanyHoliday_tenantId_date_name_key";
ALTER TABLE "CompanyHoliday" RENAME COLUMN "date" TO "startDate";
ALTER TABLE "CompanyHoliday"
  ADD COLUMN "endDate" DATE,
  ADD COLUMN "type" "HolidayType" NOT NULL DEFAULT 'NON_WORKING';
CREATE UNIQUE INDEX "CompanyHoliday_tenantId_startDate_name_key" ON "CompanyHoliday"("tenantId", "startDate", "name");

-- Device: offline-sync status
ALTER TABLE "Device"
  ADD COLUMN "lastSyncAt" TIMESTAMPTZ(3),
  ADD COLUMN "pendingUploads" INTEGER NOT NULL DEFAULT 0;

-- Invitation: resend throttle + lookup by phone
ALTER TABLE "Invitation" ADD COLUMN "lastResentAt" TIMESTAMPTZ(3);
CREATE INDEX "Invitation_tenantId_phone_status_idx" ON "Invitation"("tenantId", "phone", "status");

-- Tenant: company profile; logo is an Attachment of the same tenant (composite FK)
ALTER TABLE "Tenant" DROP COLUMN "logoUrl",
  ADD COLUMN "ntn" TEXT,
  ADD COLUMN "address" TEXT,
  ADD COLUMN "phone" TEXT,
  ADD COLUMN "email" TEXT,
  ADD COLUMN "logoAttachmentId" UUID;
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_id_logoAttachmentId_fkey"
  FOREIGN KEY ("id", "logoAttachmentId") REFERENCES "Attachment"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- TenantSettings: business rules
ALTER TABLE "TenantSettings"
  ADD COLUMN "kharchaApprovalLimitPaisa" BIGINT NOT NULL DEFAULT 2500000,
  ADD COLUMN "overuseAlertPercent" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN "missingLogAlertTime" TEXT NOT NULL DEFAULT '18:00',
  ADD COLUMN "quoteValidityDays" INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN "taxEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pmCanSeeFinancials" BOOLEAN NOT NULL DEFAULT false;
