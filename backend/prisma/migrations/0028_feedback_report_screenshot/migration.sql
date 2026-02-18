-- AlterTable
ALTER TABLE "FeedbackReport"
ADD COLUMN     "screenshotData" BYTEA,
ADD COLUMN     "screenshotMimeType" TEXT;
