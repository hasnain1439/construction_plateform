-- CreateEnum
CREATE TYPE "ContractType" AS ENUM ('FULL', 'GREY_OWNER_FINISHING', 'LABOR_ONLY');

-- CreateEnum
CREATE TYPE "PlotUnit" AS ENUM ('MARLA', 'KANAL', 'SQFT');

-- CreateEnum
CREATE TYPE "StructureType" AS ENUM ('FRAMED', 'LOAD_BEARING');

-- CreateEnum
CREATE TYPE "BoundaryThickness" AS ENUM ('IN_4_5', 'IN_9');

-- CreateEnum
CREATE TYPE "SuppliedBy" AS ENUM ('CONTRACTOR', 'OWNER');

-- CreateEnum
CREATE TYPE "BillingStageStatus" AS ENUM ('UPCOMING', 'INVOICED', 'PAID');

-- CreateEnum
CREATE TYPE "FloorLevel" AS ENUM ('BASEMENT', 'GROUND', 'FIRST', 'SECOND', 'THIRD', 'MUMTY');

-- CreateEnum
CREATE TYPE "RoomType" AS ENUM ('MASTER_BEDROOM', 'BEDROOM', 'ATTACHED_BATH', 'POWDER_ROOM', 'KITCHEN', 'TV_LOUNGE', 'DRAWING_ROOM', 'DINING', 'STORE', 'TERRACE', 'STAIR', 'GARAGE', 'OTHER');

-- CreateEnum
CREATE TYPE "OpeningType" AS ENUM ('DOOR', 'WINDOW', 'VENTILATOR');

-- AlterEnum
BEGIN;
CREATE TYPE "ProjectStatus_new" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSEOUT', 'HANDED_OVER', 'CLOSED', 'READ_ONLY');
ALTER TABLE "public"."Project" ALTER COLUMN "status" DROP DEFAULT;
-- Old values: ON_HOLD → ACTIVE, COMPLETED → HANDED_OVER, ARCHIVED → CLOSED (ACTIVE / READ_ONLY unchanged)
ALTER TABLE "Project" ALTER COLUMN "status" TYPE "ProjectStatus_new" USING (
  CASE "status"::text
    WHEN 'ON_HOLD' THEN 'ACTIVE'
    WHEN 'COMPLETED' THEN 'HANDED_OVER'
    WHEN 'ARCHIVED' THEN 'CLOSED'
    ELSE "status"::text
  END
)::"ProjectStatus_new";
ALTER TYPE "ProjectStatus" RENAME TO "ProjectStatus_old";
ALTER TYPE "ProjectStatus_new" RENAME TO "ProjectStatus";
DROP TYPE "public"."ProjectStatus_old";
ALTER TABLE "Project" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
COMMIT;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "activatedAt" TIMESTAMPTZ(3),
ADD COLUMN     "basementHeightFt" DECIMAL(10,2),
ADD COLUMN     "billingModel" "BillingModel",
ADD COLUMN     "boundaryHeightFt" DECIMAL(10,2),
ADD COLUMN     "boundaryLengthFt" DECIMAL(10,2),
ADD COLUMN     "boundaryPlasterSides" INTEGER,
ADD COLUMN     "boundaryThickness" "BoundaryThickness",
ADD COLUMN     "boundaryWall" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "clientId" UUID,
ADD COLUMN     "code" TEXT,
ADD COLUMN     "contractType" "ContractType",
ADD COLUMN     "contractValuePaisa" BIGINT,
ADD COLUMN     "cornerPlot" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "coveredAreaSqft" DECIMAL(10,2),
ADD COLUMN     "createdById" UUID,
ADD COLUMN     "createdFromQuoteId" UUID,
ADD COLUMN     "defectPeriodMonths" INTEGER NOT NULL DEFAULT 6,
ADD COLUMN     "depthFt" DECIMAL(10,2),
ADD COLUMN     "endDate" DATE,
ADD COLUMN     "frontFt" DECIMAL(10,2),
ADD COLUMN     "hasBasement" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "marlaStandard" DECIMAL(6,2) NOT NULL DEFAULT 225,
ADD COLUMN     "openAreaSqft" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "plotSize" DECIMAL(10,2),
ADD COLUMN     "plotUnit" "PlotUnit",
ADD COLUMN     "ratePerSqftPaisa" BIGINT,
ADD COLUMN     "retentionPercent" DECIMAL(5,2) NOT NULL DEFAULT 5,
ADD COLUMN     "semiCoveredSqft" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "siteAddress" TEXT,
ADD COLUMN     "startDate" DATE,
ADD COLUMN     "structureType" "StructureType",
ADD COLUMN     "wizardCompletedSteps" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ALTER COLUMN "status" SET DEFAULT 'DRAFT';

