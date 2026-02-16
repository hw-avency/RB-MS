DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RecurrencePatternType') THEN
    CREATE TYPE "RecurrencePatternType" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY');
  END IF;
END $$;

ALTER TABLE "RecurringBooking"
  RENAME COLUMN "validFrom" TO "startDate";

ALTER TABLE "RecurringBooking"
  RENAME COLUMN "validTo" TO "endDate";

ALTER TABLE "RecurringBooking"
  ADD COLUMN "patternType" "RecurrencePatternType" NOT NULL DEFAULT 'WEEKLY',
  ADD COLUMN "interval" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "byWeekday" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN "byMonthday" INTEGER,
  ADD COLUMN "bySetPos" INTEGER,
  ADD COLUMN "byMonth" INTEGER;

UPDATE "RecurringBooking"
SET "byWeekday" = ARRAY[CASE WHEN "weekday" = 0 THEN 7 ELSE "weekday" END];

UPDATE "RecurringBooking"
SET "endDate" = "startDate"
WHERE "endDate" IS NULL;

ALTER TABLE "RecurringBooking"
  ALTER COLUMN "endDate" SET NOT NULL;

DROP INDEX IF EXISTS "RecurringBooking_resourceId_weekday_validFrom_validTo_idx";
DROP INDEX IF EXISTS "RecurringBooking_resourceId_weekday_startDate_endDate_idx";
CREATE INDEX "RecurringBooking_resourceId_startDate_endDate_idx" ON "RecurringBooking"("resourceId", "startDate", "endDate");

ALTER TABLE "RecurringBooking"
  DROP COLUMN "weekday";
