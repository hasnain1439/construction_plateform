-- Pilot · Part 7 — onboarding & data import:
--  * setup checklist state on TenantSettings (dismissed, rates reviewed),
--  * opening balances (one locked row per supplier / cash holder / material / worker; the money
--    itself goes into the normal ledgers: supplier ledger OPENING, cash entry OPENING, stock
--    movement OPENING_IN, worker Advance),
--  * "Try with demo data": isDemo tags + purge_demo_data(), which removes everything the demo
--    created (append-only ledgers included) in one call.

-- CreateEnum
CREATE TYPE "OpeningBalanceKind" AS ENUM ('SUPPLIER_UDHAAR', 'CASH_IN_HAND', 'STORE_STOCK', 'WORKER_PESHGI');

-- AlterEnum
ALTER TYPE "CashEntryType" ADD VALUE 'OPENING';

-- AlterEnum
ALTER TYPE "StockMovementType" ADD VALUE 'OPENING_IN';

-- AlterTable
ALTER TABLE "CashAccount" ADD COLUMN     "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "TenantSettings" ADD COLUMN     "onboardingDismissedAt" TIMESTAMPTZ(3),
ADD COLUMN     "onboardingDismissedById" UUID,
ADD COLUMN     "ratesReviewedAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Worker" ADD COLUMN     "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "OpeningBalance" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "kind" "OpeningBalanceKind" NOT NULL,
    "entityId" UUID NOT NULL,
    "projectId" UUID,
    "amountPaisa" BIGINT NOT NULL,
    "quantity" DECIMAL(14,3),
    "ratePaisa" BIGINT,
    "date" DATE NOT NULL,
    "note" TEXT,
    "refType" TEXT NOT NULL,
    "refId" UUID NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpeningBalance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OpeningBalance_tenantId_createdAt_idx" ON "OpeningBalance"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OpeningBalance_tenantId_kind_entityId_key" ON "OpeningBalance"("tenantId", "kind", "entityId");

-- AddForeignKey
ALTER TABLE "OpeningBalance" ADD CONSTRAINT "OpeningBalance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security + grants. Opening balances are written once and never changed (locked):
-- app_user may only read and insert them.
ALTER TABLE "OpeningBalance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OpeningBalance" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "OpeningBalance"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON "OpeningBalance" TO app_user;

-- purge_demo_data(): deletes the company's demo project and every row that hangs off it, plus the
-- demo client / supplier / workers / cash account, including rows in append-only ledgers that
-- app_user may not delete (StockMovement, SupplierLedgerEntry, CashEntry, SubcontractLedgerEntry,
-- PaymentAllocation). SECURITY DEFINER (owned by the migration role). The company is ALWAYS the
-- caller's own app.tenant_id (set by withTenant), never a parameter, and only demo-tagged data is
-- touched. The API first checks that no real data uses the demo (409 DEMO_IN_USE).
-- Returns the storage keys of deleted attachments so the API can remove the files.
CREATE OR REPLACE FUNCTION purge_demo_data() RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  t uuid := NULLIF(current_setting('app.tenant_id', true), '')::uuid;
  p uuid[]; l uuid[]; s uuid[]; w uuid[]; c uuid[]; a uuid[];
  inv uuid[]; cp uuid[]; ws uuid[]; adv uuid[]; sa uuid[]; pur uuid[]; att uuid[];
  keys text[];
