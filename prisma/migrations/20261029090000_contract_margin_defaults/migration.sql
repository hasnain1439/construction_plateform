-- Contract value from the estimate: company-wide default profit margin and finishing allowance,
-- with an optional per-project override (NULL = follow the company default).
-- * "TenantSettings"."defaultMarginPercent" (0–100, default 20) and
--   "TenantSettings"."defaultFinishingAllowancePercent" (0–200, default 0; FULL contracts only).
-- * "Project"."marginPercent" / "Project"."finishingAllowancePercent": set when a value is applied
--   from the estimate with a percentage that differs from the company default.
-- Both tables already have RLS (tenant_isolation) and table-level grants to app_user, which cover
-- the new columns; existing rows take the defaults / NULL, so no backfill is needed.

-- AlterTable
ALTER TABLE "TenantSettings" ADD COLUMN     "defaultMarginPercent" DECIMAL(5,2) NOT NULL DEFAULT 20,
ADD COLUMN     "defaultFinishingAllowancePercent" DECIMAL(5,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "marginPercent" DECIMAL(5,2),
ADD COLUMN     "finishingAllowancePercent" DECIMAL(5,2);
