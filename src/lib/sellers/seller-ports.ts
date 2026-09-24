/**
 * Ports, not adapters (docs/ARCHITECTURE.md §15.2), for the Seller Scanner.
 *
 * The orchestration layer speaks only to these interfaces. The one concrete
 * marketplace adapter (`EbayAdapter`) implements them, and the deterministic
 * unit tests supply fakes — so the scanner's logic is provable with no network,
 * no credentials and no provider coupling.
 *
 * This module is pure type declarations on purpose: it carries no runtime
 * imports (in particular no `server-only` side effects), so it is safe for the
 * marketplace adapter to implement these shapes without dragging adapter
 * concerns into the seller layer or vice versa.
 */

import type { MarketplaceSearchRequest, MarketplaceSearchResult } from "@/lib/marketplace/types";
import type { SellerListing } from "./types";

/**
 * One page of a seller's listings, scoped to a search context.
 *
 * The context requirement is part of the contract, not an implementation
 * detail: the marketplace only enumerates a seller's items *within* a keyword,
 * category, gtin or epid context, so a caller that wants "the seller's
 * inventory" is asking for something the API cannot give — and the result says
 * so through `total` and the scan's limitations.
 */
export interface SellerListingsRequest {
  /** The search context scoping the enumeration. */
  query: string;
  /** The normalized seller handle the `sellers` filter is scoped to. */
  sellerHandle: string;
  limit: number;
  /** Must be a multiple of `limit` for the marketplaces that demand it. */
  offset: number;
  /** The marketplace's own ordering when a newest-first view is requested. */
  sort?: "newlyListed";
}

export interface SellerListingsResult {
  query: string;
  limit: number;
  offset: number;
  /** Total matching the context, when the marketplace reports one. */
  total: number | null;
  count: number;
  listings: SellerListing[];
  /**
   * True when the marketplace rejected the seller scoping but still answered —
   * in which case `listings` is NOT the requested seller's and must be discarded
   * rather than displayed.
   */
  sellerFilterRejected: boolean;
}

/**
 * The seller-scoped listing lookup the scanner orchestrates.
 */
export interface SellerListingsPort {
  searchSellerListings(request: SellerListingsRequest): Promise<SellerListingsResult>;
}

/**
 * The bounded marketplace product search used for cross-seller discovery. This
 * is the marketplace adapter's existing search contract, reused verbatim so the
 * discovery window and the Product Scanner see the same result shape.
 */
export interface MarketplaceDiscoveryPort {
  search(request: MarketplaceSearchRequest): Promise<MarketplaceSearchResult>;
}
