-- Milestone.billingStageId: ON DELETE NO ACTION, as declared in schema.prisma.
-- The schedule migration used ON DELETE SET NULL ("billingStageId"), which Prisma cannot express,
-- so `prisma migrate diff` reported drift. The wizard (the only place that replaces a project's
-- billing stages) now clears Milestone.billingStageId itself before deleting the stages.
ALTER TABLE "Milestone" DROP CONSTRAINT "Milestone_tenantId_billingStageId_fkey";

ALTER TABLE "Milestone" ADD CONSTRAINT "Milestone_tenantId_billingStageId_fkey" FOREIGN KEY ("tenantId", "billingStageId") REFERENCES "ProjectBillingStage"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
