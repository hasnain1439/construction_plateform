-- Step 11 · Estimation rulebook + saved estimates (BoQ revisions).
--
-- Platform tables (no tenant; companies read, platform admins write through app_admin):
--   "Rulebook" (versioned per region, DRAFT / PUBLISHED), "RulebookParameter" (key, labels, unit,
--   value, safe range, engineer-review status).
-- Tenant tables (ENABLE + FORCE RLS, tenant_isolation, GRANTs to app_user, composite FKs):
--   "CompanyRulebookOverride" (a company's value per parameter key),
--   "Estimate" (DRAFT / APPROVED / SUPERSEDED revisions with rulebook + rate snapshots, money in paisa),
--   "EstimateLine" (BoQ lines, Decimal quantities, BigInt paisa, override qty / rate + note).
-- One APPROVED estimate per project: partial unique index "Estimate_one_approved_per_project".
-- EstimateLine.materialId has no FK on purpose (snapshot reference; the estimate outlives
-- material edits / deletes).
--
-- Data: rulebook v1 PUBLISHED for PUNJAB_KP and KARACHI_SINDH with the built-in values of
-- src/modules/estimate/rulebookDefs.ts — every parameter PENDING_ENGINEER_REVIEW.

-- CreateEnum
CREATE TYPE "RulebookStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "RulebookReviewStatus" AS ENUM ('PENDING_ENGINEER_REVIEW', 'REVIEWED');

-- CreateEnum
CREATE TYPE "EstimateStatus" AS ENUM ('DRAFT', 'APPROVED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "EstimateLineKind" AS ENUM ('MATERIAL', 'LABOUR', 'LUMP_SUM', 'PERCENT');

-- CreateTable
CREATE TABLE "Rulebook" (
    "id" UUID NOT NULL,
    "region" "Region" NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "RulebookStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMPTZ(3),
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Rulebook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RulebookParameter" (
    "id" UUID NOT NULL,
    "rulebookId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "labelRoman" TEXT NOT NULL,
    "labelUrdu" TEXT NOT NULL,
    "description" TEXT,
    "unit" TEXT NOT NULL,
    "value" DECIMAL(14,4) NOT NULL,
    "safeMin" DECIMAL(14,4) NOT NULL,
    "safeMax" DECIMAL(14,4) NOT NULL,
    "reviewStatus" "RulebookReviewStatus" NOT NULL DEFAULT 'PENDING_ENGINEER_REVIEW',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RulebookParameter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyRulebookOverride" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "parameterKey" TEXT NOT NULL,
    "value" DECIMAL(14,4) NOT NULL,
    "note" TEXT,
    "updatedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CompanyRulebookOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Estimate" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" "EstimateStatus" NOT NULL DEFAULT 'DRAFT',
    "rulebookVersionId" UUID,
    "region" "Region" NOT NULL,
    "overridesSnapshot" JSONB NOT NULL,
    "ratesSnapshot" JSONB NOT NULL,
    "basis" JSONB NOT NULL,
    "coveredAreaSqft" DECIMAL(12,2) NOT NULL,
    "directCostPaisa" BIGINT NOT NULL DEFAULT 0,
    "overheadPaisa" BIGINT NOT NULL DEFAULT 0,
    "contingencyPaisa" BIGINT NOT NULL DEFAULT 0,
    "totalPaisa" BIGINT NOT NULL DEFAULT 0,
    "ratesOutdated" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "generatedById" UUID,
    "generatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedById" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "supersededAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Estimate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EstimateLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "estimateId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "lineKey" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "stageKey" TEXT,
    "kind" "EstimateLineKind" NOT NULL,
    "description" TEXT NOT NULL,
    "material" TEXT,
    "materialId" UUID,
    "unit" TEXT NOT NULL,
    "quantity" DECIMAL(16,4) NOT NULL,
    "wastagePercent" DECIMAL(6,2) NOT NULL,
    "quantityWithWastage" DECIMAL(16,4) NOT NULL,
    "suppliedBy" "SuppliedBy" NOT NULL,
    "formula" TEXT NOT NULL,
    "trace" JSONB NOT NULL,
    "ratePaisa" BIGINT,
    "rateUnit" TEXT,
    "rateFactor" DECIMAL(18,8),
    "rateQuantity" DECIMAL(20,4),
    "amountPaisa" BIGINT,
    "rateStatus" TEXT,
    "overrideQuantity" DECIMAL(16,4),
    "overrideRatePaisa" BIGINT,
    "overrideNote" TEXT,
    "overriddenById" UUID,
    "overriddenAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EstimateLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Rulebook_region_status_version_idx" ON "Rulebook"("region", "status", "version" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Rulebook_region_version_key" ON "Rulebook"("region", "version");

-- CreateIndex
CREATE UNIQUE INDEX "RulebookParameter_rulebookId_key_key" ON "RulebookParameter"("rulebookId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyRulebookOverride_tenantId_id_key" ON "CompanyRulebookOverride"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyRulebookOverride_tenantId_parameterKey_key" ON "CompanyRulebookOverride"("tenantId", "parameterKey");

-- CreateIndex
CREATE INDEX "Estimate_tenantId_status_idx" ON "Estimate"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Estimate_tenantId_id_key" ON "Estimate"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Estimate_tenantId_projectId_revision_key" ON "Estimate"("tenantId", "projectId", "revision");

-- CreateIndex
CREATE INDEX "EstimateLine_tenantId_estimateId_sortOrder_idx" ON "EstimateLine"("tenantId", "estimateId", "sortOrder");

-- CreateIndex
CREATE INDEX "EstimateLine_tenantId_materialId_idx" ON "EstimateLine"("tenantId", "materialId");

-- CreateIndex
CREATE UNIQUE INDEX "EstimateLine_tenantId_id_key" ON "EstimateLine"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EstimateLine_tenantId_estimateId_lineKey_key" ON "EstimateLine"("tenantId", "estimateId", "lineKey");

-- AddForeignKey
ALTER TABLE "RulebookParameter" ADD CONSTRAINT "RulebookParameter_rulebookId_fkey" FOREIGN KEY ("rulebookId") REFERENCES "Rulebook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyRulebookOverride" ADD CONSTRAINT "CompanyRulebookOverride_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyRulebookOverride" ADD CONSTRAINT "CompanyRulebookOverride_tenantId_updatedById_fkey" FOREIGN KEY ("tenantId", "updatedById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_rulebookVersionId_fkey" FOREIGN KEY ("rulebookVersionId") REFERENCES "Rulebook"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_tenantId_generatedById_fkey" FOREIGN KEY ("tenantId", "generatedById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_tenantId_approvedById_fkey" FOREIGN KEY ("tenantId", "approvedById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EstimateLine" ADD CONSTRAINT "EstimateLine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateLine" ADD CONSTRAINT "EstimateLine_tenantId_estimateId_fkey" FOREIGN KEY ("tenantId", "estimateId") REFERENCES "Estimate"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateLine" ADD CONSTRAINT "EstimateLine_tenantId_overriddenById_fkey" FOREIGN KEY ("tenantId", "overriddenById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- One APPROVED revision per project
CREATE UNIQUE INDEX "Estimate_one_approved_per_project" ON "Estimate"("tenantId", "projectId") WHERE "status" = 'APPROVED';

-- Row-level security on the tenant tables
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['CompanyRulebookOverride', 'Estimate', 'EstimateLine']
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

-- Platform rulebook: shared reference data, read-only for companies.
GRANT SELECT ON "Rulebook", "RulebookParameter" TO app_user;

-- Rulebook v1 (both regions)
INSERT INTO "Rulebook" ("id", "region", "version", "status", "publishedAt", "notes", "createdAt", "updatedAt") VALUES
('01920000-0000-7000-8000-00000000b001', 'PUNJAB_KP', 1, 'PUBLISHED', CURRENT_TIMESTAMP, 'v1 — built-in Pakistani rules of thumb, every value pending civil-engineer review', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('01920000-0000-7000-8000-00000000b002', 'KARACHI_SINDH', 1, 'PUBLISHED', CURRENT_TIMESTAMP, 'v1 — built-in Pakistani rules of thumb, every value pending civil-engineer review', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT INTO "RulebookParameter" ("id", "rulebookId", "key", "group", "label", "labelRoman", "labelUrdu", "description", "unit", "value", "safeMin", "safeMax", "reviewStatus", "sortOrder", "createdAt", "updatedAt") VALUES
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'externalWallThicknessIn', 'WALLS', 'External wall thickness', 'Bahar ki deewar ki motai', 'بیرونی دیوار کی موٹائی', 'External walls (and foundation walls). Punjab 9″ brick; Karachi 6″ block.', 'in', 9, 4.5, 18, 'PENDING_ENGINEER_REVIEW', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'internalWallThicknessIn', 'WALLS', 'Internal wall thickness', 'Andar ki deewar ki motai', 'اندرونی دیوار کی موٹائی', 'Internal partition walls. Punjab 4.5″ brick; Karachi 4″ block.', 'in', 4.5, 3, 13.5, 'PENDING_ENGINEER_REVIEW', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'parapetHeightFt', 'WALLS', 'Roof parapet height', 'Chhat ki mundair ki unchai', 'چھت کی منڈیر کی اونچائی', 'Parapet on the main roof (internal-wall thickness); 0 = none.', 'ft', 3, 0, 6, 'PENDING_ENGINEER_REVIEW', 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'blockMasonry', 'MASONRY', 'Concrete blocks instead of bricks', 'Eenton ki jagah blocks', 'اینٹوں کی جگہ بلاک', '1 = walls in concrete blocks counted per sq ft of wall face (Karachi / Sindh); 0 = clay bricks per cft (Punjab / KP).', '0 / 1', 0, 0, 1, 'PENDING_ENGINEER_REVIEW', 4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'bricksPerCft', 'MASONRY', 'Bricks per cft of brickwork', 'Fi cft eenten', 'فی مکعب فٹ اینٹیں', 'Standard 9 × 4.5 × 3″ bricks per cft of brickwork including mortar joints.', 'bricks / cft', 13.5, 12, 15, 'PENDING_ENGINEER_REVIEW', 5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'blocksPerSqft', 'MASONRY', 'Blocks per sq ft of wall', 'Fi sq ft blocks', 'فی مربع فٹ بلاک', '8 × 16″ face blocks per sq ft of wall face including joints (one block leaf per wall).', 'blocks / sq ft', 1.125, 1, 1.3, 'PENDING_ENGINEER_REVIEW', 6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'mortarPerCftBrickwork', 'MASONRY', 'Mortar per cft of masonry', 'Fi cft masala', 'فی مکعب فٹ مسالا', 'Wet mortar per cft of masonry. Brick 0.25; block 0.10.', 'cft / cft', 0.25, 0.05, 0.4, 'PENDING_ENGINEER_REVIEW', 7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'masonryMortarMix', 'MASONRY', 'Masonry mortar mix (cement : sand)', 'Chunai masala (cement : ret)', 'چنائی مسالا (سیمنٹ : ریت)', '1 : 6 for brick / block masonry.', '1 : n (sand)', 6, 3, 8, 'PENDING_ENGINEER_REVIEW', 8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'slabThicknessIn', 'CONCRETE', 'Roof slab thickness', 'Lenter ki motai', 'لینٹر کی موٹائی', 'Roof slab (lenter) when the floor has no roof details; 6″ for larger spans.', 'in', 5, 4, 9, 'PENDING_ENGINEER_REVIEW', 9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'rccMix', 'CONCRETE', 'RCC mix (cement : sand : crush)', 'RCC masala (cement : ret : bajri)', 'آر سی سی مسالا (سیمنٹ : ریت : بجری)', '2 = 1 : 2 : 4 (slabs, beams, columns, lintels); 1.5 = 1 : 1.5 : 3.', '1 : n : 2n (sand)', 2, 1.5, 2, 'PENDING_ENGINEER_REVIEW', 10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'frameConcretePercent', 'CONCRETE', 'Beams + columns concrete (% of slab)', 'Beam + column concrete (lenter ka %)', 'بیم + کالم کنکریٹ (لینٹر کا ٪)', 'RCC frame only, when the floor has no roof details.', '%', 45, 20, 80, 'PENDING_ENGINEER_REVIEW', 11, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'lintelWidthIn', 'CONCRETE', 'Lintel width', 'Lintel ki chaurai', 'لنٹل کی چوڑائی', 'Lintel width (estimated walls); usually the wall thickness.', 'in', 9, 4, 18, 'PENDING_ENGINEER_REVIEW', 12, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'lintelDepthIn', 'CONCRETE', 'Lintel depth', 'Lintel ki gehrai', 'لنٹل کی گہرائی', 'Lintel depth over doors and windows.', 'in', 6, 4, 12, 'PENDING_ENGINEER_REVIEW', 13, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'lintelBearingFt', 'CONCRETE', 'Lintel bearing (both sides)', 'Lintel bearing (dono taraf)', 'لنٹل بیئرنگ (دونوں طرف)', 'Extra lintel length over each opening, both sides together.', 'ft', 1, 0.5, 2, 'PENDING_ENGINEER_REVIEW', 14, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'slabSteelPercent', 'STEEL', 'Slab steel', 'Lenter sariya', 'لینٹر سریا', 'Steel as % of slab concrete volume (1 % ≈ 2.22 kg per cft).', '% of concrete', 1, 0.6, 1.6, 'PENDING_ENGINEER_REVIEW', 15, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'frameSteelPercent', 'STEEL', 'Beam / column steel', 'Beam / column sariya', 'بیم / کالم سریا', 'Steel as % of beam + column concrete.', '% of concrete', 2.5, 1.5, 4, 'PENDING_ENGINEER_REVIEW', 16, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'lintelSteelPercent', 'STEEL', 'Lintel steel', 'Lintel sariya', 'لنٹل سریا', 'Steel as % of lintel concrete.', '% of concrete', 1, 0.6, 2, 'PENDING_ENGINEER_REVIEW', 17, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'footingSteelPercent', 'STEEL', 'Footing / raft steel', 'Bunyaad sariya', 'بنیاد سریا', 'Steel as % of RCC footing / raft / pile concrete.', '% of concrete', 0.8, 0.5, 1.6, 'PENDING_ENGINEER_REVIEW', 18, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'internalPlasterMix', 'PLASTER', 'Internal plaster mix', 'Andar ka plaster masala', 'اندرونی پلستر مسالا', 'Cement : sand for internal walls and ceilings (1 : 6).', '1 : n (sand)', 6, 3, 6, 'PENDING_ENGINEER_REVIEW', 19, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'internalPlasterThicknessIn', 'PLASTER', 'Internal plaster thickness', 'Andar ke plaster ki motai', 'اندرونی پلستر کی موٹائی', 'Internal walls and ceilings (½″).', 'in', 0.5, 0.375, 1, 'PENDING_ENGINEER_REVIEW', 20, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'externalPlasterMix', 'PLASTER', 'External plaster mix', 'Bahar ka plaster masala', 'بیرونی پلستر مسالا', 'Cement : sand for external faces and parapets (1 : 4).', '1 : n (sand)', 4, 3, 6, 'PENDING_ENGINEER_REVIEW', 21, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'externalPlasterThicknessIn', 'PLASTER', 'External plaster thickness', 'Bahar ke plaster ki motai', 'بیرونی پلستر کی موٹائی', 'External faces (¾″).', 'in', 0.75, 0.5, 1.25, 'PENDING_ENGINEER_REVIEW', 22, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'concreteDryFactor', 'FACTORS', 'Concrete dry-volume factor', 'Concrete dry factor', 'کنکریٹ ڈرائی فیکٹر', 'Wet → dry volume of concrete (1.54).', '×', 1.54, 1.5, 1.6, 'PENDING_ENGINEER_REVIEW', 23, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'mortarDryFactor', 'FACTORS', 'Mortar dry-volume factor', 'Masala dry factor', 'مسالا ڈرائی فیکٹر', 'Wet → dry volume of mortar / plaster (1.33).', '×', 1.33, 1.25, 1.4, 'PENDING_ENGINEER_REVIEW', 24, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'cementBagCft', 'FACTORS', 'Cement bag volume', 'Cement bori ka hajm', 'سیمنٹ بوری کا حجم', 'Volume of one 50 kg bag (1.25 cft).', 'cft / bag', 1.25, 1.2, 1.3, 'PENDING_ENGINEER_REVIEW', 25, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'brickWastagePercent', 'WASTAGE', 'Bricks / blocks wastage', 'Eenton / blocks ka zaya', 'اینٹوں / بلاک کا ضیاع', 'Breakage of bricks or blocks.', '%', 5, 2, 10, 'PENDING_ENGINEER_REVIEW', 26, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'cementWastagePercent', 'WASTAGE', 'Cement wastage', 'Cement ka zaya', 'سیمنٹ کا ضیاع', 'Cement bags.', '%', 2, 1, 6, 'PENDING_ENGINEER_REVIEW', 27, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'sandWastagePercent', 'WASTAGE', 'Sand & crush wastage', 'Ret aur bajri ka zaya', 'ریت اور بجری کا ضیاع', 'Sand and crush (bajri).', '%', 5, 2, 12, 'PENDING_ENGINEER_REVIEW', 28, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'steelWastagePercent', 'WASTAGE', 'Steel wastage', 'Sariye ka zaya', 'سریے کا ضیاع', 'Cutting / laps not in the bar lengths.', '%', 4, 2, 8, 'PENDING_ENGINEER_REVIEW', 29, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'tileWastagePercent', 'WASTAGE', 'Tiles wastage', 'Tiles ka zaya', 'ٹائلوں کا ضیاع', 'Cutting and breakage of floor / wall tiles.', '%', 7, 3, 15, 'PENDING_ENGINEER_REVIEW', 30, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'paintWastagePercent', 'WASTAGE', 'Paint wastage', 'Rang ka zaya', 'رنگ کا ضیاع', 'Paint and primer.', '%', 5, 2, 10, 'PENDING_ENGINEER_REVIEW', 31, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'wastagePercent', 'WASTAGE', 'Other materials wastage', 'Baqi samaan ka zaya', 'باقی سامان کا ضیاع', 'Waterproofing, bitumen, termite chemical, stone, garders, roof tiles, planks, deck.', '%', 5, 0, 15, 'PENDING_ENGINEER_REVIEW', 32, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'waterproofingKgPerBag', 'WATERPROOFING', 'DPC waterproofing compound', 'DPC waterproofing compound', 'ڈی پی سی واٹر پروفنگ کمپاؤنڈ', 'Compound per cement bag of the DPC concrete.', 'kg / bag', 1, 0.5, 2.5, 'PENDING_ENGINEER_REVIEW', 33, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'bitumenKgPerSqft', 'WATERPROOFING', 'DPC bitumen', 'DPC bitumen', 'ڈی پی سی بٹومن', 'Bitumen on the DPC when the DPC material is bitumen.', 'kg / sq ft', 0.15, 0.08, 0.3, 'PENDING_ENGINEER_REVIEW', 34, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'roofWaterproofingRsPerSqft', 'WATERPROOFING', 'Roof waterproofing (lump sum)', 'Chhat ki waterproofing', 'چھت کی واٹر پروفنگ', 'Roof waterproofing treatment per sq ft of the top roof, used when the company has no WATERPROOFING sub-contract rate.', 'Rs / sq ft', 60, 25, 200, 'PENDING_ENGINEER_REVIEW', 35, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'termiteLitrePerSqft', 'EARTHWORK', 'Termite chemical', 'Deemak dawai', 'دیمک دوائی', 'Termite (deemak) concentrate per sq ft of the lowest-floor footprint (1 L per 200 sq ft).', 'L / sq ft', 0.005, 0.003, 0.01, 'PENDING_ENGINEER_REVIEW', 36, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'excavationRsPerCft', 'EARTHWORK', 'Excavation rate', 'Khudai ka rate', 'کھدائی کا ریٹ', 'Manual excavation of foundation trenches, including throwing out.', 'Rs / cft', 12, 5, 40, 'PENDING_ENGINEER_REVIEW', 37, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'earthFillingRsPerCft', 'EARTHWORK', 'Earth filling rate', 'Bharai ka rate', 'بھرائی کا ریٹ', 'Plinth / roof earth filling with compaction (earth included).', 'Rs / cft', 10, 3, 40, 'PENDING_ENGINEER_REVIEW', 38, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'wallTileHeightBathFt', 'FINISHES', 'Bathroom wall tiles height', 'Bathroom tiles ki unchai', 'باتھ روم ٹائلوں کی اونچائی', 'Wall tiles in baths / wet rooms up to this height (capped at the room height).', 'ft', 7, 4, 10, 'PENDING_ENGINEER_REVIEW', 39, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'wallTileHeightKitchenFt', 'FINISHES', 'Kitchen splash tiles height', 'Kitchen splash tiles ki unchai', 'کچن اسپلیش ٹائلوں کی اونچائی', 'Kitchen wall (splash) tiles along the walls up to this height.', 'ft', 3, 2, 8, 'PENDING_ENGINEER_REVIEW', 40, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'tileBeddingThicknessIn', 'FINISHES', 'Floor tile bedding mortar', 'Farsh ke neeche masala', 'فرش کے نیچے مسالا', 'Cement-sand bed under floor tiles.', 'in', 1, 0.5, 2, 'PENDING_ENGINEER_REVIEW', 41, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'tileBeddingMix', 'FINISHES', 'Tile bedding mix', 'Tile masala', 'ٹائل مسالا', 'Cement : sand of the tile bed (1 : 4).', '1 : n (sand)', 4, 3, 6, 'PENDING_ENGINEER_REVIEW', 42, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'paintCoats', 'FINISHES', 'Paint coats', 'Rang ke coat', 'رنگ کے کوٹ', 'Emulsion coats on plastered walls and ceilings.', 'coats', 2, 1, 4, 'PENDING_ENGINEER_REVIEW', 43, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'primerCoats', 'FINISHES', 'Primer coats', 'Primer ke coat', 'پرائمر کے کوٹ', 'Primer / sealer coats before the paint.', 'coats', 1, 0, 2, 'PENDING_ENGINEER_REVIEW', 44, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'paintCoverageSqftPerGallon', 'FINISHES', 'Paint coverage', 'Rang ki coverage', 'رنگ کی کوریج', 'Area one gallon of emulsion covers per coat.', 'sq ft / gallon / coat', 350, 200, 500, 'PENDING_ENGINEER_REVIEW', 45, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'primerCoverageSqftPerGallon', 'FINISHES', 'Primer coverage', 'Primer ki coverage', 'پرائمر کی کوریج', 'Area one gallon of primer covers per coat.', 'sq ft / gallon / coat', 400, 250, 600, 'PENDING_ENGINEER_REVIEW', 46, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'mepElectricalRsPerSqft', 'MEP', 'Electrical rough-in', 'Bijli ki wiring (conduit)', 'بجلی کی وائرنگ (کنڈیوٹ)', 'Conduits, boxes and laying in walls / slabs per sq ft of covered area.', 'Rs / sq ft', 150, 50, 500, 'PENDING_ENGINEER_REVIEW', 47, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'mepPlumbingRsPerWetRoom', 'MEP', 'Plumbing rough-in per wet room', 'Plumbing fi wet room', 'پلمبنگ فی گیلا کمرہ', 'Water supply + drainage pipes and fittings laid in walls / floors, per bath or kitchen.', 'Rs / wet room', 35000, 10000, 150000, 'PENDING_ENGINEER_REVIEW', 48, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'mepSewerageGasRsLumpSum', 'MEP', 'Sewerage + gas lump sum', 'Gutter line + gas (lump sum)', 'گٹر لائن + گیس (یکمشت)', 'Main sewer line, manholes, rain-water pipes and gas pipe rough-in for the house.', 'Rs', 75000, 20000, 400000, 'PENDING_ENGINEER_REVIEW', 49, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'equipmentShutteringRsPerSqft', 'OVERHEADS', 'Equipment & shuttering hire', 'Machinery aur shuttering kiraya', 'مشینری اور شٹرنگ کرایہ', 'Lump sum per sq ft of covered area: shuttering plates / props, mixer, vibrator, scaffolding, water.', 'Rs / sq ft', 60, 20, 250, 'PENDING_ENGINEER_REVIEW', 50, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'siteOverheadPercent', 'OVERHEADS', 'Site overheads', 'Site ke kharche', 'سائٹ کے اخراجات', 'Chowkidar, site office, utilities, transport — % of the direct cost.', '%', 3, 0, 12, 'PENDING_ENGINEER_REVIEW', 51, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'contingencyPercent', 'OVERHEADS', 'Contingency', 'Ghair mutawaqqa kharcha', 'غیر متوقع خرچہ', '% of direct cost + overheads for price changes and unforeseen work.', '%', 5, 0, 15, 'PENDING_ENGINEER_REVIEW', 52, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'rccCftPerSqftFramed', 'NORMS', 'RCC per sq ft (frame)', 'Fi sq ft RCC (frame)', 'فی مربع فٹ آر سی سی (فریم)', 'RCC concrete per sq ft of covered area for an RCC-frame house (slabs + beams + columns + footings).', 'cft / sq ft', 0.6, 0.4, 0.9, 'PENDING_ENGINEER_REVIEW', 53, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'rccCftPerSqftLoadBearing', 'NORMS', 'RCC per sq ft (load bearing)', 'Fi sq ft RCC (load bearing)', 'فی مربع فٹ آر سی سی (لوڈ بیئرنگ)', 'RCC concrete per sq ft of covered area for a load-bearing house (slabs + lintels).', 'cft / sq ft', 0.45, 0.3, 0.7, 'PENDING_ENGINEER_REVIEW', 54, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'steelKgPerSqftFramed', 'NORMS', 'Steel per sq ft (frame)', 'Fi sq ft sariya (frame)', 'فی مربع فٹ سریا (فریم)', 'Steel per sq ft of covered area for an RCC-frame house.', 'kg / sq ft', 4, 2.5, 6, 'PENDING_ENGINEER_REVIEW', 55, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'steelKgPerSqftLoadBearing', 'NORMS', 'Steel per sq ft (load bearing)', 'Fi sq ft sariya (load bearing)', 'فی مربع فٹ سریا (لوڈ بیئرنگ)', 'Steel per sq ft of covered area for a load-bearing house.', 'kg / sq ft', 2.5, 1.5, 4, 'PENDING_ENGINEER_REVIEW', 56, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'productivityExcavationCftPerDay', 'PRODUCTIVITY', 'Excavation output', 'Khudai rozana', 'کھدائی روزانہ', 'One gang (1 mistri + 4 mazdoor) per day.', 'cft / gang-day', 500, 200, 1500, 'PENDING_ENGINEER_REVIEW', 57, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'productivityBricksPerDay', 'PRODUCTIVITY', 'Brick laying output', 'Chunai rozana (eenten)', 'چنائی روزانہ (اینٹیں)', 'One team (2 masons + 3 helpers) per day.', 'bricks / team-day', 1500, 600, 3000, 'PENDING_ENGINEER_REVIEW', 58, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'productivityBlocksPerDay', 'PRODUCTIVITY', 'Block laying output', 'Chunai rozana (blocks)', 'چنائی روزانہ (بلاک)', 'One team (2 masons + 3 helpers) per day.', 'blocks / team-day', 400, 150, 900, 'PENDING_ENGINEER_REVIEW', 59, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'productivityConcreteCftPerDay', 'PRODUCTIVITY', 'Concrete casting output', 'Concrete dhalai rozana', 'کنکریٹ ڈھلائی روزانہ', 'Mixer team per day (slab casting).', 'cft / team-day', 400, 150, 1200, 'PENDING_ENGINEER_REVIEW', 60, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'productivityShutteringSqftPerDay', 'PRODUCTIVITY', 'Shuttering output', 'Shuttering rozana', 'شٹرنگ روزانہ', 'One shuttering team per day.', 'sq ft / team-day', 300, 100, 800, 'PENDING_ENGINEER_REVIEW', 61, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'productivitySteelKgPerDay', 'PRODUCTIVITY', 'Steel fixing output', 'Sariya bandhai rozana', 'سریا بندھائی روزانہ', 'One steel fixer team per day.', 'kg / team-day', 400, 150, 1000, 'PENDING_ENGINEER_REVIEW', 62, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'productivityPlasterSqftPerDay', 'PRODUCTIVITY', 'Plaster output', 'Plaster rozana', 'پلستر روزانہ', 'One mason + helper per day.', 'sq ft / team-day', 250, 100, 600, 'PENDING_ENGINEER_REVIEW', 63, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'productivityTileSqftPerDay', 'PRODUCTIVITY', 'Tile fixing output', 'Tile lagai rozana', 'ٹائل لگائی روزانہ', 'One tile mistri + helper per day.', 'sq ft / team-day', 120, 50, 300, 'PENDING_ENGINEER_REVIEW', 64, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'productivityPaintSqftPerDay', 'PRODUCTIVITY', 'Paint output', 'Rang rozana', 'رنگ روزانہ', 'One painter + helper per day, all coats.', 'sq ft / team-day', 600, 200, 1500, 'PENDING_ENGINEER_REVIEW', 65, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'curingDaysSlab', 'PRODUCTIVITY', 'Slab curing / de-shuttering', 'Lenter ki tarai / shuttering', 'لینٹر کی ترائی / شٹرنگ', 'Days before the slab shuttering comes off and the next floor starts.', 'days', 14, 7, 28, 'PENDING_ENGINEER_REVIEW', 66, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'curingDaysColumns', 'PRODUCTIVITY', 'Column curing', 'Column ki tarai', 'کالم کی ترائی', 'Days of curing before loading columns.', 'days', 7, 3, 14, 'PENDING_ENGINEER_REVIEW', 67, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b001', 'curingDaysPlaster', 'PRODUCTIVITY', 'Plaster curing', 'Plaster ki tarai', 'پلستر کی ترائی', 'Days of curing before paint.', 'days', 7, 3, 21, 'PENDING_ENGINEER_REVIEW', 68, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'externalWallThicknessIn', 'WALLS', 'External wall thickness', 'Bahar ki deewar ki motai', 'بیرونی دیوار کی موٹائی', 'External walls (and foundation walls). Punjab 9″ brick; Karachi 6″ block.', 'in', 6, 4.5, 18, 'PENDING_ENGINEER_REVIEW', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'internalWallThicknessIn', 'WALLS', 'Internal wall thickness', 'Andar ki deewar ki motai', 'اندرونی دیوار کی موٹائی', 'Internal partition walls. Punjab 4.5″ brick; Karachi 4″ block.', 'in', 4, 3, 13.5, 'PENDING_ENGINEER_REVIEW', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'parapetHeightFt', 'WALLS', 'Roof parapet height', 'Chhat ki mundair ki unchai', 'چھت کی منڈیر کی اونچائی', 'Parapet on the main roof (internal-wall thickness); 0 = none.', 'ft', 3, 0, 6, 'PENDING_ENGINEER_REVIEW', 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'blockMasonry', 'MASONRY', 'Concrete blocks instead of bricks', 'Eenton ki jagah blocks', 'اینٹوں کی جگہ بلاک', '1 = walls in concrete blocks counted per sq ft of wall face (Karachi / Sindh); 0 = clay bricks per cft (Punjab / KP).', '0 / 1', 1, 0, 1, 'PENDING_ENGINEER_REVIEW', 4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'bricksPerCft', 'MASONRY', 'Bricks per cft of brickwork', 'Fi cft eenten', 'فی مکعب فٹ اینٹیں', 'Standard 9 × 4.5 × 3″ bricks per cft of brickwork including mortar joints.', 'bricks / cft', 13.5, 12, 15, 'PENDING_ENGINEER_REVIEW', 5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'blocksPerSqft', 'MASONRY', 'Blocks per sq ft of wall', 'Fi sq ft blocks', 'فی مربع فٹ بلاک', '8 × 16″ face blocks per sq ft of wall face including joints (one block leaf per wall).', 'blocks / sq ft', 1.125, 1, 1.3, 'PENDING_ENGINEER_REVIEW', 6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'mortarPerCftBrickwork', 'MASONRY', 'Mortar per cft of masonry', 'Fi cft masala', 'فی مکعب فٹ مسالا', 'Wet mortar per cft of masonry. Brick 0.25; block 0.10.', 'cft / cft', 0.1, 0.05, 0.4, 'PENDING_ENGINEER_REVIEW', 7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'masonryMortarMix', 'MASONRY', 'Masonry mortar mix (cement : sand)', 'Chunai masala (cement : ret)', 'چنائی مسالا (سیمنٹ : ریت)', '1 : 6 for brick / block masonry.', '1 : n (sand)', 6, 3, 8, 'PENDING_ENGINEER_REVIEW', 8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'slabThicknessIn', 'CONCRETE', 'Roof slab thickness', 'Lenter ki motai', 'لینٹر کی موٹائی', 'Roof slab (lenter) when the floor has no roof details; 6″ for larger spans.', 'in', 5, 4, 9, 'PENDING_ENGINEER_REVIEW', 9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'rccMix', 'CONCRETE', 'RCC mix (cement : sand : crush)', 'RCC masala (cement : ret : bajri)', 'آر سی سی مسالا (سیمنٹ : ریت : بجری)', '2 = 1 : 2 : 4 (slabs, beams, columns, lintels); 1.5 = 1 : 1.5 : 3.', '1 : n : 2n (sand)', 2, 1.5, 2, 'PENDING_ENGINEER_REVIEW', 10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'frameConcretePercent', 'CONCRETE', 'Beams + columns concrete (% of slab)', 'Beam + column concrete (lenter ka %)', 'بیم + کالم کنکریٹ (لینٹر کا ٪)', 'RCC frame only, when the floor has no roof details.', '%', 45, 20, 80, 'PENDING_ENGINEER_REVIEW', 11, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'lintelWidthIn', 'CONCRETE', 'Lintel width', 'Lintel ki chaurai', 'لنٹل کی چوڑائی', 'Lintel width (estimated walls); usually the wall thickness.', 'in', 6, 4, 18, 'PENDING_ENGINEER_REVIEW', 12, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'lintelDepthIn', 'CONCRETE', 'Lintel depth', 'Lintel ki gehrai', 'لنٹل کی گہرائی', 'Lintel depth over doors and windows.', 'in', 6, 4, 12, 'PENDING_ENGINEER_REVIEW', 13, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'lintelBearingFt', 'CONCRETE', 'Lintel bearing (both sides)', 'Lintel bearing (dono taraf)', 'لنٹل بیئرنگ (دونوں طرف)', 'Extra lintel length over each opening, both sides together.', 'ft', 1, 0.5, 2, 'PENDING_ENGINEER_REVIEW', 14, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'slabSteelPercent', 'STEEL', 'Slab steel', 'Lenter sariya', 'لینٹر سریا', 'Steel as % of slab concrete volume (1 % ≈ 2.22 kg per cft).', '% of concrete', 1, 0.6, 1.6, 'PENDING_ENGINEER_REVIEW', 15, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'frameSteelPercent', 'STEEL', 'Beam / column steel', 'Beam / column sariya', 'بیم / کالم سریا', 'Steel as % of beam + column concrete.', '% of concrete', 2.5, 1.5, 4, 'PENDING_ENGINEER_REVIEW', 16, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'lintelSteelPercent', 'STEEL', 'Lintel steel', 'Lintel sariya', 'لنٹل سریا', 'Steel as % of lintel concrete.', '% of concrete', 1, 0.6, 2, 'PENDING_ENGINEER_REVIEW', 17, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'footingSteelPercent', 'STEEL', 'Footing / raft steel', 'Bunyaad sariya', 'بنیاد سریا', 'Steel as % of RCC footing / raft / pile concrete.', '% of concrete', 0.8, 0.5, 1.6, 'PENDING_ENGINEER_REVIEW', 18, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'internalPlasterMix', 'PLASTER', 'Internal plaster mix', 'Andar ka plaster masala', 'اندرونی پلستر مسالا', 'Cement : sand for internal walls and ceilings (1 : 6).', '1 : n (sand)', 6, 3, 6, 'PENDING_ENGINEER_REVIEW', 19, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'internalPlasterThicknessIn', 'PLASTER', 'Internal plaster thickness', 'Andar ke plaster ki motai', 'اندرونی پلستر کی موٹائی', 'Internal walls and ceilings (½″).', 'in', 0.5, 0.375, 1, 'PENDING_ENGINEER_REVIEW', 20, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'externalPlasterMix', 'PLASTER', 'External plaster mix', 'Bahar ka plaster masala', 'بیرونی پلستر مسالا', 'Cement : sand for external faces and parapets (1 : 4).', '1 : n (sand)', 4, 3, 6, 'PENDING_ENGINEER_REVIEW', 21, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'externalPlasterThicknessIn', 'PLASTER', 'External plaster thickness', 'Bahar ke plaster ki motai', 'بیرونی پلستر کی موٹائی', 'External faces (¾″).', 'in', 0.75, 0.5, 1.25, 'PENDING_ENGINEER_REVIEW', 22, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'concreteDryFactor', 'FACTORS', 'Concrete dry-volume factor', 'Concrete dry factor', 'کنکریٹ ڈرائی فیکٹر', 'Wet → dry volume of concrete (1.54).', '×', 1.54, 1.5, 1.6, 'PENDING_ENGINEER_REVIEW', 23, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'mortarDryFactor', 'FACTORS', 'Mortar dry-volume factor', 'Masala dry factor', 'مسالا ڈرائی فیکٹر', 'Wet → dry volume of mortar / plaster (1.33).', '×', 1.33, 1.25, 1.4, 'PENDING_ENGINEER_REVIEW', 24, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'cementBagCft', 'FACTORS', 'Cement bag volume', 'Cement bori ka hajm', 'سیمنٹ بوری کا حجم', 'Volume of one 50 kg bag (1.25 cft).', 'cft / bag', 1.25, 1.2, 1.3, 'PENDING_ENGINEER_REVIEW', 25, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'brickWastagePercent', 'WASTAGE', 'Bricks / blocks wastage', 'Eenton / blocks ka zaya', 'اینٹوں / بلاک کا ضیاع', 'Breakage of bricks or blocks.', '%', 5, 2, 10, 'PENDING_ENGINEER_REVIEW', 26, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'cementWastagePercent', 'WASTAGE', 'Cement wastage', 'Cement ka zaya', 'سیمنٹ کا ضیاع', 'Cement bags.', '%', 2, 1, 6, 'PENDING_ENGINEER_REVIEW', 27, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'sandWastagePercent', 'WASTAGE', 'Sand & crush wastage', 'Ret aur bajri ka zaya', 'ریت اور بجری کا ضیاع', 'Sand and crush (bajri).', '%', 5, 2, 12, 'PENDING_ENGINEER_REVIEW', 28, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'steelWastagePercent', 'WASTAGE', 'Steel wastage', 'Sariye ka zaya', 'سریے کا ضیاع', 'Cutting / laps not in the bar lengths.', '%', 4, 2, 8, 'PENDING_ENGINEER_REVIEW', 29, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'tileWastagePercent', 'WASTAGE', 'Tiles wastage', 'Tiles ka zaya', 'ٹائلوں کا ضیاع', 'Cutting and breakage of floor / wall tiles.', '%', 7, 3, 15, 'PENDING_ENGINEER_REVIEW', 30, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'paintWastagePercent', 'WASTAGE', 'Paint wastage', 'Rang ka zaya', 'رنگ کا ضیاع', 'Paint and primer.', '%', 5, 2, 10, 'PENDING_ENGINEER_REVIEW', 31, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'wastagePercent', 'WASTAGE', 'Other materials wastage', 'Baqi samaan ka zaya', 'باقی سامان کا ضیاع', 'Waterproofing, bitumen, termite chemical, stone, garders, roof tiles, planks, deck.', '%', 5, 0, 15, 'PENDING_ENGINEER_REVIEW', 32, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'waterproofingKgPerBag', 'WATERPROOFING', 'DPC waterproofing compound', 'DPC waterproofing compound', 'ڈی پی سی واٹر پروفنگ کمپاؤنڈ', 'Compound per cement bag of the DPC concrete.', 'kg / bag', 1, 0.5, 2.5, 'PENDING_ENGINEER_REVIEW', 33, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'bitumenKgPerSqft', 'WATERPROOFING', 'DPC bitumen', 'DPC bitumen', 'ڈی پی سی بٹومن', 'Bitumen on the DPC when the DPC material is bitumen.', 'kg / sq ft', 0.15, 0.08, 0.3, 'PENDING_ENGINEER_REVIEW', 34, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'roofWaterproofingRsPerSqft', 'WATERPROOFING', 'Roof waterproofing (lump sum)', 'Chhat ki waterproofing', 'چھت کی واٹر پروفنگ', 'Roof waterproofing treatment per sq ft of the top roof, used when the company has no WATERPROOFING sub-contract rate.', 'Rs / sq ft', 60, 25, 200, 'PENDING_ENGINEER_REVIEW', 35, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'termiteLitrePerSqft', 'EARTHWORK', 'Termite chemical', 'Deemak dawai', 'دیمک دوائی', 'Termite (deemak) concentrate per sq ft of the lowest-floor footprint (1 L per 200 sq ft).', 'L / sq ft', 0.005, 0.003, 0.01, 'PENDING_ENGINEER_REVIEW', 36, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'excavationRsPerCft', 'EARTHWORK', 'Excavation rate', 'Khudai ka rate', 'کھدائی کا ریٹ', 'Manual excavation of foundation trenches, including throwing out.', 'Rs / cft', 12, 5, 40, 'PENDING_ENGINEER_REVIEW', 37, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'earthFillingRsPerCft', 'EARTHWORK', 'Earth filling rate', 'Bharai ka rate', 'بھرائی کا ریٹ', 'Plinth / roof earth filling with compaction (earth included).', 'Rs / cft', 10, 3, 40, 'PENDING_ENGINEER_REVIEW', 38, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'wallTileHeightBathFt', 'FINISHES', 'Bathroom wall tiles height', 'Bathroom tiles ki unchai', 'باتھ روم ٹائلوں کی اونچائی', 'Wall tiles in baths / wet rooms up to this height (capped at the room height).', 'ft', 7, 4, 10, 'PENDING_ENGINEER_REVIEW', 39, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'wallTileHeightKitchenFt', 'FINISHES', 'Kitchen splash tiles height', 'Kitchen splash tiles ki unchai', 'کچن اسپلیش ٹائلوں کی اونچائی', 'Kitchen wall (splash) tiles along the walls up to this height.', 'ft', 3, 2, 8, 'PENDING_ENGINEER_REVIEW', 40, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'tileBeddingThicknessIn', 'FINISHES', 'Floor tile bedding mortar', 'Farsh ke neeche masala', 'فرش کے نیچے مسالا', 'Cement-sand bed under floor tiles.', 'in', 1, 0.5, 2, 'PENDING_ENGINEER_REVIEW', 41, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'tileBeddingMix', 'FINISHES', 'Tile bedding mix', 'Tile masala', 'ٹائل مسالا', 'Cement : sand of the tile bed (1 : 4).', '1 : n (sand)', 4, 3, 6, 'PENDING_ENGINEER_REVIEW', 42, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'paintCoats', 'FINISHES', 'Paint coats', 'Rang ke coat', 'رنگ کے کوٹ', 'Emulsion coats on plastered walls and ceilings.', 'coats', 2, 1, 4, 'PENDING_ENGINEER_REVIEW', 43, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'primerCoats', 'FINISHES', 'Primer coats', 'Primer ke coat', 'پرائمر کے کوٹ', 'Primer / sealer coats before the paint.', 'coats', 1, 0, 2, 'PENDING_ENGINEER_REVIEW', 44, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'paintCoverageSqftPerGallon', 'FINISHES', 'Paint coverage', 'Rang ki coverage', 'رنگ کی کوریج', 'Area one gallon of emulsion covers per coat.', 'sq ft / gallon / coat', 350, 200, 500, 'PENDING_ENGINEER_REVIEW', 45, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'primerCoverageSqftPerGallon', 'FINISHES', 'Primer coverage', 'Primer ki coverage', 'پرائمر کی کوریج', 'Area one gallon of primer covers per coat.', 'sq ft / gallon / coat', 400, 250, 600, 'PENDING_ENGINEER_REVIEW', 46, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'mepElectricalRsPerSqft', 'MEP', 'Electrical rough-in', 'Bijli ki wiring (conduit)', 'بجلی کی وائرنگ (کنڈیوٹ)', 'Conduits, boxes and laying in walls / slabs per sq ft of covered area.', 'Rs / sq ft', 150, 50, 500, 'PENDING_ENGINEER_REVIEW', 47, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'mepPlumbingRsPerWetRoom', 'MEP', 'Plumbing rough-in per wet room', 'Plumbing fi wet room', 'پلمبنگ فی گیلا کمرہ', 'Water supply + drainage pipes and fittings laid in walls / floors, per bath or kitchen.', 'Rs / wet room', 35000, 10000, 150000, 'PENDING_ENGINEER_REVIEW', 48, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'mepSewerageGasRsLumpSum', 'MEP', 'Sewerage + gas lump sum', 'Gutter line + gas (lump sum)', 'گٹر لائن + گیس (یکمشت)', 'Main sewer line, manholes, rain-water pipes and gas pipe rough-in for the house.', 'Rs', 75000, 20000, 400000, 'PENDING_ENGINEER_REVIEW', 49, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'equipmentShutteringRsPerSqft', 'OVERHEADS', 'Equipment & shuttering hire', 'Machinery aur shuttering kiraya', 'مشینری اور شٹرنگ کرایہ', 'Lump sum per sq ft of covered area: shuttering plates / props, mixer, vibrator, scaffolding, water.', 'Rs / sq ft', 60, 20, 250, 'PENDING_ENGINEER_REVIEW', 50, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'siteOverheadPercent', 'OVERHEADS', 'Site overheads', 'Site ke kharche', 'سائٹ کے اخراجات', 'Chowkidar, site office, utilities, transport — % of the direct cost.', '%', 3, 0, 12, 'PENDING_ENGINEER_REVIEW', 51, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'contingencyPercent', 'OVERHEADS', 'Contingency', 'Ghair mutawaqqa kharcha', 'غیر متوقع خرچہ', '% of direct cost + overheads for price changes and unforeseen work.', '%', 5, 0, 15, 'PENDING_ENGINEER_REVIEW', 52, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'rccCftPerSqftFramed', 'NORMS', 'RCC per sq ft (frame)', 'Fi sq ft RCC (frame)', 'فی مربع فٹ آر سی سی (فریم)', 'RCC concrete per sq ft of covered area for an RCC-frame house (slabs + beams + columns + footings).', 'cft / sq ft', 0.6, 0.4, 0.9, 'PENDING_ENGINEER_REVIEW', 53, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'rccCftPerSqftLoadBearing', 'NORMS', 'RCC per sq ft (load bearing)', 'Fi sq ft RCC (load bearing)', 'فی مربع فٹ آر سی سی (لوڈ بیئرنگ)', 'RCC concrete per sq ft of covered area for a load-bearing house (slabs + lintels).', 'cft / sq ft', 0.45, 0.3, 0.7, 'PENDING_ENGINEER_REVIEW', 54, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'steelKgPerSqftFramed', 'NORMS', 'Steel per sq ft (frame)', 'Fi sq ft sariya (frame)', 'فی مربع فٹ سریا (فریم)', 'Steel per sq ft of covered area for an RCC-frame house.', 'kg / sq ft', 4, 2.5, 6, 'PENDING_ENGINEER_REVIEW', 55, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'steelKgPerSqftLoadBearing', 'NORMS', 'Steel per sq ft (load bearing)', 'Fi sq ft sariya (load bearing)', 'فی مربع فٹ سریا (لوڈ بیئرنگ)', 'Steel per sq ft of covered area for a load-bearing house.', 'kg / sq ft', 2.5, 1.5, 4, 'PENDING_ENGINEER_REVIEW', 56, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'productivityExcavationCftPerDay', 'PRODUCTIVITY', 'Excavation output', 'Khudai rozana', 'کھدائی روزانہ', 'One gang (1 mistri + 4 mazdoor) per day.', 'cft / gang-day', 500, 200, 1500, 'PENDING_ENGINEER_REVIEW', 57, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'productivityBricksPerDay', 'PRODUCTIVITY', 'Brick laying output', 'Chunai rozana (eenten)', 'چنائی روزانہ (اینٹیں)', 'One team (2 masons + 3 helpers) per day.', 'bricks / team-day', 1500, 600, 3000, 'PENDING_ENGINEER_REVIEW', 58, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'productivityBlocksPerDay', 'PRODUCTIVITY', 'Block laying output', 'Chunai rozana (blocks)', 'چنائی روزانہ (بلاک)', 'One team (2 masons + 3 helpers) per day.', 'blocks / team-day', 400, 150, 900, 'PENDING_ENGINEER_REVIEW', 59, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'productivityConcreteCftPerDay', 'PRODUCTIVITY', 'Concrete casting output', 'Concrete dhalai rozana', 'کنکریٹ ڈھلائی روزانہ', 'Mixer team per day (slab casting).', 'cft / team-day', 400, 150, 1200, 'PENDING_ENGINEER_REVIEW', 60, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'productivityShutteringSqftPerDay', 'PRODUCTIVITY', 'Shuttering output', 'Shuttering rozana', 'شٹرنگ روزانہ', 'One shuttering team per day.', 'sq ft / team-day', 300, 100, 800, 'PENDING_ENGINEER_REVIEW', 61, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'productivitySteelKgPerDay', 'PRODUCTIVITY', 'Steel fixing output', 'Sariya bandhai rozana', 'سریا بندھائی روزانہ', 'One steel fixer team per day.', 'kg / team-day', 400, 150, 1000, 'PENDING_ENGINEER_REVIEW', 62, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'productivityPlasterSqftPerDay', 'PRODUCTIVITY', 'Plaster output', 'Plaster rozana', 'پلستر روزانہ', 'One mason + helper per day.', 'sq ft / team-day', 250, 100, 600, 'PENDING_ENGINEER_REVIEW', 63, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'productivityTileSqftPerDay', 'PRODUCTIVITY', 'Tile fixing output', 'Tile lagai rozana', 'ٹائل لگائی روزانہ', 'One tile mistri + helper per day.', 'sq ft / team-day', 120, 50, 300, 'PENDING_ENGINEER_REVIEW', 64, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'productivityPaintSqftPerDay', 'PRODUCTIVITY', 'Paint output', 'Rang rozana', 'رنگ روزانہ', 'One painter + helper per day, all coats.', 'sq ft / team-day', 600, 200, 1500, 'PENDING_ENGINEER_REVIEW', 65, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'curingDaysSlab', 'PRODUCTIVITY', 'Slab curing / de-shuttering', 'Lenter ki tarai / shuttering', 'لینٹر کی ترائی / شٹرنگ', 'Days before the slab shuttering comes off and the next floor starts.', 'days', 14, 7, 28, 'PENDING_ENGINEER_REVIEW', 66, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'curingDaysColumns', 'PRODUCTIVITY', 'Column curing', 'Column ki tarai', 'کالم کی ترائی', 'Days of curing before loading columns.', 'days', 7, 3, 14, 'PENDING_ENGINEER_REVIEW', 67, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
(gen_random_uuid(), '01920000-0000-7000-8000-00000000b002', 'curingDaysPlaster', 'PRODUCTIVITY', 'Plaster curing', 'Plaster ki tarai', 'پلستر کی ترائی', 'Days of curing before paint.', 'days', 7, 3, 21, 'PENDING_ENGINEER_REVIEW', 68, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
