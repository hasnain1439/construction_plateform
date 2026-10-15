-- Foundation (bunyaad) of a project, entered in wizard tab 3 (plot & structure).
-- One nullable JSONB column: NULL = not entered (every existing project stays valid).
-- Shape (validated by zod in src/modules/projects/foundation.ts, every key present, null where
-- it does not apply to the type): { type, excavationDepthFt, footingWidthFt, footingThicknessIn,
-- plinthHeightFt, dpcThicknessIn, footingCount, footingLengthFt, pileCount, pileDiameterIn,
-- pileDepthFt, masonry, pccMix, pccThicknessIn, rccMix, mainBarMm, termiteTreatment, dpcMaterial,
-- soilType, waterTableDepthFt, dewateringNeeded, soilTestDone, soilTestNote, notes }.
-- "Project" already has RLS (tenant_isolation) and table-level grants to app_user, which cover
-- the new column; no policy or grant changes needed.

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "foundation" JSONB;
