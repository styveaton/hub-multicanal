-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Channel" ADD VALUE 'WALMART';
ALTER TYPE "Channel" ADD VALUE 'ETSY';
ALTER TYPE "Channel" ADD VALUE 'SHOPIFY';
ALTER TYPE "Channel" ADD VALUE 'FACEBOOK_MARKETPLACE';
ALTER TYPE "Channel" ADD VALUE 'MERCARI';
ALTER TYPE "Channel" ADD VALUE 'POSHMARK';
ALTER TYPE "Channel" ADD VALUE 'DEPOP';
ALTER TYPE "Channel" ADD VALUE 'VINTED';
ALTER TYPE "Channel" ADD VALUE 'GRAILED';
