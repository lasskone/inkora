/**
 * Provider-independent supplier model.
 *
 * The supplier-side equivalent of `@/lib/marketplace/types`: external supplier
 * data (CJdropshipping today, AliExpress later) is normalized into these types
 * exactly once, at the adapter boundary. All downstream Inkora logic — the
 * future Product Matcher, Opportunity Engine, persistence — operates on these
 * types and never on a raw provider payload.
 *
 * This module is pure type declarations on purpose: it carries no runtime
 * imports (in particular no `server-only` side effects) so the same normalized
 * shapes can be shared by server code and by the browser UI.
 */

import type { Provenance } from "@/lib/marketplace/types";

/**
 * Suppliers with a concrete adapter implementation. Extended only when a new
 * supplier adapter is actually built (see docs/ARCHITECTURE.md §4/§4.2).
 */
export type SupplierId = "cj";

/**
 * A normalized supplier product.
 *
 * Money is kept as a decimal `string` (as money should be represented) rather
 * than a float, to avoid binary rounding of prices. Every field the provider
 * does not actually return is `null` — never guessed, never defaulted, and
 * never converted into a fake estimate. In particular, an *available* product
 * is NOT evidence of US inventory: `availableInventory` and `warehouseCountry`
 * stay `null` until a real inventory call confirms them.
 */
export interface SupplierProduct {
  /** Supplier this product was acquired from. */
  supplier: SupplierId;
  /** The provider's own immutable identifier for this product. */
  externalId: string;
  /**
   * The provider's stock-keeping unit. Distinct from `externalId`: CJ keys its
   * inventory endpoints on SKU, so this is the handle later inventory and
   * matching work use.
   */
  sku: string | null;
  title: string;
  /** Best available primary image URL. Preserved verbatim for later matcher work. */
  imageUrl: string | null;
  /** Canonical browser URL of the product on the supplier platform, if known. */
  productUrl: string | null;
  /** Supplier-side category label, when the endpoint returns one. */
  category: string | null;
  /** Supplier (cost) price, as a decimal string (e.g. "24.11"). */
  supplierPrice: string | null;
  /** ISO 4217 currency code for `supplierPrice`. */
  currency: string | null;
  /** Units available across known warehouses, or null when unconfirmed. */
  availableInventory: number | null;
  /** ISO 3166-1 alpha-2 country code of the stocking warehouse, if confirmed. */
  warehouseCountry: string | null;
  /** Human-readable shipping origin, when the endpoint provides one. */
  shippingOrigin: string | null;
  /** Variants, when the endpoint exposes them; empty when it does not. */
  variants: SupplierVariant[];
  /** Provenance of the values above. OFFICIAL for the CJ search slice. */
  provenance: Provenance;
  /** Freshness timestamp (ISO 8601 UTC) — when Inkora acquired this record. */
  fetchedAt: string;
}

export interface SupplierVariant {
  /** The provider's variant identifier (e.g. CJ `vid`). */
  externalId: string | null;
  /** Variant SKU, when the endpoint returns one. */
  sku: string | null;
  title: string | null;
  /** Variant price, as a decimal string. */
  price: string | null;
  /** Units available for this variant, or null when unconfirmed. */
  availableInventory: number | null;
}

/**
 * One warehouse's stock figure for a single supplier product / SKU.
 *
 * Every quantity is carried verbatim from the official inventory endpoint, so
 * the whole record is provenance `OFFICIAL`. A null quantity means the
 * endpoint returned a warehouse row without a usable quantity.
 */
export interface SupplierWarehouseInventory {
  countryCode: string | null;
  countryName: string | null;
  warehouseName: string | null;
  /** Total units across that warehouse's stock dimensions. */
  totalQuantity: number | null;
  /** Units physically held in the supplier's own warehouse. */
  cjWarehouseQuantity: number | null;
  /** Units held by the partner factory rather than the supplier. */
  factoryWarehouseQuantity: number | null;
  provenance: Provenance;
}

/**
 * Coarse, honest verdict on US-warehouse availability for one product.
 *
 * - CONFIRMED_AVAILABLE — the inventory endpoint returned a US warehouse row
 *   with a positive quantity.
 * - CONFIRMED_NONE — the endpoint returned usable warehouse rows, and none of
 *   them is a US warehouse with stock.
 * - UNKNOWN — no usable warehouse rows were returned (or the response could
 *   not be interpreted). Never an estimate.
 */
export type UsWarehouseInventoryStatus =
  | "CONFIRMED_AVAILABLE"
  | "CONFIRMED_NONE"
  | "UNKNOWN";

export interface SupplierSearchRequest {
  query: string;
  limit: number;
  /** Offset-based pagination cursor (architecture-aware; not a full pager). */
  offset?: number;
}

export interface SupplierSearchResult {
  query: string;
  limit: number;
  offset: number;
  /** Total result-set size when the provider reports one, otherwise null. */
  total: number | null;
  /** Number of normalized products actually returned. */
  count: number;
  products: SupplierProduct[];
}

/**
 * A supplier adapter isolates one provider's API, authentication and response
 * shape from the rest of Inkora. It speaks only the normalized model above.
 *
 * Supplier-specific logic must never leak into core domain services, and this
 * interface must never embed provider-specific concepts (no CJ `vid`, no
 * warehouse ids) — those stay inside the provider module.
 */
export interface SupplierAdapter {
  readonly supplier: SupplierId;
  search(request: SupplierSearchRequest): Promise<SupplierSearchResult>;
}
