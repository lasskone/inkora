/**
 * Product Detail V1 — the read model (docs/MVP_SPEC.md §4.4,
 * docs/ARCHITECTURE.md §18).
 *
 * Product Detail is **not** an intelligence engine. It is a read model and a
 * presentation boundary over intelligence INKORA has already computed and
 * persisted (docs/ARCHITECTURE.md §13): marketplace and supplier snapshots,
 * match observations, economics observations, and the Opportunity Engine's own
 * assessments. Nothing here re-scores, re-matches, re-prices or re-invents a
 * figure — every number is a stored observation with its own timestamp, or a
 * value derived deterministically from stored observations.
 *
 * This module is pure type declarations on purpose (no `server-only`, no I/O)
 * so the read model is unit-testable with fixtures and the same shapes serve
 * the browser UI.
 */

import type { MarketplaceId, Provenance } from "@/lib/marketplace/types";
import type { SupplierId } from "@/lib/supplier/types";
import type {
  ConfidenceBand,
  MatchContradiction,
  MatchSignal,
} from "@/lib/matcher/types";
import type {
  AppliedCap,
  CompetitionAssessment,
  CompetitionVerdict,
  DemandAssessment,
  EconomicsCompleteness,
  OpportunityBand,
  OpportunityFactor,
  SupplierCostBasis,
} from "@/lib/opportunity/types";
import type { ConfidenceLevel } from "@/lib/opportunity/types";
import type {
  EconomicsObservationHistoryEntry,
  MarketplaceSnapshotHistoryEntry,
  MatchObservationHistoryEntry,
} from "@/types/product-history";

/**
 * The standing of one Product Detail section.
 *
 * - `available`   — the section's evidence exists and is complete enough to
 *                   state.
 * - `partial`     — evidence exists but a documented part of it is missing or
 *                   non-definitive (for example a reference rather than a
 *                   variant cost, or a match verdict with no signals stored).
 * - `unavailable` — no evidence exists for this section. Reported honestly,
 *                   never as zero or as a fabricated value.
 * - `stale`       — evidence exists but is older than the project's existing
 *                   freshness threshold (`STALE_OBSERVATION_HOURS`), so it
 *                   describes the past rather than the present.
 *
 * `stale` is only ever derived from a threshold that already exists in the
 * codebase; Product Detail invents no freshness window of its own
 * (docs/ARCHITECTURE.md §9.3, §18.6).
 */
export type SectionStatus = "available" | "partial" | "unavailable" | "stale";

/** One supplier-side shipping quote, kept for transparency. */
export interface ShippingQuoteSummary {
  method: string;
  /** Decimal-string cost, or `null` when the provider gave none. */
  cost: string | null;
  currency: string | null;
  transitTime: string | null;
  originCountry: string | null;
  provenance: Provenance;
}


// ---------------------------------------------------------------------------
// Market — what the marketplace showed
// ---------------------------------------------------------------------------

export interface MarketSection {
  status: SectionStatus;
  /** The latest persisted marketplace observation, or `null` when none exists. */
  snapshot: MarketplaceSnapshotHistoryEntry | null;
  /**
   * Fields the persisted observation does not carry (buying options, category,
   * listing creation date) are reported as unsupported rather than invented.
   */
  unsupported: string[];
}

// ---------------------------------------------------------------------------
// Competition — observed marketplace competition evidence
// ---------------------------------------------------------------------------

export interface CompetitionSection {
  status: SectionStatus;
  /** The competition evidence the Opportunity Engine replayed, or `null`. */
  evidence: CompetitionAssessment | null;
  /** The query the figures are relative to — without it they are meaningless. */
  query: string | null;
  /** Fields that would be needed for a fuller picture and are not available. */
  limitations: string[];
}

// ---------------------------------------------------------------------------
// Supplier — the CJ sourcing evidence
// ---------------------------------------------------------------------------

export interface SupplierSection {
  status: SectionStatus;
  supplier: SupplierId;
  externalId: string | null;
  title: string | null;
  imageUrl: string | null;
  productUrl: string | null;
  category: string | null;
  /** Catalogue-level reference cost as observed then, or `null`. */
  referenceCost: string | null;
  currency: string | null;
  /** Units available across known warehouses, or `null` when unconfirmed. */
  availableInventory: number | null;
  warehouseCountry: string | null;
  shippingOrigin: string | null;
  observedAt: string | null;
  provenance: Provenance | null;
  /** What the persisted cost actually represents — definitive or reference. */
  costBasis: SupplierCostBasis | null;
  /** Persisted supplier product cost for this opportunity. */
  productCost: string | null;
  shippingMethod: string | null;
  shippingCost: string | null;
  transitTime: string | null;
  /** Every quote the supplier returned, not just the selected one. */
  shippingQuotes: ShippingQuoteSummary[];
  /** `null` means US inventory was never confirmed, not "no stock". */
  usWarehouseInventory: "CONFIRMED_AVAILABLE" | "CONFIRMED_NONE" | "UNKNOWN" | null;
}

