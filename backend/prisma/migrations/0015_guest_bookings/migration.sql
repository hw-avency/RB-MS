-- CreateEnum
CREATE TYPE "BookedFor" AS ENUM ('SELF', 'GUEST');

-- AlterTable
ALTER TABLE "Booking"
  ADD COLUMN "bookedFor" "BookedFor",
  ADD COLUMN "guestName" TEXT,
  ADD COLUMN "createdByUserId" TEXT,
  ALTER COLUMN "userEmail" DROP NOT NULL;

-- Backfill existing bookings as SELF bookings
UPDATE "Booking"
SET "bookedFor" = 'SELF',
    "guestName" = NULL;

UPDATE "Booking" b
SET "createdByUserId" = u."id"
FROM "User" u
WHERE lower(u."email") = lower(b."userEmail")
  AND b."createdByUserId" IS NULL;

WITH fallback AS (
  SELECT "id"
  FROM "User"
  ORDER BY "createdAt" ASC
  LIMIT 1
)
UPDATE "Booking" b
SET "createdByUserId" = fallback."id"
FROM fallback
WHERE b."createdByUserId" IS NULL;

ALTER TABLE "Booking"
  ALTER COLUMN "bookedFor" SET NOT NULL,
  ALTER COLUMN "bookedFor" SET DEFAULT 'SELF',
  ALTER COLUMN "createdByUserId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "Booking_createdByUserId_idx" ON "Booking"("createdByUserId");

-- AddForeignKey
ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
