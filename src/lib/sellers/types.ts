/**
 * Provider-independent seller intelligence model.
 *
 * Everything the Seller Scanner produces is expressed here, never in eBay
 * shapes. External seller data is normalized into these types exactly once, at
 * the marketplace-adapter boundary (docs/ARCHITECTURE.md §3, §4), and every
 * downstream analysis module operates on these types only.
 *
 * This module is pure type declarations on purpose: it carries no runtime
 * imports (in particular no `server-only` side effects) so the same shapes are
 * shared by server code, the deterministic analysis unit tests, and the
 * browser UI.
 */

import type { MarketplaceId, Provenance } from "@/lib/marketplace/types";

/** Price distribution over a bounded seller sample (deterministic). */
export interface PriceDistribution {
  /** Currency the statistics are expressed in, or null when nothing is priced. */
  currency: string | null;
  /** Listings that carried a price and were therefore included. */
  pricedCount: number;
  /** Listings with no interpretable price, excluded from every statistic. */
  unpricedCount: number;
  min: string | null;
  max: string | null;
  median: string | null;
  mean: string | null;
  quartiles: { q1: string | null; q3: string | null };
  /** Every currency the sample actually contained. */
  currencies: string[];
  /** True when the sample mixed currencies and statistics were therefore refused. */
  mixedCurrencies: boolean;
  limitation: string | null;
}

/** One category's share of an observed seller sample. */
export interface CategoryBreakdown {
  categoryId: string;
  categoryName: string;
  listingCount: number;
  /** Share of the sampled listings, in percent (0–100). */
  sharePercent: number;
}

/** Category intelligence over an observed seller sample. */
export interface CategoryIntelligence {
  categories: CategoryBreakdown[];
  dominantCategory: CategoryBreakdown | null;
  distinctCategoryCount: number;
  sampledListingCount: number;
  /** Always present: this is a sample, never a complete inventory read. */
  limitation: string;
}

/**
 * A family of listings that normalize to the same product title signature.
 * Evidence of catalog repetition, never evidence of sales.
 */
export interface TitleFamily {
  key: string;
  sampleTitle: string;
  listingCount: number;
}

/** Product concentration over an observed seller sample (deterministic). */
export interface ProductConcentration {
  distinctTitleFamilies: number;
  /** Families appearing more than once, most repeated first. */
  repeatedFamilies: TitleFamily[];
  maxFamilyCount: number;
  topFamilySharePercent: number;
  /**
   * Deterministic classification of catalog breadth over the observed sample,
   * from the count of distinct title families only. It describes the sample's
   * shape, never seller performance.
   */
  catalogBreadth: "narrow" | "mixed" | "broad";
  sampledListingCount: number;
  limitation: string;
}

/** Confidence band for cross-seller overlap evidence. */
export type OverlapConfidenceBand = "LOW" | "MEDIUM" | "HIGH";

/** One deterministic signal supporting (or arguing against) a product overlap. */
export interface OverlapSignal {
  name: string;
  detail: string;
  /** Signed contribution to the overlap confidence score. */
  contribution: number;
}

/**
 * Evidence that the same product family is listed by several independent
 * sellers — marketplace evidence, never units sold.
 *
 * Confidence is a separate verdict describing the *matching*, not the product's
 * popularity: a HIGH band means the listings plausibly describe one product
 * family, nothing more.
 */
export interface CrossSellerEvidence {
  productFamilyKey: string;
  seed: { externalId: string; title: string };
  /** The bounded marketplace query this evidence was derived from. */
  discoveryQuery: string;
  /** Listings in the bounded overlap window that match the family fingerprint. */
  observedListings: number;
  /** Distinct seller identities among those listings. */
  independentSellers: number;
  sellerNames: string[];
  /** Whether the scanned seller's own listings appear in the overlap window. */
  seedSellerPresent: boolean;
  confidenceBand: OverlapConfidenceBand;
  /** 0–100, deterministic, fully explained by `signals` and `contradictions`. */
  confidence: number;
  signals: OverlapSignal[];
  contradictions: string[];
  limitations: string[];
  observedAt: string;
}

/**
 * A seller's stable identity, normalized once at the boundary.
 *
 * The anchor for all seller persistence and history. `externalSellerId` is the
 * normalized provider identifier; it never changes while the seller's listings,
 * feedback or prices do (docs/DATABASE.md §6 — identity is separate from
 * observation).
 */
export interface SellerIdentity {
  marketplace: MarketplaceId;
  /**
   * Normalized provider seller identifier (trimmed, single-spaced, lowercased).
   * This is the key history is anchored to.
   */
  externalSellerId: string;
  /** Display spelling as returned by the provider, when the provider emits one. */
  username: string | null;
}

/**
 * A category as the marketplace reports it on a listing.
 *
 * eBay returns a small path of categories per item summary (leaf first); the
 * primary one is the leaf, which is what category intelligence aggregates over.
 */
export interface SellerListingCategory {
  categoryId: string;
  categoryName: string;
}

/**
 * A listing observed in a bounded seller sample.
 *
 * Reuses the marketplace product concepts (money as decimal strings, provenance,
 * `fetchedAt`) rather than a parallel eBay product model, and adds the
 * seller-scoped fields the Browse API exposes on an item summary: the category
 * path, buying options, and — importantly — the listing creation timestamp.
 *
 * Every field the provider does not return is `null`, never guessed.
 */
