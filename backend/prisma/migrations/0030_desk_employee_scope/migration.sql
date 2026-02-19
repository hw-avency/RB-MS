-- CreateEnum
CREATE TYPE "DeskEmployeeScope" AS ENUM ('ALL', 'SELECTED');

-- AlterTable
ALTER TABLE "Desk"
ADD COLUMN "employeeScope" "DeskEmployeeScope" NOT NULL DEFAULT 'ALL';

-- CreateTable
CREATE TABLE "DeskEmployee" (
    "deskId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeskEmployee_pkey" PRIMARY KEY ("deskId","employeeId")
);

-- CreateIndex
CREATE INDEX "DeskEmployee_employeeId_idx" ON "DeskEmployee"("employeeId");

-- AddForeignKey
ALTER TABLE "DeskEmployee" ADD CONSTRAINT "DeskEmployee_deskId_fkey" FOREIGN KEY ("deskId") REFERENCES "Desk"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeskEmployee" ADD CONSTRAINT "DeskEmployee_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
