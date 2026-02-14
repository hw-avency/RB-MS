ALTER TABLE "Employee"
  ADD COLUMN "photoUrl" TEXT,
  ADD COLUMN "photoEtag" TEXT,
  ADD COLUMN "photoData" BYTEA,
  ADD COLUMN "photoType" TEXT,
  ADD COLUMN "photoUpdatedAt" TIMESTAMP(3);