// ---------------------------------------------------------------------------
// Match — how confident INKORA is these are the same product
// ---------------------------------------------------------------------------

export interface MatchSection {
  status: SectionStatus;
  /** The matcher's deterministic confidence (0–100). */
  confidence: number | null;
  confidenceBand: ConfidenceBand | null;
  /** The matcher's own human-readable verdict. */
  explanation: string | null;
  /** Stable supplier identity the match was made against. */
  supplierExternalId: string | null;
  signals: MatchSignal[];
  contradictions: MatchContradiction[];
  /** Whether a hard contradiction capped the confidence. */
  cappedByHardContradiction: boolean;
  /** Matcher logic version that produced the stored verdict. */
  matcherVersion: string | null;
  /**
   * `true` when economics exist despite a LOW-confidence match — the page must
   * say plainly that the money may describe a *different physical product*.
   */
  economicsReferToPossibleDifferentProduct: boolean;
  caveats: string[];
}

/** One component of the marketplace fee breakdown. */
export interface FeeComponentSummary {
  name: string;
  label: string;
  /** Decimal-string amount, or `null` when the rule could not be applied. */
  amount: string | null;
  rate: string | null;
  status: string;
  note: string | null;
}


// ---------------------------------------------------------------------------
// Economics — deterministic cost breakdown
// ---------------------------------------------------------------------------

export interface EconomicsSection {
  status: SectionStatus;
  completeness: EconomicsCompleteness | null;
  sellingPrice: string | null;
  buyerShipping: string | null;
  grossRevenue: string | null;
  supplierProductCost: string | null;
  supplierShippingCost: string | null;
  /** Supplier cost + supplier shipping. */
  landedCost: string | null;
  marketplaceFee: string | null;
  feeComponents: FeeComponentSummary[];
  feeEngineVersion: string | null;
  feeRuleSource: string | null;
  economicsEngineVersion: string | null;
  /** Estimated profit — may be negative; a stored loss is shown as a loss. */
  estimatedProfit: string | null;
  marginPercent: string | null;
  currency: string | null;
  assumptions: string[];
  warnings: string[];
  provenance: {
    itemPrice: Provenance;
    buyerShipping: Provenance | null;
    supplierProductCost: Provenance | null;
    supplierShippingCost: Provenance | null;
    marketplaceFee: Provenance;
    estimatedProfit: Provenance;
    marginPercent: Provenance;
  } | null;
  calculatedAt: string | null;
}

// ---------------------------------------------------------------------------
// Opportunity — the score, the evidence confidence, and the why
// ---------------------------------------------------------------------------

export interface OpportunitySection {
  status: SectionStatus;
  score: number | null;
  band: OpportunityBand | null;
  /** Evidence confidence — computed independently from the score. */
  confidence: number | null;
  confidenceLevel: ConfidenceLevel | null;
  engineVersion: string | null;
  calculatedAt: string | null;
  /** Every deterministic reason the score moved, in order. */
  factors: OpportunityFactor[];
  /** Every hard cap applied. Empty when none applied. */
  caps: AppliedCap[];
  /** The engine's own ordered explanation. */
  explanation: string[];
  /** What the assessment does NOT mean. Always shown beside the score. */
  caveats: string[];
  /** Component contributions, so the five dimensions are inspectable. */
  components: {
    economics: { score: number; completeness: EconomicsCompleteness } | null;
    match: { score: number; confidence: number } | null;
    competition: { score: number; intensity: number; verdict: CompetitionVerdict } | null;
    demand: { score: number; verdict: DemandAssessment["verdict"] } | null;
    dataQuality: { score: number } | null;
  };
  /** Published component weights, so the blend is not a secret. */
  componentWeights: Record<string, number> | null;
  inputs: {
    marketplaceSnapshotObservedAt: string | null;
    supplierSnapshotObservedAt: string | null;
    economicsCalculatedAt: string | null;
    competitionQuery: string | null;
    historyAvailable: boolean;
  } | null;
  /**
   * The honest demand verdict. V1 has no legitimate units-sold signal, so the
   * page states the absence of direct sales evidence rather than a number.
   */
  demand: DemandAssessment | null;
}


