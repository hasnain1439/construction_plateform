-- Roof / slab (lenter) per floor and walls per room side, for the detailed estimate.
-- * "Floor"."roof" JSONB: NULL = not entered (the estimate falls back to the settings % method).
--   Shape validated by zod in src/modules/projects/roof.ts (every key present, null where it does
--   not apply to the roof type).
-- * "Room"."walls" JSONB: NULL = not entered; else exactly four sides TOP / RIGHT / BOTTOM / LEFT
--   { side, type, thicknessIn, innerLeafIn, cavityIn, sharedWithRoomId, sharedWithSide, existing }
--   (src/modules/projects/walls.ts). Shared sides are paired on both rooms by the service.
-- * "Opening"."side": the room side the door / window is in (NULL = not placed; deducted from the
--   room as a whole).
-- The three tables already have RLS (tenant_isolation) and table-level grants to app_user, which
-- cover the new columns; the new enum type is usable by app_user through the schema USAGE grant.

-- CreateEnum
CREATE TYPE "WallSide" AS ENUM ('TOP', 'RIGHT', 'BOTTOM', 'LEFT');

-- AlterTable
ALTER TABLE "Floor" ADD COLUMN     "roof" JSONB;

-- AlterTable
ALTER TABLE "Room" ADD COLUMN     "walls" JSONB;

-- AlterTable
ALTER TABLE "Opening" ADD COLUMN     "side" "WallSide";
