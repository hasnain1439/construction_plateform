-- Replace the composite (id, logoAttachmentId) FK: it stopped Prisma generating Tenant.id.
-- Same-tenant logos are enforced by the company service (RLS lookup + kind LOGO).
-- DropForeignKey
ALTER TABLE "Tenant" DROP CONSTRAINT "Tenant_id_logoAttachmentId_fkey";

-- AddForeignKey
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_logoAttachmentId_fkey" FOREIGN KEY ("logoAttachmentId") REFERENCES "Attachment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