// ---------------------------------------------------------------------------
// History — persisted observations and deterministic change
// ---------------------------------------------------------------------------

export interface HistorySeries {
  status: SectionStatus;
  marketplaceSnapshots: MarketplaceSnapshotHistoryEntry[];
  matchObservations: MatchObservationHistoryEntry[];
  economicsObservations: EconomicsObservationHistoryEntry[];
  /** Prior assessments for this scope, most recent first. */
  assessments: AssessmentHistoryEntry[];
  /** First/last time INKORA observed this listing. */
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  /** Bounded count actually read, so the page states the real limit. */
  limit: number;
  note: string;
}

/** One persisted assessment, summarized for the timeline. */
export interface AssessmentHistoryEntry {
  calculatedAt: string;
  score: number;
  band: OpportunityBand;
  confidence: number;
  confidenceLevel: ConfidenceLevel;
  economicsCompleteness: EconomicsCompleteness;
  /** Decimal-string profit, or `null`; may be negative. */
  profit: string | null;
  marginPercent: string | null;
  matchConfidence: number;
  engineVersion: string;
  caveats: string[];
}

/** One deterministic `previous → current` comparison row. */
export interface ChangeRow {
  field: string;
  label: string;
  /** Decimal-string / categorical previous value, or `null` when not stored. */
  previous: string | null;
  current: string | null;
  /** Decimal-string delta where the field is numeric, or `null`. */
  delta: string | null;
  direction: "up" | "down" | "unchanged" | "unknown";
}

export interface ChangeSummary {
  status: SectionStatus;
  rows: ChangeRow[];
  /**
   * `true` when there was no previous observation to compare against, so the
   * figures are labelled "first observation" rather than "no change".
   */
  noPrevious: boolean;
  note: string;
}

export interface HistorySection {
  status: SectionStatus;
  series: HistorySeries;
  changes: ChangeSummary;
}

// ---------------------------------------------------------------------------
// Watchlist — monitoring state
// ---------------------------------------------------------------------------

export interface WatchlistSection {
  status: SectionStatus;
  /** Active entry id for this exact scope, or `null` when not watched. */
  entryId: string | null;
  /** `true` only for a pair scope; a NULL supplier is a scope, not a wildcard. */
  isPair: boolean;
  /** An archived entry keeps its history but is not monitored. */
  archived: boolean;
  note: string;
}

// ---------------------------------------------------------------------------
// Freshness — when each fact was observed
// ---------------------------------------------------------------------------

export interface FreshnessEntry {
  label: string;
  /** ISO 8601 UTC of the observation, or `null` when never observed. */
  observedAt: string | null;
  /** Age in hours, or `null` when unknown. */
  ageHours: number | null;
  /** `true` only when the project's existing staleness threshold applies. */
  stale: boolean;
}

export interface FreshnessSection {
  status: SectionStatus;
  entries: FreshnessEntry[];
  /** The existing threshold reused, in hours (never a Product Detail invention). */
  staleThresholdHours: number;
  note: string;
}

// ---------------------------------------------------------------------------
// The read model
// ---------------------------------------------------------------------------

/**
 * Everything one Product Detail page renders.
 *
 * Every section carries its own status, so a page whose supplier evidence is
 * absent still renders the market, match and opportunity sections beside an
 * honest "no supplier candidate" — partial failure degrades a section, never
 * the page (docs/ARCHITECTURE.md §18.5).
 */
export interface ProductDetail {
  marketplace: MarketplaceId;
  marketplaceExternalId: string;
  /** The query whose replayed window re-resolves this listing, when known. */
  replayQuery: string | null;
  /** Supplier in scope, or `null` for a marketplace-only view. */
  supplierExternalId: string | null;
  /** Whether INKORA has any persisted observation for this listing at all. */
  observed: boolean;
  market: MarketSection;
  competition: CompetitionSection;
  supplier: SupplierSection;
  match: MatchSection;
  economics: EconomicsSection;
  opportunity: OpportunitySection;
  history: HistorySection;
  watchlist: WatchlistSection;
  freshness: FreshnessSection;
  /** Cross-cutting warnings that degrade more than one section. */
  warnings: string[];
}

/**
 * Outcome of reading the persisted intelligence for one product.
 *
 *   ok        — a read model was assembled (some sections may be unavailable).
 *   disabled  — persistence is not configured, so nothing was read.
 *   not-found — no persisted observation exists for this listing yet. The page
 *               still renders, offering a deliberate live evaluation.
 */
export type ProductDetailReadResult =
  | { status: "ok"; detail: ProductDetail }
  | { status: "disabled" }
  | { status: "not-found" };
