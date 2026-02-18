-- CreateTable
CREATE TABLE "SystemState" (
    "id" TEXT NOT NULL,
    "forceReauthAfter" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemState_pkey" PRIMARY KEY ("id")
);
