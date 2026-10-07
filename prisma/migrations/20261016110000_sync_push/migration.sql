-- CreateEnum
CREATE TYPE "SyncMutationStatus" AS ENUM ('APPLIED', 'REJECTED');

-- CreateTable
CREATE TABLE "SyncIdMap" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "entity" TEXT NOT NULL,
    "serverId" UUID,
    "status" "SyncMutationStatus" NOT NULL,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "errorDetails" JSONB,
    "deviceId" UUID,
    "userId" UUID NOT NULL,
    "deviceCreatedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncIdMap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SyncIdMap_tenantId_deviceId_status_createdAt_idx" ON "SyncIdMap"("tenantId", "deviceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "SyncIdMap_tenantId_serverId_idx" ON "SyncIdMap"("tenantId", "serverId");

-- CreateIndex
CREATE UNIQUE INDEX "SyncIdMap_tenantId_clientId_key" ON "SyncIdMap"("tenantId", "clientId");


-- Row-level security (tenant isolation) + app_user access
ALTER TABLE "SyncIdMap" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SyncIdMap" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SyncIdMap"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- A mutation's outcome is written once and never changed.
GRANT SELECT, INSERT ON "SyncIdMap" TO app_user;
