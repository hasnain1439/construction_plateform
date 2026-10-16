-- Step 16 part 2 · Shuttering demand planner + idle-rent alert.
-- * TenantSettings: idle-rent threshold (days without milestone activity at the site) and the
--   planner parameters (props per plate, spare plates %). Owner-editable, engineer review.
-- * NotificationType EQUIPMENT_IDLE (rented units idle at a site; dedupe per rental per week).

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'EQUIPMENT_IDLE';

-- AlterTable
ALTER TABLE "TenantSettings"
  ADD COLUMN "equipmentIdleDays" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "shutteringPropsPerPlate" DECIMAL(4,2) NOT NULL DEFAULT 0.75,
  ADD COLUMN "shutteringSparePercent" INTEGER NOT NULL DEFAULT 5;
