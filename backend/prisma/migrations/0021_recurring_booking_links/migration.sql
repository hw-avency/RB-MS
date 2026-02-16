ALTER TABLE "RecurringBooking"
ADD COLUMN "groupId" TEXT;

UPDATE "RecurringBooking"
SET "groupId" = md5(random()::text || clock_timestamp()::text)
WHERE "groupId" IS NULL;

ALTER TABLE "RecurringBooking"
ALTER COLUMN "groupId" SET NOT NULL;

ALTER TABLE "Booking"
ADD COLUMN "recurringBookingId" TEXT,
ADD COLUMN "recurringGroupId" TEXT;

WITH ranked_matches AS (
  SELECT
    b."id" AS booking_id,
    rb."id" AS recurring_booking_id,
    rb."groupId" AS recurring_group_id,
    ROW_NUMBER() OVER (
      PARTITION BY b."id"
      ORDER BY rb."createdAt" DESC, rb."id" DESC
    ) AS match_rank
  FROM "Booking" b
  INNER JOIN "RecurringBooking" rb
    ON rb."resourceId" = b."deskId"
   AND rb."createdByEmployeeId" = b."createdByEmployeeId"
   AND rb."bookedFor" = b."bookedFor"
   AND COALESCE(rb."guestName", '') = COALESCE(b."guestName", '')
   AND b."date" BETWEEN rb."startDate" AND rb."endDate"
   AND (
     (rb."period" IS NOT NULL AND rb."period" = b."daySlot")
     OR (
       rb."startTime" IS NOT NULL
       AND rb."endTime" IS NOT NULL
       AND rb."startTime" = to_char(b."startTime"::time, 'HH24:MI')
       AND rb."endTime" = to_char(b."endTime"::time, 'HH24:MI')
     )
   )
)
UPDATE "Booking" b
SET
  "recurringBookingId" = rm.recurring_booking_id,
  "recurringGroupId" = rm.recurring_group_id
FROM ranked_matches rm
WHERE b."id" = rm.booking_id
  AND rm.match_rank = 1
  AND b."recurringBookingId" IS NULL;

UPDATE "Booking" b
SET "recurringGroupId" = rb."groupId"
FROM "RecurringBooking" rb
WHERE b."recurringBookingId" = rb."id"
  AND b."recurringGroupId" IS NULL;

ALTER TABLE "Booking"
ADD CONSTRAINT "Booking_recurringBookingId_fkey"
FOREIGN KEY ("recurringBookingId") REFERENCES "RecurringBooking"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Booking_recurringBookingId_idx" ON "Booking"("recurringBookingId");
CREATE INDEX "Booking_recurringGroupId_idx" ON "Booking"("recurringGroupId");
CREATE INDEX "RecurringBooking_groupId_idx" ON "RecurringBooking"("groupId");
