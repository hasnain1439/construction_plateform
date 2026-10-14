-- Pilot · Part 8 — languages on the server:
--  * Invitation.language: the invite SMS / email language, copied to the user on accept,
--  * Notification.textKey + params: the inbox renders each notification in the reader's language
--    (title / body stay as the text rendered for the recipient when it was created).

-- AlterTable
ALTER TABLE "Invitation" ADD COLUMN     "language" "Language" NOT NULL DEFAULT 'ROMAN_URDU';

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "params" JSONB,
ADD COLUMN     "textKey" TEXT;
