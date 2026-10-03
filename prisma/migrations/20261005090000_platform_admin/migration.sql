-- Phase 1 step 3B: platform admin console.
-- Hand-edited from `prisma migrate diff`: PlatformHoliday.date is RENAMED (data kept).

-- Plans: display order
ALTER TABLE "Plan" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- Platform holidays: single date → range + type
DROP INDEX "PlatformHoliday_date_name_key";
ALTER TABLE "PlatformHoliday" RENAME COLUMN "date" TO "startDate";
ALTER TABLE "PlatformHoliday"
  ADD COLUMN "endDate" DATE,
  ADD COLUMN "type" "HolidayType" NOT NULL DEFAULT 'NON_WORKING',
  ADD COLUMN "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE UNIQUE INDEX "PlatformHoliday_startDate_name_key" ON "PlatformHoliday"("startDate", "name");

-- Payments: who reviewed them
ALTER TABLE "SubscriptionPayment" ADD COLUMN "reviewedById" UUID, ADD COLUMN "reviewNote" TEXT;
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "PlatformAdmin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Background job bookkeeping (platform-level: no tenantId, no RLS).
-- app_admin gets access through the default privileges set in the init migration;
-- app_user gets none.
CREATE TABLE "JobRun" (
    "name" TEXT NOT NULL,
    "lastStartedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastFinishedAt" TIMESTAMPTZ(3),
    "lastStatus" TEXT NOT NULL,
    "lastError" TEXT,
    "lastResult" JSONB,
    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("name")
);
