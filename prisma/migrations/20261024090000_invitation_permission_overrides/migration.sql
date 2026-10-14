-- Invite with permissions: the extra (ALLOW) / removed (DENY) permissions chosen in the invite
-- form on top of the invitation's role. Validated at create (like PUT /users/:id/permission-overrides)
-- and copied to UserPermissionOverride rows when the invitation is accepted.
-- Shape: [{ "key", "effect", "scope", "maxAmountPaisa" (string | null), "note" }].

-- AlterTable
ALTER TABLE "Invitation" ADD COLUMN     "permissionOverrides" JSONB NOT NULL DEFAULT '[]';
