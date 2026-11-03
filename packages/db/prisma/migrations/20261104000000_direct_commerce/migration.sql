-- WooCommerce rejoint les canaux ; Shopify et WooCommerce sont branchés de bout en bout.
ALTER TYPE "Channel" ADD VALUE 'WOOCOMMERCE' AFTER 'SHOPIFY';

-- Boutique Shopify visée pendant la connexion OAuth.
ALTER TABLE "OAuthState" ADD COLUMN "extra" JSONB;

-- Produit parent chez le canal et données techniques (article de stock, empreinte des photos).
ALTER TABLE "ChannelListing" ADD COLUMN "externalParentId" TEXT,
ADD COLUMN "externalMeta" JSONB;
