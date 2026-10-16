-- Estimate (BoQ) settings of a project: the grey-structure estimate assumptions the user changed
-- (wall thickness, slab thickness, mixes, steel %, wastage, foundation wall length, labour rate …).
-- One nullable JSONB column holding ONLY the changed keys; NULL = every Pakistani default
-- (src/modules/estimate/settings.ts), so existing projects need no backfill.
-- "Project" already has RLS (tenant_isolation) and table-level grants to app_user, which cover
-- the new column; no policy or grant changes needed.

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "estimateSettings" JSONB;
