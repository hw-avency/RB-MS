-- Generalize RecurringBooking from desk/userEmail to resource/creator semantics
ALTER TABLE "RecurringBooking" RENAME COLUMN "deskId" TO "resourceId";
ALTER TABLE "RecurringBooking" ADD COLUMN "createdByEmployeeId" TEXT;
ALTER TABLE "RecurringBooking" ADD COLUMN "bookedFor" "BookedFor" NOT NULL DEFAULT 'SELF';
ALTER TABLE "RecurringBooking" ADD COLUMN "guestName" TEXT;
ALTER TABLE "RecurringBooking" ADD COLUMN "period" "DaySlot";
ALTER TABLE "RecurringBooking" ADD COLUMN "startTime" TEXT;
ALTER TABLE "RecurringBooking" ADD COLUMN "endTime" TEXT;

-- map creator from legacy userEmail
UPDATE "RecurringBooking" rb
SET "createdByEmployeeId" = e."id"
FROM "Employee" e
WHERE rb."createdByEmployeeId" IS NULL
  AND LOWER(e."email") = LOWER(rb."userEmail");

-- fallback to first active admin employee
WITH fallback_admin AS (
  SELECT "id"
  FROM "Employee"
  WHERE "role" = 'admin' AND "isActive" = true
  ORDER BY "createdAt" ASC
  LIMIT 1
)
UPDATE "RecurringBooking" rb
SET "createdByEmployeeId" = fallback_admin."id"
FROM fallback_admin
WHERE rb."createdByEmployeeId" IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "RecurringBooking" WHERE "createdByEmployeeId" IS NULL) THEN
    RAISE EXCEPTION 'Backfill failed: RecurringBooking.createdByEmployeeId still NULL after migration.';
  END IF;
END $$;

-- legacy rows represented whole-day by weekday only
UPDATE "RecurringBooking"
SET "period" = 'FULL'
WHERE "period" IS NULL;

ALTER TABLE "RecurringBooking" ALTER COLUMN "createdByEmployeeId" SET NOT NULL;

ALTER TABLE "RecurringBooking" DROP COLUMN "userEmail";

DROP INDEX IF EXISTS "RecurringBooking_deskId_idx";
CREATE INDEX "RecurringBooking_resourceId_weekday_validFrom_validTo_idx" ON "RecurringBooking"("resourceId", "weekday", "validFrom", "validTo");
CREATE INDEX "RecurringBooking_createdByEmployeeId_idx" ON "RecurringBooking"("createdByEmployeeId");

ALTER TABLE "RecurringBooking" DROP CONSTRAINT IF EXISTS "RecurringBooking_deskId_fkey";
ALTER TABLE "RecurringBooking" ADD CONSTRAINT "RecurringBooking_resourceId_fkey"
  FOREIGN KEY ("resourceId") REFERENCES "Desk"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecurringBooking" ADD CONSTRAINT "RecurringBooking_createdByEmployeeId_fkey"
  FOREIGN KEY ("createdByEmployeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
