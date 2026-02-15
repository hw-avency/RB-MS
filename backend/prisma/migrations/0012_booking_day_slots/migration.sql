CREATE TYPE "DaySlot" AS ENUM ('AM', 'PM', 'FULL');

ALTER TABLE "Booking"
  ADD COLUMN "daySlot" "DaySlot",
  ADD COLUMN "startTime" TIMESTAMP(3),
  ADD COLUMN "endTime" TIMESTAMP(3);
