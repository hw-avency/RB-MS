ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "employeeId" TEXT;

UPDATE "Booking"
SET "employeeId" = "createdByEmployeeId"
WHERE "bookedFor" = 'SELF'
  AND "employeeId" IS NULL
  AND "createdByEmployeeId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "Booking_employeeId_date_idx" ON "Booking"("employeeId", "date");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Booking_employeeId_fkey'
  ) THEN
    ALTER TABLE "Booking"
      ADD CONSTRAINT "Booking_employeeId_fkey"
      FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;
