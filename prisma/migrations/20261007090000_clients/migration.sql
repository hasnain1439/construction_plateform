-- CreateTable
CREATE TABLE "Client" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Client_tenantId_name_idx" ON "Client"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Client_tenantId_id_key" ON "Client"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Client_tenantId_phone_key" ON "Client"("tenantId", "phone");

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- Row-level security (tenant isolation) + app_user access
ALTER TABLE "Client" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Client" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Client"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "Client" TO app_user;
