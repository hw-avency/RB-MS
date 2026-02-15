-- CreateEnum
CREATE TYPE "ResourceKind" AS ENUM ('TISCH', 'PARKPLATZ', 'RAUM', 'SONSTIGES');

-- AlterTable
ALTER TABLE "Desk" ADD COLUMN "kind" "ResourceKind" NOT NULL DEFAULT 'TISCH';
