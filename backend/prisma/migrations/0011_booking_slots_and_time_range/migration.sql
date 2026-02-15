-- CreateEnum
CREATE TYPE "BookingSlot" AS ENUM ('FULL_DAY', 'MORNING', 'AFTERNOON', 'CUSTOM');

-- AlterTable
ALTER TABLE "Booking"
  ADD COLUMN "slot" "BookingSlot" NOT NULL DEFAULT 'FULL_DAY',
  ADD COLUMN "startMinute" INTEGER,
  ADD COLUMN "endMinute" INTEGER;

-- DropIndex
DROP INDEX IF EXISTS "Booking_deskId_date_key";

-- CreateIndex
CREATE INDEX "Booking_deskId_date_slot_idx" ON "Booking"("deskId", "date", "slot");
