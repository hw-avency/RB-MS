ALTER TABLE "Employee"
ADD COLUMN "entraOid" TEXT,
ADD COLUMN "tenantId" TEXT,
ADD COLUMN "lastLoginAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Employee_entraOid_key" ON "Employee"("entraOid");
