-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN "entraId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_entraId_key" ON "Tenant"("entraId");
