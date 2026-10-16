-- Step 17 · Closeout: drawings (+ revisions), snags, project handover (+ checklist items),
-- retention reminder notification type.
-- * Drawing / DrawingRevision: superseded revisions stay (isLatest = false); the file is a
--   DOCUMENT attachment (composite FK).
-- * Snag: per-project number, before / after photo ids (SITE_PHOTO attachments), assignee worker or
--   sub-contractor, cost attribution (REWORK → project cost engine, SUBCONTRACTOR_DEDUCTION →
--   SubcontractLedgerEntry DEDUCTION, CHANGE_ORDER → flag only), defect-period flag, offline clientId.
-- * ProjectHandover / HandoverItem: checklist, owner sign-off, handover date, defect period and
--   retention due date, reminder settings.
-- Every new table: ENABLE + FORCE RLS, tenant_isolation policy, explicit grants to app_user.
-- Drawing, DrawingRevision and Snag are tracked for offline sync (sync_track triggers).

-- CreateEnum
CREATE TYPE "DrawingFolder" AS ENUM ('ARCHITECTURAL', 'STRUCTURAL', 'MEP', 'SOCIETY_APPROVED', 'OTHER');

-- CreateEnum
CREATE TYPE "SnagStatus" AS ENUM ('OPEN', 'FIXED', 'VERIFIED');

-- CreateEnum
CREATE TYPE "SnagCostAttribution" AS ENUM ('NONE', 'REWORK', 'SUBCONTRACTOR_DEDUCTION', 'CHANGE_ORDER');

-- CreateEnum
CREATE TYPE "HandoverItemKey" AS ENUM ('KEYS', 'ELECTRICITY_CONNECTION', 'GAS_CONNECTION', 'WATER_CONNECTION', 'WARRANTY_CARDS', 'FINAL_DRAWINGS', 'FINAL_PHOTOS');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'RETENTION_RELEASE_DUE';

-- CreateTable
CREATE TABLE "Drawing" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "folder" "DrawingFolder" NOT NULL,
    "title" TEXT NOT NULL,
    "number" TEXT,
    "milestoneId" UUID,
    "notes" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Drawing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DrawingRevision" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "drawingId" UUID NOT NULL,
    "revisionNo" INTEGER NOT NULL,
    "attachmentId" UUID NOT NULL,
    "approvedAt" DATE,
    "notes" TEXT,
    "isLatest" BOOLEAN NOT NULL DEFAULT true,
    "uploadedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DrawingRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Snag" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "roomId" UUID,
    "location" TEXT,
    "description" TEXT NOT NULL,
    "beforePhotoIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "afterPhotoIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "workerId" UUID,
    "subcontractorId" UUID,
    "targetDate" DATE,
    "status" "SnagStatus" NOT NULL DEFAULT 'OPEN',
    "inDefectPeriod" BOOLEAN NOT NULL DEFAULT false,
    "fixNote" TEXT,
    "fixedAt" TIMESTAMPTZ(3),
    "fixedById" UUID,
    "verifiedAt" TIMESTAMPTZ(3),
    "verifiedById" UUID,
    "reopenCount" INTEGER NOT NULL DEFAULT 0,
    "lastReopenReason" TEXT,
    "costAttribution" "SnagCostAttribution" NOT NULL DEFAULT 'NONE',
    "costAmountPaisa" BIGINT NOT NULL DEFAULT 0,
    "costNote" TEXT,
    "costAssignmentId" UUID,
    "costPostedAt" TIMESTAMPTZ(3),
    "clientId" UUID,
    "deviceCreatedAt" TIMESTAMPTZ(3),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Snag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectHandover" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "ownerName" TEXT,
    "signedOn" DATE,
    "signatureAttachmentId" UUID,
    "signOffNote" TEXT,
    "signOffRecordedAt" TIMESTAMPTZ(3),
    "signOffRecordedById" UUID,
    "handedOverAt" DATE,
    "defectPeriodMonths" INTEGER,
    "retentionDueDate" DATE,
    "reminderDaysBefore" INTEGER NOT NULL DEFAULT 14,
    "retentionReminderSentAt" TIMESTAMPTZ(3),
    "retentionDueNotifiedAt" TIMESTAMPTZ(3),
    "certificateAttachmentId" UUID,
    "certificateGeneratedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ProjectHandover_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HandoverItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "handoverId" UUID NOT NULL,
    "key" "HandoverItemKey" NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "attachmentIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "doneAt" TIMESTAMPTZ(3),
    "doneById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "HandoverItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Drawing_tenantId_projectId_folder_idx" ON "Drawing"("tenantId", "projectId", "folder");