BEGIN
  IF t IS NULL THEN RAISE EXCEPTION 'purge_demo_data: app.tenant_id is not set'; END IF;
  SELECT coalesce(array_agg(id), '{}') INTO p FROM "Project" WHERE "tenantId" = t AND "isDemo";
  SELECT coalesce(array_agg(id), '{}') INTO l FROM "StockLocation" WHERE "tenantId" = t AND "projectId" = ANY(p);
  SELECT coalesce(array_agg(id), '{}') INTO s FROM "Supplier" WHERE "tenantId" = t AND "isDemo";
  SELECT coalesce(array_agg(id), '{}') INTO w FROM "Worker" WHERE "tenantId" = t AND "isDemo";
  SELECT coalesce(array_agg(id), '{}') INTO c FROM "Client" WHERE "tenantId" = t AND "isDemo";
  SELECT coalesce(array_agg(id), '{}') INTO a FROM "CashAccount" WHERE "tenantId" = t AND "isDemo";

  -- Billing
  SELECT coalesce(array_agg(id), '{}') INTO inv FROM "Invoice" WHERE "tenantId" = t AND ("projectId" = ANY(p) OR "clientId" = ANY(c));
  SELECT coalesce(array_agg(id), '{}') INTO cp FROM "ClientPayment" WHERE "tenantId" = t AND ("projectId" = ANY(p) OR "clientId" = ANY(c));
  DELETE FROM "PaymentAllocation" WHERE "tenantId" = t AND ("invoiceId" = ANY(inv) OR "paymentId" = ANY(cp));
  DELETE FROM "ClientPayment" WHERE "tenantId" = t AND id = ANY(cp);
  DELETE FROM "InvoiceLine" WHERE "tenantId" = t AND "invoiceId" = ANY(inv);
  UPDATE "CashEntry" SET "billedInvoiceId" = NULL WHERE "tenantId" = t AND "billedInvoiceId" = ANY(inv);
  UPDATE "BillingProgress" SET "billedInvoiceId" = NULL WHERE "tenantId" = t AND "billedInvoiceId" = ANY(inv);
  DELETE FROM "Invoice" WHERE "tenantId" = t AND id = ANY(inv);
  DELETE FROM "BillingEvent" WHERE "tenantId" = t AND "projectId" = ANY(p);
  DELETE FROM "BillingProgress" WHERE "tenantId" = t AND "projectId" = ANY(p);

  -- Labour
  SELECT coalesce(array_agg(id), '{}') INTO ws FROM "WageSettlement" WHERE "tenantId" = t AND "projectId" = ANY(p);
  SELECT coalesce(array_agg(id), '{}') INTO adv FROM "Advance" WHERE "tenantId" = t AND ("projectId" = ANY(p) OR "workerId" = ANY(w));
  DELETE FROM "SettlementAdvance" WHERE "tenantId" = t AND ("advanceId" = ANY(adv)
    OR "lineId" IN (SELECT id FROM "WageSettlementLine" WHERE "tenantId" = t AND ("settlementId" = ANY(ws) OR "workerId" = ANY(w))));
  DELETE FROM "WageSettlementLine" WHERE "tenantId" = t AND ("settlementId" = ANY(ws) OR "workerId" = ANY(w));
  DELETE FROM "WageSettlement" WHERE "tenantId" = t AND id = ANY(ws);
  DELETE FROM "Advance" WHERE "tenantId" = t AND id = ANY(adv);
  SELECT coalesce(array_agg(id), '{}') INTO sa FROM "SubcontractAssignment" WHERE "tenantId" = t AND "projectId" = ANY(p);
  DELETE FROM "SubcontractLedgerEntry" WHERE "tenantId" = t AND "assignmentId" = ANY(sa);
  DELETE FROM "WorkMeasurement" WHERE "tenantId" = t AND ("projectId" = ANY(p) OR "assignmentId" = ANY(sa));
  DELETE FROM "SubcontractAssignment" WHERE "tenantId" = t AND id = ANY(sa);
  DELETE FROM "Attendance" WHERE "tenantId" = t AND ("projectId" = ANY(p) OR "workerId" = ANY(w));
  DELETE FROM "ProjectWorker" WHERE "tenantId" = t AND ("projectId" = ANY(p) OR "workerId" = ANY(w));

  -- Site cash
  DELETE FROM "CashCount" WHERE "tenantId" = t AND "accountId" = ANY(a);
  DELETE FROM "TopupRequest" WHERE "tenantId" = t AND "accountId" = ANY(a);
  DELETE FROM "CashEntry" WHERE "tenantId" = t AND ("projectId" = ANY(p) OR "accountId" = ANY(a));
  DELETE FROM "CashAccount" WHERE "tenantId" = t AND id = ANY(a);

  -- Material
  SELECT coalesce(array_agg(id), '{}') INTO pur FROM "Purchase"
   WHERE "tenantId" = t AND ("projectId" = ANY(p) OR "locationId" = ANY(l) OR "supplierId" = ANY(s));
  SELECT coalesce(array_agg(x), '{}') INTO att FROM (
    SELECT "challanAttachmentId" AS x FROM "Purchase" WHERE "tenantId" = t AND id = ANY(pur)
    UNION SELECT "billAttachmentId" FROM "Purchase" WHERE "tenantId" = t AND id = ANY(pur) AND "billAttachmentId" IS NOT NULL) q;
  DELETE FROM "Shortage" WHERE "tenantId" = t AND ("projectId" = ANY(p) OR "locationId" = ANY(l) OR "purchaseId" = ANY(pur));
  DELETE FROM "MaterialUsage" WHERE "tenantId" = t AND ("projectId" = ANY(p) OR "locationId" = ANY(l));
  DELETE FROM "OwnerDelivery" WHERE "tenantId" = t AND ("projectId" = ANY(p) OR "locationId" = ANY(l));
  DELETE FROM "StockCount" WHERE "tenantId" = t AND "locationId" = ANY(l);
  DELETE FROM "PurchaseReturn" WHERE "tenantId" = t AND ("purchaseId" = ANY(pur) OR "supplierId" = ANY(s) OR "locationId" = ANY(l));
  DELETE FROM "SupplierPayment" WHERE "tenantId" = t AND ("purchaseId" = ANY(pur) OR "projectId" = ANY(p) OR "supplierId" = ANY(s));
  DELETE FROM "SupplierLedgerEntry" WHERE "tenantId" = t AND ("projectId" = ANY(p) OR "supplierId" = ANY(s) OR "refId" = ANY(pur));
  DELETE FROM "Purchase" WHERE "tenantId" = t AND id = ANY(pur);
  DELETE FROM "PurchaseOrder" WHERE "tenantId" = t AND ("projectId" = ANY(p) OR "locationId" = ANY(l) OR "supplierId" = ANY(s));
  DELETE FROM "StockMovement" WHERE "tenantId" = t AND "locationId" = ANY(l);
  DELETE FROM "LowStockLevel" WHERE "tenantId" = t AND "locationId" = ANY(l);
  DELETE FROM "StockLocation" WHERE "tenantId" = t AND id = ANY(l);

  -- The rest of the project, then the demo master data
  DELETE FROM "DailyLog" WHERE "tenantId" = t AND "projectId" = ANY(p);
  DELETE FROM "Notification" WHERE "tenantId" = t AND "projectId" = ANY(p);
  DELETE FROM "OpeningBalance" WHERE "tenantId" = t AND ("projectId" = ANY(p) OR "entityId" = ANY(s || w));
  DELETE FROM "Project" WHERE "tenantId" = t AND id = ANY(p);
  DELETE FROM "Worker" WHERE "tenantId" = t AND id = ANY(w);
  DELETE FROM "Supplier" WHERE "tenantId" = t AND id = ANY(s);
  DELETE FROM "Client" WHERE "tenantId" = t AND id = ANY(c);

  -- Challan photos of the demo purchases
  SELECT coalesce(array_agg("storageKey"), '{}') INTO keys FROM "Attachment" WHERE "tenantId" = t AND id = ANY(att);
  DELETE FROM "Attachment" WHERE "tenantId" = t AND id = ANY(att);
  RETURN keys;
END
$$;
REVOKE ALL ON FUNCTION purge_demo_data() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_demo_data() TO app_user;
