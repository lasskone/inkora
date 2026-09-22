import type { EconomicsCompleteness, SupplierCostBasis } from "@/lib/economics/types";
import type { ConfidenceBand } from "@/lib/matcher/types";
import type { Provenance } from "@/lib/marketplace/types";

/**
 * Response shapes of the historical read API boundary.
 *
 *   GET /api/products/history?itemId=<ebayItemId>&limit=<1..50>
 *
 * Like the marketplace, supplier, match and economics boundaries, responses are
 * sanitized: they never carry upstream tokens, credentials, or raw provider
 * payloads. They are also explicitly *historical*: every figure is an
 * observation with its own timestamp, never a statement about the present
 * (docs/ARCHITECTURE.md §14, docs/DATABASE.md §8).
 */

export type ProductHistoryErrorCode =
  | "INVALID_ITEM_ID"
  | "INVALID_LIMIT"
  | "HISTORY_NOT_CONFIGURED"
  | "NO_OBSERVATIONS"
  | "HISTORY_UNAVAILABLE"
  | "INTERNAL_ERROR";

/** One persisted marketplace listing observation (price at a point in time). */
export interface MarketplaceSnapshotHistoryEntry {
  title: string;
  imageUrl: string | null;
  listingUrl: string | null;
  /** Decimal-string price as observed then, or `null` when the provider gave none. */
  price: string | null;
  currency: string | null;
  condition: string | null;
  sellerName: string | null;
  sellerFeedbackPercentage: number | null;
  shippingCost: string | null;
  shippingCurrency: string | null;
  location: string | null;
  provenance: Provenance;
  /** When Inkora observed this record — the point in time the figures belong to. */
  observedAt: string;
}

/** One persisted matcher verdict for the listing. */
export interface MatchObservationHistoryEntry {
  supplierProductId: string;
  supplierExternalId: string | null;
  matcherVersion: string;
  confidence: number;
  confidenceBand: ConfidenceBand;
  calculatedAt: string;
}

/** One persisted economics calculation for the listing. */
export interface EconomicsObservationHistoryEntry {
  supplierProductId: string;
  supplierExternalId: string | null;
  itemPrice: string | null;
  supplierProductCost: string | null;
  supplierCostBasis: SupplierCostBasis | null;
  landedCost: string | null;
  marketplaceFee: string | null;
  /** May be negative — a stored loss is shown as a loss, never clamped. */
  estimatedProfit: string | null;
  marginPercent: string | null;
  completeness: EconomicsCompleteness;
  feeEngineVersion: string;
  calculatedAt: string;
}

export interface ProductHistory {
  /** The stable provider identity the history is anchored to. */
  marketplaceProduct: {
    marketplace: string;
    externalId: string;
    firstSeenAt: string;
    lastSeenAt: string;
  };
  /** Bounded, most-recent-first observations. */
  marketplaceSnapshots: MarketplaceSnapshotHistoryEntry[];
  matchObservations: MatchObservationHistoryEntry[];
  economicsObservations: EconomicsObservationHistoryEntry[];
}

export interface ProductHistorySuccessResponse {
  status: "ok";
  history: ProductHistory;
  /** The bound actually applied, so the caller can confirm it was not unlimited. */
  limit: number;
  timestamp: string;
}

export interface ProductHistoryErrorResponse {
  status: "error";
  error: string;
  code: ProductHistoryErrorCode;
  timestamp: string;
}
