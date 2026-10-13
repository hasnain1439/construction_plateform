-- Production providers: one MessageDelivery row per outgoing SMS / email / WhatsApp message
-- (status QUEUED → SENT / FAILED, provider message id, error). Written by the platform
-- (app_admin); `to` is masked and message bodies are never stored.

-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('SMS', 'EMAIL', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "MessageDelivery" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "channel" "MessageChannel" NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'QUEUED',
    "providerId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageDelivery_tenantId_createdAt_idx" ON "MessageDelivery"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "MessageDelivery_channel_status_createdAt_idx" ON "MessageDelivery"("channel", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "MessageDelivery" ADD CONSTRAINT "MessageDelivery_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security: the platform (app_admin, BYPASSRLS) writes every row; a company (app_user)
-- may only read its own rows. Rows without a company (tenantId NULL) are platform-only.
-- app_admin gets access through the default privileges of the init migration.
ALTER TABLE "MessageDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MessageDelivery" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "MessageDelivery"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT ON "MessageDelivery" TO app_user;
