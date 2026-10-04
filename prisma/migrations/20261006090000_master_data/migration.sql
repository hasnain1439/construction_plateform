-- Phase 1 step 4: master data (materials, quality categories, price list, labour rates,
-- suppliers, workers, sub-contractors, payment schedule templates).

-- CreateEnum
CREATE TYPE "MaterialSection" AS ENUM ('CIVIL', 'FINISHING');

-- CreateEnum
CREATE TYPE "SupplyCategory" AS ENUM ('GREY_STRUCTURE', 'FINISHING');

-- CreateEnum
CREATE TYPE "MaterialSource" AS ENUM ('PLATFORM', 'COMPANY');

-- CreateEnum
CREATE TYPE "LaborRateKind" AS ENUM ('DAILY', 'SUBCONTRACT');

-- CreateEnum
CREATE TYPE "LaborUnit" AS ENUM ('DAY', 'SQFT', 'TON', 'BRICK', 'RFT', 'LUMPSUM');

-- CreateEnum
CREATE TYPE "WorkerType" AS ENUM ('MISTRI', 'MISTRI_TILES', 'MAZDOOR', 'STEEL_FIXER_HELPER', 'CHOWKIDAR', 'OTHER');

-- CreateEnum
CREATE TYPE "BillingModel" AS ENUM ('STAGE_SCHEDULE', 'RUNNING_BILLS');

-- CreateTable
CREATE TABLE "MaterialGroup" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "section" "MaterialSection" NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MaterialGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformMaterial" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "unitDetail" TEXT,
    "altUnits" JSONB NOT NULL DEFAULT '[]',
    "supplyCategory" "SupplyCategory" NOT NULL,
    "usedByRulebook" BOOLEAN NOT NULL DEFAULT false,
    "rulebookKey" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Material" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "platformMaterialId" UUID,
    "groupId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "unitDetail" TEXT,
    "altUnits" JSONB NOT NULL DEFAULT '[]',
    "supplyCategory" "SupplyCategory" NOT NULL,
    "source" "MaterialSource" NOT NULL,
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "isCustomised" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Material_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QualityCategory" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "QualityCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialRate" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "materialId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "ratePaisa" BIGINT NOT NULL,
    "specification" TEXT,
    "effectiveFrom" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaterialRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LaborRate" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "kind" "LaborRateKind" NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "unit" "LaborUnit" NOT NULL,
    "ratePaisa" BIGINT NOT NULL,
    "overtimeMultiplier" DECIMAL(4,2),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LaborRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "phone" TEXT,
    "city" TEXT,
    "address" TEXT,
    "ntn" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierRate" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "materialId" UUID NOT NULL,
    "ratePaisa" BIGINT NOT NULL,
    "effectiveFrom" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Worker" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "WorkerType" NOT NULL,
    "phone" TEXT,
    "dailyRatePaisa" BIGINT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Worker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subcontractor" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "trade" TEXT NOT NULL,
    "phone" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Subcontractor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentScheduleTemplate" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "billingModel" "BillingModel" NOT NULL,
    "stages" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PaymentScheduleTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MaterialGroup_code_key" ON "MaterialGroup"("code");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformMaterial_name_key" ON "PlatformMaterial"("name");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformMaterial_rulebookKey_key" ON "PlatformMaterial"("rulebookKey");

-- CreateIndex
CREATE INDEX "PlatformMaterial_groupId_sortOrder_idx" ON "PlatformMaterial"("groupId", "sortOrder");

