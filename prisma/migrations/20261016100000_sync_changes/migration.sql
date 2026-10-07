-- CreateEnum
CREATE TYPE "SyncOp" AS ENUM ('INSERT', 'UPDATE', 'DELETE');

-- CreateTable
CREATE TABLE "SyncChange" (
    "seq" BIGSERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "tableName" TEXT NOT NULL,
    "rowId" UUID NOT NULL,
    "op" "SyncOp" NOT NULL,
    "projectId" UUID,
    "userId" UUID,
    "changedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncChange_pkey" PRIMARY KEY ("seq")
);

-- CreateTable
CREATE TABLE "SyncWatermark" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "prunedThroughSeq" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SyncWatermark_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SyncChange_tenantId_seq_idx" ON "SyncChange"("tenantId", "seq");

-- CreateIndex
CREATE INDEX "SyncChange_changedAt_idx" ON "SyncChange"("changedAt");


-- ─── Change tracking ────────────────────────────────────────────────────────
-- sync_track(logical table, id column, project column, user column): records one SyncChange per
-- row change. A child row (TG_ARGV[0] differs from the real table) is recorded as an UPDATE of its
-- parent. SECURITY DEFINER (owned by the migration role) so app_user never writes SyncChange itself.
CREATE OR REPLACE FUNCTION sync_track() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r jsonb;
  o text := TG_OP;
BEGIN
  IF TG_OP = 'DELETE' THEN r := to_jsonb(OLD); ELSE r := to_jsonb(NEW); END IF;
  IF TG_ARGV[0] <> TG_TABLE_NAME THEN o := 'UPDATE'; END IF;
  INSERT INTO "SyncChange" ("tenantId", "tableName", "rowId", "op", "projectId", "userId")
  VALUES (
    (r ->> 'tenantId')::uuid,
    TG_ARGV[0],
    (r ->> TG_ARGV[1])::uuid,
    o::"SyncOp",
    NULLIF(r ->> NULLIF(TG_ARGV[2], ''), '')::uuid,
    NULLIF(r ->> NULLIF(TG_ARGV[3], ''), '')::uuid
  );
  RETURN NULL;
END
$$;

DO $$
DECLARE
  t text[];
BEGIN
  FOREACH t SLICE 1 IN ARRAY ARRAY[
    -- real table, logical table, id column, project column, user column
    ['Project', 'Project', 'id', 'id', ''],
    ['UserProjectAccess', 'UserProjectAccess', 'projectId', 'projectId', 'userId'],
    ['StockLocation', 'StockLocation', 'id', 'projectId', ''],
    ['Material', 'Material', 'id', '', ''],
    ['Worker', 'Worker', 'id', '', ''],
    ['ProjectWorker', 'ProjectWorker', 'id', 'projectId', ''],
    ['SubcontractAssignment', 'SubcontractAssignment', 'id', 'projectId', ''],
    ['Attendance', 'Attendance', 'id', 'projectId', ''],
    ['WageSettlement', 'WageSettlement', 'id', 'projectId', ''],
    ['WageSettlementLine', 'WageSettlement', 'settlementId', '', ''],
    ['Advance', 'Advance', 'id', 'projectId', ''],
    ['WorkMeasurement', 'WorkMeasurement', 'id', 'projectId', ''],
    ['Dispatch', 'Dispatch', 'id', '', ''],
    ['DispatchItem', 'Dispatch', 'dispatchId', '', ''],
    ['Purchase', 'Purchase', 'id', 'projectId', ''],
    ['PurchaseItem', 'Purchase', 'purchaseId', '', ''],
    ['OwnerDelivery', 'OwnerDelivery', 'id', 'projectId', ''],
    ['OwnerDeliveryItem', 'OwnerDelivery', 'deliveryId', '', ''],
    ['MaterialUsage', 'MaterialUsage', 'id', 'projectId', ''],
    ['MaterialUsageItem', 'MaterialUsage', 'usageId', '', ''],
    ['StockMovement', 'SiteStock', 'locationId', '', ''],
    ['StockCount', 'StockCount', 'id', '', ''],
    ['StockCountItem', 'StockCount', 'countId', '', ''],
    ['DailyLog', 'DailyLog', 'id', 'projectId', 'createdById'],
    ['CashAccount', 'CashAccount', 'id', '', 'holderUserId'],
    ['CashEntry', 'CashEntry', 'id', 'projectId', ''],
    ['TopupRequest', 'TopupRequest', 'id', '', ''],
    ['TenantSettings', 'TenantSettings', 'tenantId', '', ''],
    ['CompanyHoliday', 'CompanyHoliday', 'id', '', ''],
    ['Notification', 'Notification', 'id', 'projectId', 'userId']
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER sync_track AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION sync_track(%L, %L, %L, %L)',
      t[1], t[2], t[3], t[4], t[5]
    );
  END LOOP;
END
$$;

-- Row-level security: a company only ever reads its own changes; app_user may only read.
ALTER TABLE "SyncChange" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SyncChange" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SyncChange"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT ON "SyncChange" TO app_user;

-- Platform-level watermark (no tenant): app_user reads it to know when a device must resync.
INSERT INTO "SyncWatermark" ("id", "prunedThroughSeq", "updatedAt") VALUES (1, 0, CURRENT_TIMESTAMP);
GRANT SELECT ON "SyncWatermark" TO app_user;
