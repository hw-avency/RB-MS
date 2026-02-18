ALTER TABLE "Tenant" ADD COLUMN "entraTenantId" TEXT;
CREATE UNIQUE INDEX "Tenant_entraTenantId_key" ON "Tenant"("entraTenantId");