-- CreateIndex
CREATE INDEX "Material_tenantId_groupId_idx" ON "Material"("tenantId", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "Material_tenantId_id_key" ON "Material"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Material_tenantId_name_key" ON "Material"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Material_tenantId_platformMaterialId_key" ON "Material"("tenantId", "platformMaterialId");

-- CreateIndex
CREATE UNIQUE INDEX "QualityCategory_tenantId_id_key" ON "QualityCategory"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "QualityCategory_tenantId_code_key" ON "QualityCategory"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "QualityCategory_tenantId_name_key" ON "QualityCategory"("tenantId", "name");

-- CreateIndex
CREATE INDEX "MaterialRate_tenantId_materialId_categoryId_effectiveFrom_idx" ON "MaterialRate"("tenantId", "materialId", "categoryId", "effectiveFrom" DESC);

-- CreateIndex
CREATE INDEX "MaterialRate_tenantId_categoryId_effectiveFrom_idx" ON "MaterialRate"("tenantId", "categoryId", "effectiveFrom" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "LaborRate_tenantId_id_key" ON "LaborRate"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LaborRate_tenantId_kind_key_key" ON "LaborRate"("tenantId", "kind", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_tenantId_id_key" ON "Supplier"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_tenantId_name_key" ON "Supplier"("tenantId", "name");

-- CreateIndex
CREATE INDEX "SupplierRate_tenantId_supplierId_materialId_effectiveFrom_idx" ON "SupplierRate"("tenantId", "supplierId", "materialId", "effectiveFrom" DESC);

-- CreateIndex
CREATE INDEX "Worker_tenantId_isActive_type_idx" ON "Worker"("tenantId", "isActive", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Worker_tenantId_id_key" ON "Worker"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Worker_tenantId_phone_key" ON "Worker"("tenantId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "Subcontractor_tenantId_id_key" ON "Subcontractor"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Subcontractor_tenantId_name_key" ON "Subcontractor"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentScheduleTemplate_tenantId_id_key" ON "PaymentScheduleTemplate"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentScheduleTemplate_tenantId_name_key" ON "PaymentScheduleTemplate"("tenantId", "name");

-- AddForeignKey
ALTER TABLE "PlatformMaterial" ADD CONSTRAINT "PlatformMaterial_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "MaterialGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Material" ADD CONSTRAINT "Material_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Material" ADD CONSTRAINT "Material_platformMaterialId_fkey" FOREIGN KEY ("platformMaterialId") REFERENCES "PlatformMaterial"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Material" ADD CONSTRAINT "Material_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "MaterialGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Material" ADD CONSTRAINT "Material_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "QualityCategory" ADD CONSTRAINT "QualityCategory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialRate" ADD CONSTRAINT "MaterialRate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialRate" ADD CONSTRAINT "MaterialRate_tenantId_materialId_fkey" FOREIGN KEY ("tenantId", "materialId") REFERENCES "Material"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialRate" ADD CONSTRAINT "MaterialRate_tenantId_categoryId_fkey" FOREIGN KEY ("tenantId", "categoryId") REFERENCES "QualityCategory"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialRate" ADD CONSTRAINT "MaterialRate_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "LaborRate" ADD CONSTRAINT "LaborRate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierRate" ADD CONSTRAINT "SupplierRate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierRate" ADD CONSTRAINT "SupplierRate_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Supplier"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierRate" ADD CONSTRAINT "SupplierRate_tenantId_materialId_fkey" FOREIGN KEY ("tenantId", "materialId") REFERENCES "Material"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierRate" ADD CONSTRAINT "SupplierRate_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Worker" ADD CONSTRAINT "Worker_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Worker" ADD CONSTRAINT "Worker_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Subcontractor" ADD CONSTRAINT "Subcontractor_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentScheduleTemplate" ADD CONSTRAINT "PaymentScheduleTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================================
-- Row-level security and privileges
-- ============================================================================

-- Tenant tables: RLS (enable + force) + tenant_isolation policy + explicit app_user grants.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Material', 'QualityCategory', 'MaterialRate', 'LaborRate', 'Supplier',
    'SupplierRate', 'Worker', 'Subcontractor', 'PaymentScheduleTemplate'
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
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t);
  END LOOP;
END
$$;

-- Platform catalog: shared reference data, read-only for companies.
GRANT SELECT ON "MaterialGroup", "PlatformMaterial" TO app_user;