-- CreateIndex
CREATE UNIQUE INDEX "Drawing_tenantId_id_key" ON "Drawing"("tenantId", "id");

-- CreateIndex
CREATE INDEX "DrawingRevision_tenantId_drawingId_idx" ON "DrawingRevision"("tenantId", "drawingId");

-- CreateIndex
CREATE UNIQUE INDEX "DrawingRevision_tenantId_id_key" ON "DrawingRevision"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DrawingRevision_drawingId_revisionNo_key" ON "DrawingRevision"("drawingId", "revisionNo");

-- CreateIndex
CREATE INDEX "Snag_tenantId_projectId_status_idx" ON "Snag"("tenantId", "projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Snag_tenantId_id_key" ON "Snag"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Snag_projectId_number_key" ON "Snag"("projectId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Snag_tenantId_clientId_key" ON "Snag"("tenantId", "clientId");

-- CreateIndex
CREATE INDEX "ProjectHandover_retentionDueDate_idx" ON "ProjectHandover"("retentionDueDate");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectHandover_tenantId_id_key" ON "ProjectHandover"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectHandover_tenantId_projectId_key" ON "ProjectHandover"("tenantId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "HandoverItem_tenantId_id_key" ON "HandoverItem"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "HandoverItem_handoverId_key_key" ON "HandoverItem"("handoverId", "key");

-- AddForeignKey
ALTER TABLE "Drawing" ADD CONSTRAINT "Drawing_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Drawing" ADD CONSTRAINT "Drawing_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DrawingRevision" ADD CONSTRAINT "DrawingRevision_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DrawingRevision" ADD CONSTRAINT "DrawingRevision_tenantId_drawingId_fkey" FOREIGN KEY ("tenantId", "drawingId") REFERENCES "Drawing"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DrawingRevision" ADD CONSTRAINT "DrawingRevision_tenantId_attachmentId_fkey" FOREIGN KEY ("tenantId", "attachmentId") REFERENCES "Attachment"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Snag" ADD CONSTRAINT "Snag_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Snag" ADD CONSTRAINT "Snag_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Snag" ADD CONSTRAINT "Snag_tenantId_workerId_fkey" FOREIGN KEY ("tenantId", "workerId") REFERENCES "Worker"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Snag" ADD CONSTRAINT "Snag_tenantId_subcontractorId_fkey" FOREIGN KEY ("tenantId", "subcontractorId") REFERENCES "Subcontractor"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ProjectHandover" ADD CONSTRAINT "ProjectHandover_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectHandover" ADD CONSTRAINT "ProjectHandover_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "HandoverItem" ADD CONSTRAINT "HandoverItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoverItem" ADD CONSTRAINT "HandoverItem_tenantId_handoverId_fkey" FOREIGN KEY ("tenantId", "handoverId") REFERENCES "ProjectHandover"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ─── Row-level security + grants ────────────────────────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Drawing', 'DrawingRevision', 'Snag', 'ProjectHandover', 'HandoverItem']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON "Drawing" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "DrawingRevision" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Snag" TO app_user;
GRANT SELECT, INSERT, UPDATE ON "ProjectHandover" TO app_user;
GRANT SELECT, INSERT, UPDATE ON "HandoverItem" TO app_user;

-- ─── Offline sync change tracking (see 20261016100000_sync_changes) ────────
-- A revision is recorded as an UPDATE of its drawing (the phone keeps the latest one).
CREATE TRIGGER sync_track AFTER INSERT OR UPDATE OR DELETE ON "Drawing" FOR EACH ROW EXECUTE FUNCTION sync_track('Drawing', 'id', 'projectId', '');
CREATE TRIGGER sync_track AFTER INSERT OR UPDATE OR DELETE ON "DrawingRevision" FOR EACH ROW EXECUTE FUNCTION sync_track('Drawing', 'drawingId', '', '');
CREATE TRIGGER sync_track AFTER INSERT OR UPDATE OR DELETE ON "Snag" FOR EACH ROW EXECUTE FUNCTION sync_track('Snag', 'id', 'projectId', '');
