-- Add canonical creator relation to Employee
ALTER TABLE "Booking" ADD COLUMN "creatorUnknown" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Booking" ADD COLUMN "createdByEmployeeId" TEXT;

-- 1) prefer existing SELF assignee (same person as creator in legacy rows)
UPDATE "Booking" b
SET "createdByEmployeeId" = e."id"
FROM "Employee" e
WHERE b."createdByEmployeeId" IS NULL
  AND b."userEmail" IS NOT NULL
  AND LOWER(e."email") = LOWER(b."userEmail");

-- 2) map legacy local-user creator to employee by email
UPDATE "Booking" b
SET "createdByEmployeeId" = e."id"
FROM "User" u
JOIN "Employee" e ON LOWER(e."email") = LOWER(u."email")
WHERE b."createdByEmployeeId" IS NULL
  AND b."createdByUserId" IS NOT NULL
  AND b."createdByUserId" = u."id";

-- 3) map explicit creator email to employee
UPDATE "Booking" b
SET "createdByEmployeeId" = e."id"
FROM "Employee" e
WHERE b."createdByEmployeeId" IS NULL
  AND b."createdByEmail" IS NOT NULL
  AND LOWER(e."email") = LOWER(b."createdByEmail");

-- 4) final fallback: assign admin employee and mark unknown
WITH fallback_admin AS (
  SELECT "id"
  FROM "Employee"
  WHERE "role" = 'admin' AND "isActive" = true
  ORDER BY "createdAt" ASC
  LIMIT 1
)
UPDATE "Booking" b
SET
  "createdByEmployeeId" = fallback_admin."id",
  "creatorUnknown" = true
FROM fallback_admin
WHERE b."createdByEmployeeId" IS NULL;

-- If rows are still unmapped and no admin exists, fail migration to avoid nullable creator state.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Booking" WHERE "createdByEmployeeId" IS NULL) THEN
    RAISE EXCEPTION 'Backfill failed: Booking.createdByEmployeeId still NULL after migration.';
  END IF;
END $$;

ALTER TABLE "Booking" ALTER COLUMN "createdByEmployeeId" SET NOT NULL;

CREATE INDEX "Booking_createdByEmployeeId_idx" ON "Booking"("createdByEmployeeId");

ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_createdByEmployeeId_fkey"
  FOREIGN KEY ("createdByEmployeeId") REFERENCES "Employee"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
