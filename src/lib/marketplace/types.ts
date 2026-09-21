/**
 * Provider-independent marketplace model.
 *
 * External marketplace data is normalized into these types exactly once, at the
 * adapter boundary. All downstream Inkora logic operates on these types and
 * never on a raw provider payload.
 *
 * This module is pure type declarations on purpose: it carries no runtime
 * imports (in particular no `server-only` side effects) so the same normalized
 * shapes can be shared by server code and by the browser UI.
 */

/**
 * Provenance classification for any quantitative value Inkora surfaces.
 *
 * See docs/ARCHITECTURE.md §7 — these categories are non-negotiable:
 *
 * - OFFICIAL  — returned directly by an official, authenticated first-party API.
 * - OBSERVED  — legitimately observable marketplace data, not necessarily
 *               returned by the primary official API.
 * - ESTIMATED — calculated or modeled by Inkora.
 *
 * Never fabricate precision. Never present an estimated value as official.
 */
export type Provenance = "OFFICIAL" | "OBSERVED" | "ESTIMATED";

/**
 * Marketplaces with a concrete adapter implementation. Extended only when a new
 * adapter is actually built (see docs/ARCHITECTURE.md §4).
 */
export type MarketplaceId = "ebay";

/**
 * A normalized marketplace listing/product.
 *
 * Money is kept as a decimal `string` (as money should be represented) rather
 * than a float, to avoid binary rounding of prices. Every field the provider
 * does not actually return is `null` — never guessed, never defaulted, and never
 * converted into a fake estimate.
 */
export interface MarketplaceProduct {
  /** Marketplace this product was acquired from. */
  marketplace: MarketplaceId;
  /** The provider's own immutable identifier for this listing. */
  externalId: string;
  title: string;
  /** Best available primary image URL. */
  imageUrl: string | null;
  /** Canonical browser URL of the original listing on the marketplace. */
  listingUrl: string | null;
  /** Listing price, as a decimal string (e.g. "29.99"). */
  price: string | null;
  /** ISO 4217 currency code for `price`. */
  currency: string | null;
  /** Marketplace-supplied condition vocabulary (e.g. "NEW", "USED"). */
  condition: string | null;
  /**
   * Seller display name, or — where the marketplace only returns one — an
   * immutable seller identifier (eBay is doing exactly this for US listings).
   */
  sellerName: string | null;
  /** Seller positive-feedback percentage (0–100) as returned by the provider. */
  sellerFeedbackPercentage: number | null;
  /** Cheapest available shipping cost, as a decimal string. */
  shippingCost: string | null;
  /** ISO 4217 currency code for `shippingCost`. */
  shippingCurrency: string | null;
  /** Human-readable item location (city and/or country). */
  location: string | null;
  /** Provenance of the values above. OFFICIAL for the eBay search slice. */
  provenance: Provenance;
  /** Freshness timestamp (ISO 8601 UTC) — when Inkora acquired this record. */
  fetchedAt: string;
}

export interface MarketplaceSearchRequest {
  query: string;
  limit: number;
  /** Offset-based pagination cursor (architecture-aware; not a full pager). */
  offset?: number;
}

export interface MarketplaceSearchResult {
  query: string;
  limit: number;
  offset: number;
  /** Total result-set size when the provider reports one, otherwise null. */
  total: number | null;
  /** Number of normalized products actually returned. */
  count: number;
  products: MarketplaceProduct[];
}

/**
 * A marketplace adapter isolates one provider's API, authentication and response
 * shape from the rest of Inkora. It speaks only the normalized model above.
 *
 * Marketplace-specific logic must never leak into core domain services.
 */
export interface MarketplaceAdapter {
  readonly marketplace: MarketplaceId;
  search(request: MarketplaceSearchRequest): Promise<MarketplaceSearchResult>;
}