-- Existing projects get a code PRJ-<year created>-<NNN> (per company), then code becomes required
UPDATE "Project" p SET "code" = x.code
FROM (
  SELECT id, 'PRJ-' || to_char("createdAt", 'YYYY') || '-' ||
         lpad((row_number() OVER (PARTITION BY "tenantId" ORDER BY "createdAt", id))::text, 3, '0') AS code
  FROM "Project"
) x
WHERE p.id = x.id;
ALTER TABLE "Project" ALTER COLUMN "code" SET NOT NULL;

-- CreateTable
CREATE TABLE "ProjectSupplyRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "categoryKey" TEXT NOT NULL,
    "suppliedBy" "SuppliedBy" NOT NULL,
    "qualityCategoryId" UUID,
    "lockedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ProjectSupplyRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectBillingStage" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "percent" DECIMAL(5,2) NOT NULL,
    "isRetention" BOOLEAN NOT NULL DEFAULT false,
    "amountPaisa" BIGINT NOT NULL DEFAULT 0,
    "status" "BillingStageStatus" NOT NULL DEFAULT 'UPCOMING',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ProjectBillingStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Floor" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "level" "FloorLevel" NOT NULL,
    "name" TEXT NOT NULL,
    "ceilingHeightFt" DECIMAL(10,2) NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Floor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Room" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "floorId" UUID NOT NULL,
    "type" "RoomType" NOT NULL,
    "name" TEXT NOT NULL,
    "lengthFt" DECIMAL(10,2) NOT NULL,
    "widthFt" DECIMAL(10,2) NOT NULL,
    "heightFt" DECIMAL(10,2) NOT NULL,
    "isWet" BOOLEAN NOT NULL DEFAULT false,
    "isWetOverridden" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Opening" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "type" "OpeningType" NOT NULL,
    "widthFt" DECIMAL(10,2) NOT NULL,
    "heightFt" DECIMAL(10,2) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Opening_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectSupplyRule_tenantId_projectId_idx" ON "ProjectSupplyRule"("tenantId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectSupplyRule_tenantId_id_key" ON "ProjectSupplyRule"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectSupplyRule_projectId_categoryKey_key" ON "ProjectSupplyRule"("projectId", "categoryKey");

-- CreateIndex
CREATE INDEX "ProjectBillingStage_tenantId_projectId_sortOrder_idx" ON "ProjectBillingStage"("tenantId", "projectId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectBillingStage_tenantId_id_key" ON "ProjectBillingStage"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Floor_tenantId_projectId_idx" ON "Floor"("tenantId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Floor_tenantId_id_key" ON "Floor"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Floor_projectId_level_key" ON "Floor"("projectId", "level");

-- CreateIndex
CREATE INDEX "Room_tenantId_floorId_sortOrder_idx" ON "Room"("tenantId", "floorId", "sortOrder");

-- CreateIndex
CREATE INDEX "Room_tenantId_projectId_idx" ON "Room"("tenantId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Room_tenantId_id_key" ON "Room"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Opening_tenantId_roomId_idx" ON "Opening"("tenantId", "roomId");

-- CreateIndex
CREATE UNIQUE INDEX "Opening_tenantId_id_key" ON "Opening"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Project_tenantId_clientId_idx" ON "Project"("tenantId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_tenantId_code_key" ON "Project"("tenantId", "code");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_tenantId_clientId_fkey" FOREIGN KEY ("tenantId", "clientId") REFERENCES "Client"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ProjectSupplyRule" ADD CONSTRAINT "ProjectSupplyRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectSupplyRule" ADD CONSTRAINT "ProjectSupplyRule_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectSupplyRule" ADD CONSTRAINT "ProjectSupplyRule_tenantId_qualityCategoryId_fkey" FOREIGN KEY ("tenantId", "qualityCategoryId") REFERENCES "QualityCategory"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ProjectBillingStage" ADD CONSTRAINT "ProjectBillingStage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectBillingStage" ADD CONSTRAINT "ProjectBillingStage_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Floor" ADD CONSTRAINT "Floor_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Floor" ADD CONSTRAINT "Floor_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Room" ADD CONSTRAINT "Room_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Room" ADD CONSTRAINT "Room_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Room" ADD CONSTRAINT "Room_tenantId_floorId_fkey" FOREIGN KEY ("tenantId", "floorId") REFERENCES "Floor"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opening" ADD CONSTRAINT "Opening_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opening" ADD CONSTRAINT "Opening_tenantId_roomId_fkey" FOREIGN KEY ("tenantId", "roomId") REFERENCES "Room"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security (tenant isolation) + app_user access for the new tenant tables
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ProjectSupplyRule', 'ProjectBillingStage', 'Floor', 'Room', 'Opening'] LOOP
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
END $$;
