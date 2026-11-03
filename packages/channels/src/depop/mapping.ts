import {
  DEPOP_CONDITION,
  DEPOP_MAX_PICTURES,
  depopDescription,
  depopSizeFor,
  type DepopDetails,
  type ProductConditionCode,
} from "@hub/shared";
import type { DepopProductBody } from "./client.js";

export interface SellableItem {
  sku: string;
  /** Prix sur Depop, après la règle de prix du canal. */
  priceCents: number;
  quantity: number;
  attributes?: Record<string, string>;
}

export interface DepopListingInput {
  product: { title: string; description: string; brand: string | null; condition: ProductConditionCode; currency: string };
  details: DepopDetails;
  item: SellableItem;
  pictureUrls: string[];
  shipFromState: string;
}

const amount = (cents: number) => (cents / 100).toFixed(2);

/** Fiche OmniList → annonce Depop (les contrôles de depopIssues doivent être passés avant). */
export function buildDepopBody({ product, details, item, pictureUrls, shipFromState }: DepopListingInput): DepopProductBody {
  const size = depopSizeFor(details, item);
  return {
    address: { country_code: "US", state: shipFromState },
    description: depopDescription(product.title, product.description),
    price_currency: product.currency,
    price_amount: amount(item.priceCents),
    quantity: item.quantity,
    pictures: pictureUrls.slice(0, DEPOP_MAX_PICTURES).map((url) => ({ url })),
    department: details.department!,
    product_type: details.productType!,
    ...(size ? { size_set_id: size.sizeSetId, size_id: size.sizeId } : {}),
    condition: DEPOP_CONDITION[product.condition],
    brand_name: product.brand?.trim() ?? "",
    attributes: {},
    national_shipping_cost: amount(details.shippingCents ?? 0),
  };
}
