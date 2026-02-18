-- CreateEnum
CREATE TYPE "FeedbackReportType" AS ENUM ('BUG', 'FEATURE_REQUEST');

-- CreateTable
CREATE TABLE "FeedbackReport" (
    "id" TEXT NOT NULL,
    "type" "FeedbackReportType" NOT NULL,
    "message" TEXT NOT NULL,
    "reporterUserId" TEXT,
    "reporterEmployeeId" TEXT,
    "reporterEmail" TEXT NOT NULL,
    "reporterDisplayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeedbackReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FeedbackReport_type_createdAt_idx" ON "FeedbackReport"("type", "createdAt");

-- CreateIndex
CREATE INDEX "FeedbackReport_reporterEmail_createdAt_idx" ON "FeedbackReport"("reporterEmail", "createdAt");

-- CreateIndex
CREATE INDEX "FeedbackReport_reporterUserId_idx" ON "FeedbackReport"("reporterUserId");

-- CreateIndex
CREATE INDEX "FeedbackReport_reporterEmployeeId_idx" ON "FeedbackReport"("reporterEmployeeId");

-- CreateIndex
CREATE INDEX "FeedbackReport_createdAt_idx" ON "FeedbackReport"("createdAt");

-- AddForeignKey
ALTER TABLE "FeedbackReport" ADD CONSTRAINT "FeedbackReport_reporterUserId_fkey" FOREIGN KEY ("reporterUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackReport" ADD CONSTRAINT "FeedbackReport_reporterEmployeeId_fkey" FOREIGN KEY ("reporterEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
