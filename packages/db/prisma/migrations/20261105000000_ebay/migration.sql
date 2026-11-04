-- Identifiant de l'acheteur chez le canal (suppression de compte eBay).
ALTER TABLE "Order" ADD COLUMN "buyerRef" TEXT;
CREATE INDEX "Order_channel_buyerRef_idx" ON "Order"("channel", "buyerRef");
