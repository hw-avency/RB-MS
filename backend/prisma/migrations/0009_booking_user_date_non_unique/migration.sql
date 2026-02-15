DROP INDEX IF EXISTS "Booking_userEmail_date_key";
CREATE INDEX IF NOT EXISTS "Booking_userEmail_date_idx" ON "Booking"("userEmail", "date");
