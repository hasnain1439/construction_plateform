-- CreateEnum
CREATE TYPE "WeekDay" AS ENUM ('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('FULL', 'HALF', 'ABSENT');

-- CreateEnum
CREATE TYPE "SubcontractRateType" AS ENUM ('PER_SQFT', 'PER_TON', 'PER_BRICK', 'PER_RFT', 'PER_CFT', 'LUMPSUM');

-- CreateEnum
CREATE TYPE "MeasurementStatus" AS ENUM ('RECORDED', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PayeeType" AS ENUM ('WORKER', 'SUBCONTRACTOR');

-- CreateEnum
CREATE TYPE "LaborPaidFrom" AS ENUM ('SITE_CASH', 'OFFICE_CASH', 'BANK', 'JAZZCASH', 'EASYPAISA');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'RETURNED');

-- CreateEnum
CREATE TYPE "LinePaymentStatus" AS ENUM ('UNPAID', 'PAID');

-- CreateEnum
CREATE TYPE "SubcontractEntryType" AS ENUM ('WORK_VALUE', 'ADVANCE', 'RUNNING_PAYMENT', 'DEDUCTION', 'RETENTION_RELEASE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "CashEntryType" AS ENUM ('FLOAT_IN', 'EXPENSE', 'PESHGI', 'WAGE_PAYMENT', 'SUBCONTRACT_PAYMENT', 'PURCHASE', 'HANDOVER_OUT', 'HANDOVER_IN', 'COUNT_ADJUSTMENT', 'REFUND_IN');

-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('TEA_WATER', 'TRANSPORT', 'UNLOADING', 'FUEL', 'SMALL_TOOLS', 'URGENT_MATERIAL', 'OWNER_PURCHASE', 'REPAIRS', 'OTHER');

-- CreateEnum
CREATE TYPE "CostBucket" AS ENUM ('OVERHEAD', 'LABOR', 'MATERIAL', 'EQUIPMENT', 'RECOVERABLE_FROM_OWNER');

-- CreateEnum
CREATE TYPE "CashEntryStatus" AS ENUM ('PENDING_ACK', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'POSTED');

-- CreateEnum
CREATE TYPE "TopupStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "FloatMethod" AS ENUM ('CASH', 'BANK', 'JAZZCASH', 'EASYPAISA');

-- AlterTable
ALTER TABLE "TenantSettings" ADD COLUMN     "hoursPerDay" DECIMAL(4,2) NOT NULL DEFAULT 8,
ADD COLUMN     "overtimeMultiplier" DECIMAL(4,2),
ADD COLUMN     "settlementWeekStart" "WeekDay" NOT NULL DEFAULT 'MONDAY',
ADD COLUMN     "subcontractPaymentsByPm" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "workingDays" "WeekDay"[] DEFAULT ARRAY['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']::"WeekDay"[];

-- CreateTable
CREATE TABLE "ProjectWorker" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "dailyRatePaisa" BIGINT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ProjectWorker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubcontractAssignment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "subcontractorId" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "rateType" "SubcontractRateType" NOT NULL,
    "ratePaisa" BIGINT,
    "contractValuePaisa" BIGINT,
    "retentionPercent" DECIMAL(5,2) NOT NULL DEFAULT 5,
    "progressPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "startDate" DATE NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SubcontractAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attendance" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "overtimeHours" DECIMAL(4,2) NOT NULL DEFAULT 0,
    "note" TEXT,
    "markedById" UUID,
    "clientId" UUID,
    "deviceCreatedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkMeasurement" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "assignmentId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit" TEXT NOT NULL,
    "attachmentIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "status" "MeasurementStatus" NOT NULL DEFAULT 'RECORDED',
    "verifiedById" UUID,
    "verifiedAt" TIMESTAMPTZ(3),
    "note" TEXT,
    "clientId" UUID,
    "deviceCreatedAt" TIMESTAMPTZ(3),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WorkMeasurement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Advance" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "payeeType" "PayeeType" NOT NULL,
    "workerId" UUID,
    "assignmentId" UUID,
    "amountPaisa" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "paidFrom" "LaborPaidFrom" NOT NULL,
    "cashAccountId" UUID,
    "reference" TEXT,
    "note" TEXT,
    "clientId" UUID,
    "deviceCreatedAt" TIMESTAMPTZ(3),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Advance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WageSettlement" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "weekStart" DATE NOT NULL,
    "weekEnd" DATE NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'DRAFT',
    "grossPaisa" BIGINT NOT NULL DEFAULT 0,
    "advancePaisa" BIGINT NOT NULL DEFAULT 0,
    "netPaisa" BIGINT NOT NULL DEFAULT 0,
    "paidPaisa" BIGINT NOT NULL DEFAULT 0,
    "submittedById" UUID,
    "submittedAt" TIMESTAMPTZ(3),
    "approvedById" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "returnComment" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WageSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WageSettlementLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "settlementId" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "fullDays" INTEGER NOT NULL,
    "halfDays" INTEGER NOT NULL,
    "daysWorked" DECIMAL(5,1) NOT NULL,
    "dailyRatePaisa" BIGINT NOT NULL,
    "overtimeHours" DECIMAL(6,2) NOT NULL,
    "overtimePaisa" BIGINT NOT NULL,
    "grossPaisa" BIGINT NOT NULL,
    "advanceAdjustedPaisa" BIGINT NOT NULL,
    "advanceOverride" BOOLEAN NOT NULL DEFAULT false,
    "overrideNote" TEXT,
    "netPaisa" BIGINT NOT NULL,
    "paymentStatus" "LinePaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "paidFrom" "LaborPaidFrom",
    "paidAt" TIMESTAMPTZ(3),
    "paidById" UUID,
    "cashEntryId" UUID,

    CONSTRAINT "WageSettlementLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementAdvance" (
    "tenantId" UUID NOT NULL,
    "lineId" UUID NOT NULL,
    "advanceId" UUID NOT NULL,
    "amountPaisa" BIGINT NOT NULL,

    CONSTRAINT "SettlementAdvance_pkey" PRIMARY KEY ("lineId","advanceId")
);

-- CreateTable
CREATE TABLE "SubcontractLedgerEntry" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "assignmentId" UUID NOT NULL,
    "type" "SubcontractEntryType" NOT NULL,
    "amountPaisa" BIGINT NOT NULL,
    "refType" TEXT,
    "refId" UUID,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubcontractLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashAccount" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "holderUserId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CashAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashEntry" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "projectId" UUID,
    "type" "CashEntryType" NOT NULL,
    "amountPaisa" BIGINT NOT NULL,
    "category" "ExpenseCategory",
    "costBucket" "CostBucket",
    "description" TEXT NOT NULL,
    "attachmentId" UUID,
    "status" "CashEntryStatus" NOT NULL,
    "method" "FloatMethod",
    "reference" TEXT,
    "approvedById" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "reviewNote" TEXT,
    "recoverableFromHolder" BOOLEAN NOT NULL DEFAULT false,
    "refType" TEXT,
    "refId" UUID,
    "clientId" UUID,
    "deviceCreatedAt" TIMESTAMPTZ(3),
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CashEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TopupRequest" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "amountPaisa" BIGINT NOT NULL,
    "note" TEXT,
    "status" "TopupStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionNote" TEXT,
    "floatEntryId" UUID,
    "clientId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TopupRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashCount" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "systemPaisa" BIGINT NOT NULL,
    "countedPaisa" BIGINT NOT NULL,
    "differencePaisa" BIGINT NOT NULL,
    "note" TEXT,
    "adjustmentEntryId" UUID,
    "countedById" UUID,
    "countedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CashCount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectWorker_tenantId_projectId_idx" ON "ProjectWorker"("tenantId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectWorker_tenantId_id_key" ON "ProjectWorker"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectWorker_projectId_workerId_key" ON "ProjectWorker"("projectId", "workerId");

-- CreateIndex
CREATE INDEX "SubcontractAssignment_tenantId_projectId_idx" ON "SubcontractAssignment"("tenantId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "SubcontractAssignment_tenantId_id_key" ON "SubcontractAssignment"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Attendance_tenantId_projectId_date_idx" ON "Attendance"("tenantId", "projectId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Attendance_tenantId_id_key" ON "Attendance"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Attendance_projectId_workerId_date_key" ON "Attendance"("projectId", "workerId", "date");

-- CreateIndex
CREATE INDEX "WorkMeasurement_tenantId_projectId_date_idx" ON "WorkMeasurement"("tenantId", "projectId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "WorkMeasurement_tenantId_id_key" ON "WorkMeasurement"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WorkMeasurement_tenantId_clientId_key" ON "WorkMeasurement"("tenantId", "clientId");

-- CreateIndex
CREATE INDEX "Advance_tenantId_projectId_date_idx" ON "Advance"("tenantId", "projectId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Advance_tenantId_id_key" ON "Advance"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Advance_tenantId_clientId_key" ON "Advance"("tenantId", "clientId");

-- CreateIndex
CREATE INDEX "WageSettlement_tenantId_status_idx" ON "WageSettlement"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WageSettlement_tenantId_id_key" ON "WageSettlement"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WageSettlement_projectId_weekStart_key" ON "WageSettlement"("projectId", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "WageSettlementLine_tenantId_id_key" ON "WageSettlementLine"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WageSettlementLine_settlementId_workerId_key" ON "WageSettlementLine"("settlementId", "workerId");

-- CreateIndex
CREATE INDEX "SettlementAdvance_tenantId_advanceId_idx" ON "SettlementAdvance"("tenantId", "advanceId");

-- CreateIndex
CREATE INDEX "SubcontractLedgerEntry_tenantId_assignmentId_occurredAt_idx" ON "SubcontractLedgerEntry"("tenantId", "assignmentId", "occurredAt");

-- CreateIndex
CREATE INDEX "CashAccount_tenantId_holderUserId_idx" ON "CashAccount"("tenantId", "holderUserId");

-- CreateIndex
CREATE UNIQUE INDEX "CashAccount_tenantId_id_key" ON "CashAccount"("tenantId", "id");

-- CreateIndex
CREATE INDEX "CashEntry_tenantId_accountId_occurredAt_idx" ON "CashEntry"("tenantId", "accountId", "occurredAt");

-- CreateIndex
CREATE INDEX "CashEntry_tenantId_projectId_occurredAt_idx" ON "CashEntry"("tenantId", "projectId", "occurredAt");

-- CreateIndex
CREATE INDEX "CashEntry_tenantId_status_idx" ON "CashEntry"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CashEntry_tenantId_id_key" ON "CashEntry"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CashEntry_tenantId_clientId_key" ON "CashEntry"("tenantId", "clientId");

-- CreateIndex
CREATE INDEX "TopupRequest_tenantId_status_idx" ON "TopupRequest"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TopupRequest_tenantId_id_key" ON "TopupRequest"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TopupRequest_tenantId_clientId_key" ON "TopupRequest"("tenantId", "clientId");

-- CreateIndex
CREATE INDEX "CashCount_tenantId_accountId_countedAt_idx" ON "CashCount"("tenantId", "accountId", "countedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CashCount_tenantId_id_key" ON "CashCount"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "ProjectWorker" ADD CONSTRAINT "ProjectWorker_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectWorker" ADD CONSTRAINT "ProjectWorker_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ProjectWorker" ADD CONSTRAINT "ProjectWorker_tenantId_workerId_fkey" FOREIGN KEY ("tenantId", "workerId") REFERENCES "Worker"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "SubcontractAssignment" ADD CONSTRAINT "SubcontractAssignment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubcontractAssignment" ADD CONSTRAINT "SubcontractAssignment_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "SubcontractAssignment" ADD CONSTRAINT "SubcontractAssignment_tenantId_subcontractorId_fkey" FOREIGN KEY ("tenantId", "subcontractorId") REFERENCES "Subcontractor"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_tenantId_workerId_fkey" FOREIGN KEY ("tenantId", "workerId") REFERENCES "Worker"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "WorkMeasurement" ADD CONSTRAINT "WorkMeasurement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkMeasurement" ADD CONSTRAINT "WorkMeasurement_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "WorkMeasurement" ADD CONSTRAINT "WorkMeasurement_tenantId_assignmentId_fkey" FOREIGN KEY ("tenantId", "assignmentId") REFERENCES "SubcontractAssignment"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Advance" ADD CONSTRAINT "Advance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Advance" ADD CONSTRAINT "Advance_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Advance" ADD CONSTRAINT "Advance_tenantId_workerId_fkey" FOREIGN KEY ("tenantId", "workerId") REFERENCES "Worker"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Advance" ADD CONSTRAINT "Advance_tenantId_assignmentId_fkey" FOREIGN KEY ("tenantId", "assignmentId") REFERENCES "SubcontractAssignment"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "WageSettlement" ADD CONSTRAINT "WageSettlement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WageSettlement" ADD CONSTRAINT "WageSettlement_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "WageSettlementLine" ADD CONSTRAINT "WageSettlementLine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WageSettlementLine" ADD CONSTRAINT "WageSettlementLine_tenantId_settlementId_fkey" FOREIGN KEY ("tenantId", "settlementId") REFERENCES "WageSettlement"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WageSettlementLine" ADD CONSTRAINT "WageSettlementLine_tenantId_workerId_fkey" FOREIGN KEY ("tenantId", "workerId") REFERENCES "Worker"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "SettlementAdvance" ADD CONSTRAINT "SettlementAdvance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementAdvance" ADD CONSTRAINT "SettlementAdvance_tenantId_lineId_fkey" FOREIGN KEY ("tenantId", "lineId") REFERENCES "WageSettlementLine"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementAdvance" ADD CONSTRAINT "SettlementAdvance_tenantId_advanceId_fkey" FOREIGN KEY ("tenantId", "advanceId") REFERENCES "Advance"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "SubcontractLedgerEntry" ADD CONSTRAINT "SubcontractLedgerEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubcontractLedgerEntry" ADD CONSTRAINT "SubcontractLedgerEntry_tenantId_assignmentId_fkey" FOREIGN KEY ("tenantId", "assignmentId") REFERENCES "SubcontractAssignment"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CashAccount" ADD CONSTRAINT "CashAccount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashAccount" ADD CONSTRAINT "CashAccount_tenantId_holderUserId_fkey" FOREIGN KEY ("tenantId", "holderUserId") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CashEntry" ADD CONSTRAINT "CashEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashEntry" ADD CONSTRAINT "CashEntry_tenantId_accountId_fkey" FOREIGN KEY ("tenantId", "accountId") REFERENCES "CashAccount"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CashEntry" ADD CONSTRAINT "CashEntry_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "TopupRequest" ADD CONSTRAINT "TopupRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopupRequest" ADD CONSTRAINT "TopupRequest_tenantId_accountId_fkey" FOREIGN KEY ("tenantId", "accountId") REFERENCES "CashAccount"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CashCount" ADD CONSTRAINT "CashCount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashCount" ADD CONSTRAINT "CashCount_tenantId_accountId_fkey" FOREIGN KEY ("tenantId", "accountId") REFERENCES "CashAccount"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;



-- One active cash account per holder
CREATE UNIQUE INDEX "CashAccount_one_active_per_holder" ON "CashAccount"("tenantId", "holderUserId") WHERE "isActive";

-- Row-level security (tenant isolation) + app_user access
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ProjectWorker', 'SubcontractAssignment', 'Attendance', 'WorkMeasurement', 'Advance',
    'WageSettlement', 'WageSettlementLine', 'SettlementAdvance', 'SubcontractLedgerEntry',
    'CashAccount', 'CashEntry', 'TopupRequest', 'CashCount'
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
  "ProjectWorker", "SubcontractAssignment", "Attendance", "WorkMeasurement", "Advance",
  "WageSettlement", "WageSettlementLine", "SettlementAdvance", "CashAccount", "TopupRequest", "CashCount"
TO app_user;
-- Cash entries change status (ack / approve / reject) but are never deleted.
GRANT SELECT, INSERT, UPDATE ON "CashEntry" TO app_user;
-- The sub-contract running account is append-only.
GRANT SELECT, INSERT ON "SubcontractLedgerEntry" TO app_user;
