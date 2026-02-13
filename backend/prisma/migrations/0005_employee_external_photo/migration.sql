-- AlterTable
ALTER TABLE "Employee"
ADD COLUMN "externalId" TEXT,
ADD COLUMN "photoBase64" TEXT,
ADD COLUMN "photoFetchedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Employee_externalId_key" ON "Employee"("externalId");
