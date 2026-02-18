CREATE TYPE "FeedbackReportStatus" AS ENUM ('IN_ARBEIT', 'ABGELEHNT', 'ERLEDIGT');

ALTER TABLE "FeedbackReport"
ADD COLUMN "status" "FeedbackReportStatus" NOT NULL DEFAULT 'IN_ARBEIT';

DROP INDEX IF EXISTS "FeedbackReport_type_createdAt_idx";
CREATE INDEX "FeedbackReport_type_status_createdAt_idx" ON "FeedbackReport"("type", "status", "createdAt");
