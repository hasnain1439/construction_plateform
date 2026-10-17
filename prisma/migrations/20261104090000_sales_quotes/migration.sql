-- Step 12 · Quotations / sales pipeline.
--
-- Tenant tables (ENABLE + FORCE RLS, tenant_isolation, GRANTs to app_user, composite FKs):
--   "Quote"         (Q-YYYY-NNNN per company, client, status DRAFT / SENT / NEGOTIATION / WON / LOST /
--                   EXPIRED, validity, lost reason, won project, latest price in paisa)
--   "QuoteRevision" (inputs + quick-mode engine result, cost / price / margin in paisa, payment stages)
-- Quote."wonProjectId" has no FK on purpose: the DRAFT project made by "Mark as Won" may be deleted
-- (Mark as Won then makes a new one). Numbers come from "TenantCounter" (key "Q-YYYY").
-- The company validity setting already exists ("TenantSettings"."quoteValidityDays", default 15).


-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('DRAFT', 'SENT', 'NEGOTIATION', 'WON', 'LOST', 'EXPIRED');

-- CreateEnum
CREATE TYPE "QuoteLostReason" AS ENUM ('COMPETITOR_CHEAPER', 'CLIENT_POSTPONED', 'SELF_BUILD', 'OTHER');

-- CreateTable
CREATE TABLE "Quote" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "clientId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "siteAddress" TEXT,
    "city" TEXT,
    "status" "QuoteStatus" NOT NULL DEFAULT 'DRAFT',
    "validUntil" DATE NOT NULL,
    "notes" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "contractType" "ContractType" NOT NULL,
    "coveredAreaSqft" DECIMAL(10,2) NOT NULL,
    "pricePaisa" BIGINT NOT NULL,
    "perSqftPaisa" BIGINT,
    "sentAt" TIMESTAMPTZ(3),
    "lastActivityAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "wonAt" TIMESTAMPTZ(3),
    "wonProjectId" UUID,
    "lostAt" TIMESTAMPTZ(3),
    "lostReason" "QuoteLostReason",
    "lostNote" TEXT,
    "expiredAt" TIMESTAMPTZ(3),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteRevision" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "quoteId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "inputs" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "paymentStages" JSONB NOT NULL,
    "paymentTemplateId" UUID,
    "paymentTemplateName" TEXT,
    "contractType" "ContractType" NOT NULL,
    "coveredAreaSqft" DECIMAL(10,2) NOT NULL,
    "directCostPaisa" BIGINT NOT NULL,
    "overheadPaisa" BIGINT NOT NULL,
    "contingencyPaisa" BIGINT NOT NULL,
    "costPaisa" BIGINT NOT NULL,
    "finishingAllowancePaisa" BIGINT NOT NULL DEFAULT 0,
    "computedPricePaisa" BIGINT,
    "pricePaisa" BIGINT NOT NULL,
    "perSqftPaisa" BIGINT,
    "marginPercent" DECIMAL(5,2) NOT NULL,
    "finishingAllowancePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "marginPaisa" BIGINT NOT NULL,
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuoteRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Quote_tenantId_status_idx" ON "Quote"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Quote_tenantId_clientId_idx" ON "Quote"("tenantId", "clientId");

-- CreateIndex
CREATE INDEX "Quote_tenantId_createdAt_idx" ON "Quote"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_tenantId_id_key" ON "Quote"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_tenantId_number_key" ON "Quote"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteRevision_tenantId_id_key" ON "QuoteRevision"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteRevision_tenantId_quoteId_revision_key" ON "QuoteRevision"("tenantId", "quoteId", "revision");

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_tenantId_clientId_fkey" FOREIGN KEY ("tenantId", "clientId") REFERENCES "Client"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "QuoteRevision" ADD CONSTRAINT "QuoteRevision_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteRevision" ADD CONSTRAINT "QuoteRevision_tenantId_quoteId_fkey" FOREIGN KEY ("tenantId", "quoteId") REFERENCES "Quote"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteRevision" ADD CONSTRAINT "QuoteRevision_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- Row-level security on the tenant tables
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Quote', 'QuoteRevision']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING ("tenantId" = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK ("tenantId" = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t);
  END LOOP;
END
$$;