export interface SellerListing {
  marketplace: MarketplaceId;
  externalId: string;
  title: string;
  imageUrl: string | null;
  listingUrl: string | null;
  price: string | null;
  currency: string | null;
  condition: string | null;
  conditionId: string | null;
  sellerName: string | null;
  sellerFeedbackPercentage: number | null;
  sellerFeedbackScore: number | null;
  shippingCost: string | null;
  shippingCurrency: string | null;
  location: string | null;
  primaryCategoryId: string | null;
  primaryCategoryName: string | null;
  categories: SellerListingCategory[];
  buyingOptions: string[];
  /**
   * The marketplace's own listing creation/start timestamp, when it actually
   * returns one (eBay: `itemCreationDate`). This is a genuine publication date,
   * distinct from Inkora's first-observation time.
   */
  itemCreationDate: string | null;
  /** Listing end timestamp, when the marketplace emits one (eBay auctions). */
  itemEndDate: string | null;
  epid: string | null;
  provenance: Provenance;
  fetchedAt: string;
}

/**
 * Provider-independent seller profile.
 *
 * Provenance is stated per group of fields because they genuinely differ:
 *
 * - feedback fields are **OFFICIAL** — eBay returns them verbatim on every item
 *   summary of the seller-scoped search;
 * - the listing counts are **OBSERVED** and deliberately context-bounded: the
 *   Browse API can only enumerate a seller's items *within a search context*
 *   (a keyword, category, gtin or epid), so `observedListingCount` is "how many
 *   of this seller's listings match this context", never the seller's whole
 *   inventory, and `sampledListingCount` is how many were actually returned in
 *   this bounded page.
 */
export interface SellerProfile {
  marketplace: MarketplaceId;
  externalSellerId: string;
  username: string | null;
  feedbackScore: number | null;
  feedbackPercentage: number | null;
  observedListingCount: number | null;
  sampledListingCount: number;
  provenance: {
    feedback: Provenance;
    counts: Provenance;
  };
  observedAt: string;
}

/**
 * Which field of a listing changed between two Inkora observations.
 *
 * `category` is intentionally absent in V1: category is not part of the
 * persisted marketplace snapshot, so a category change cannot be compared
 * against stored history without widening that shared, already-validated write
 * path. The limitation is documented rather than papered over with a comparison
 * against a value that was never stored.
 */
export type ListingChangeKind =
  | "price"
  | "title"
  | "condition"
  | "shipping"
  | "seller";

/** One deterministic change between two observations of the same listing. */
export interface ListingChange {
  externalId: string;
  kind: ListingChangeKind;
  from: string | null;
  to: string | null;
  previousObservedAt: string;
  observedAt: string;
}

/**
 * The comparison state of one listing against its own stored history.
 *
 * `not-in-current-sample` is deliberately *not* a delisting verdict: a bounded,
 * context-scoped sample cannot prove a listing disappeared, only that it was
 * absent from this window.
 */
export type ListingHistoryStatus =
  | "first-observed"
  | "unchanged"
  | "changed"
  | "not-in-current-sample";

export interface ListingHistory {
  externalId: string;
  title: string;
  status: ListingHistoryStatus;
  changes: ListingChange[];
  /**
   * Inkora's own first-seen time from the identity table. A *different* concept
   * from the marketplace's listing creation date, and labeled as such.
   */
  firstObservedByInkoraAt: string | null;
  previousObservedAt: string | null;
  currentObservedAt: string;
  limitation: string | null;
}

export interface ListingChangeReport {
  histories: ListingHistory[];
  /** Whether stored history existed to compare against. */
  availability: "history" | "no-history" | "disabled";
  note: string;
}

/** A named component of a scan, and whether it produced usable evidence. */
export interface ComponentStatus {
  component: ComponentName;
  status: "ok" | "unavailable" | "skipped";
  message?: string;
}

export type ComponentName =
  | "seller-listings"
  | "recent-listings"
  | "listing-changes"
  | "cross-seller-overlap";

/** The bounded sample description every analysis section is relative to. */
export interface SellerSampleSummary {
  sampledCount: number;
  observedTotal: number | null;
  limit: number;
  offset: number;
  contextQuery: string;
}

/** Server-enforced bounds actually applied, echoed so the UI can render them. */
export interface SellerScanLimits {
  sampleLimit: number;
  recentLimit: number;
  overlapWindow: number;
  overlapAnalyses: number;
}

export interface SellerScanMeta {
  version: string;
  environment: string;
  limits: SellerScanLimits;
  /** Upstream calls actually issued, so cost is observable per scan. */
  upstreamCalls: { ebaySearch: number; supabaseWrites: number };
  elapsedMs: number;
}

/**
 * The complete, provider-independent Seller Scanner result.
 *
 * Only implemented, legitimate fields appear. Anything the marketplace cannot
 * supply is absent from this model rather than present as a fabricated number,
 * and `limitations` says so in prose.
 */
export interface SellerScan {
  seller: SellerProfile;
  observedAt: string;
  listings: SellerListing[];
  listingSample: SellerSampleSummary;
  categories: CategoryIntelligence;
  pricing: PriceDistribution;
  concentration: ProductConcentration;
  /** null when the marketplace exposes no trustworthy listing creation date. */
  recentListings: SellerListing[] | null;
  listingChanges: ListingChangeReport;
  crossSellerEvidence: CrossSellerEvidence[];
  components: ComponentStatus[];
  limitations: string[];
  meta: SellerScanMeta;
}

