-- Session: allow employee-based sessions (SSO) without local User row
ALTER TABLE "Session" ADD COLUMN "employeeId" TEXT;
ALTER TABLE "Session" ALTER COLUMN "userId" DROP NOT NULL;

CREATE INDEX "Session_employeeId_idx" ON "Session"("employeeId");

ALTER TABLE "Session"
  ADD CONSTRAINT "Session_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Booking: store creator email for SSO users and allow null createdByUserId
ALTER TABLE "Booking" ADD COLUMN "createdByEmail" TEXT;
ALTER TABLE "Booking" ALTER COLUMN "createdByUserId" DROP NOT NULL;

DROP INDEX IF EXISTS "Booking_createdByUserId_idx";
CREATE INDEX "Booking_createdByUserId_idx" ON "Booking"("createdByUserId");
CREATE INDEX "Booking_createdByEmail_idx" ON "Booking"("createdByEmail");

ALTER TABLE "Booking" DROP CONSTRAINT IF EXISTS "Booking_createdByUserId_fkey";
ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill creator email from related user where available
UPDATE "Booking" b
SET "createdByEmail" = LOWER(u."email")
FROM "User" u
WHERE b."createdByUserId" = u."id"
  AND b."createdByEmail" IS NULL;

-- Fallback for legacy rows
UPDATE "Booking"
SET "createdByEmail" = LOWER("userEmail")
WHERE "createdByEmail" IS NULL
  AND "userEmail" IS NOT NULL;
