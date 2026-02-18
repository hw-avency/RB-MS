ALTER TABLE "Desk"
ADD COLUMN "hasCharger" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Booking" AS b
SET
  "daySlot" = NULL,
  "slot" = 'CUSTOM',
  "startMinute" = CASE
    WHEN COALESCE(b."daySlot"::text, '') = 'AM' OR b."slot" = 'MORNING' THEN 0
    WHEN COALESCE(b."daySlot"::text, '') = 'PM' OR b."slot" = 'AFTERNOON' THEN 720
    ELSE 0
  END,
  "endMinute" = CASE
    WHEN COALESCE(b."daySlot"::text, '') = 'AM' OR b."slot" = 'MORNING' THEN 720
    WHEN COALESCE(b."daySlot"::text, '') = 'PM' OR b."slot" = 'AFTERNOON' THEN 1440
    ELSE 1440
  END,
  "startTime" = (b."date"::timestamp + make_interval(mins => CASE
    WHEN COALESCE(b."daySlot"::text, '') = 'AM' OR b."slot" = 'MORNING' THEN 0
    WHEN COALESCE(b."daySlot"::text, '') = 'PM' OR b."slot" = 'AFTERNOON' THEN 720
    ELSE 0
  END)),
  "endTime" = (b."date"::timestamp + make_interval(mins => CASE
    WHEN COALESCE(b."daySlot"::text, '') = 'AM' OR b."slot" = 'MORNING' THEN 720
    WHEN COALESCE(b."daySlot"::text, '') = 'PM' OR b."slot" = 'AFTERNOON' THEN 1440
    ELSE 1440
  END))
FROM "Desk" AS d
WHERE b."deskId" = d."id"
  AND d."kind" = 'PARKPLATZ';
