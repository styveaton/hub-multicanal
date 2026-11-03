-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('CHANNEL', 'MANUAL');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PAID', 'SHIPPED', 'COMPLETED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "SyncLogType" AS ENUM ('SALE', 'RESTOCK', 'ADJUSTMENT', 'OVERSOLD', 'UNKNOWN_SKU', 'CHANNEL_UPDATE', 'CHANNEL_ERROR');

-- AlterTable
ALTER TABLE "ChannelConnection" ADD COLUMN     "ordersSyncedAt" TIMESTAMP(3),
ADD COLUMN     "webhookId" TEXT,
ADD COLUMN     "webhookSecretEnc" TEXT;

-- AlterTable
ALTER TABLE "Sku" ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 0;

-- Stock central : on reprend les quantités existantes avant de retirer l'ancienne colonne.
-- Variantes : quantité de la variante. Articles uniques : 1.
UPDATE "Sku" s SET "quantity" = v."quantity" FROM "ProductVariant" v WHERE s."variantId" = v."id";
UPDATE "Sku" SET "quantity" = 1 WHERE "variantId" IS NULL;

-- Le stock ne descend jamais sous 0 (une double vente est tracée à part, dans OrderLine.oversoldQty).
ALTER TABLE "Sku" ADD CONSTRAINT "Sku_quantity_check" CHECK ("quantity" >= 0);

-- AlterTable
ALTER TABLE "ProductVariant" DROP COLUMN "quantity";

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "channel" "Channel",
    "source" "OrderSource" NOT NULL,
    "externalOrderId" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PAID',
    "buyerName" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "totalCents" INTEGER NOT NULL,
    "placedAt" TIMESTAMP(3) NOT NULL,
    "restockedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLine" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "skuCode" TEXT NOT NULL,
    "productId" TEXT,
    "title" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,
    "oversoldQty" INTEGER NOT NULL DEFAULT 0,
    "matched" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "OrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" "SyncLogType" NOT NULL,
    "channel" "Channel",
    "skuCode" TEXT,
    "productId" TEXT,
    "orderId" TEXT,
    "delta" INTEGER,
    "quantityAfter" INTEGER,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Order_organizationId_placedAt_idx" ON "Order"("organizationId", "placedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_organizationId_channel_externalOrderId_key" ON "Order"("organizationId", "channel", "externalOrderId");

-- CreateIndex
CREATE INDEX "OrderLine_orderId_idx" ON "OrderLine"("orderId");

-- CreateIndex
CREATE INDEX "SyncLog_organizationId_createdAt_idx" ON "SyncLog"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncLog" ADD CONSTRAINT "SyncLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

