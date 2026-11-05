-- CreateEnum
CREATE TYPE "BrowserTaskType" AS ENUM ('LIST', 'UPDATE', 'DELIST');

-- CreateEnum
CREATE TYPE "BrowserTaskStatus" AS ENUM ('QUEUED', 'CLAIMED', 'DONE', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "ExtensionDevice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "extensionVersion" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtensionDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelConsent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "version" INTEGER NOT NULL,
    "acceptedById" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dailyCap" INTEGER NOT NULL,
    "pausedAt" TIMESTAMP(3),
    "pauseReason" TEXT,

    CONSTRAINT "ChannelConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteSwitch" (
    "channel" "Channel" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "selectorsVersion" INTEGER NOT NULL DEFAULT 1,
    "reason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteSwitch_pkey" PRIMARY KEY ("channel")
);

-- CreateTable
CREATE TABLE "BrowserTask" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "type" "BrowserTaskType" NOT NULL,
    "status" "BrowserTaskStatus" NOT NULL DEFAULT 'QUEUED',
    "productId" TEXT,
    "skuCode" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "deviceId" TEXT,
    "claimedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrowserTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExtensionDevice_tokenHash_key" ON "ExtensionDevice"("tokenHash");

-- CreateIndex
CREATE INDEX "ExtensionDevice_organizationId_idx" ON "ExtensionDevice"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelConsent_organizationId_channel_key" ON "ChannelConsent"("organizationId", "channel");

-- CreateIndex
CREATE INDEX "BrowserTask_organizationId_status_idx" ON "BrowserTask"("organizationId", "status");

-- CreateIndex
CREATE INDEX "BrowserTask_organizationId_channel_skuCode_idx" ON "BrowserTask"("organizationId", "channel", "skuCode");

-- CreateIndex
CREATE INDEX "BrowserTask_channel_completedAt_idx" ON "BrowserTask"("channel", "completedAt");

-- AddForeignKey
ALTER TABLE "ExtensionDevice" ADD CONSTRAINT "ExtensionDevice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelConsent" ADD CONSTRAINT "ChannelConsent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrowserTask" ADD CONSTRAINT "BrowserTask_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrowserTask" ADD CONSTRAINT "BrowserTask_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ExtensionDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

