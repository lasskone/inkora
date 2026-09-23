/**
 * Watchlist & Opportunity Monitoring V1 — type declarations
 * (docs/ARCHITECTURE.md §16, docs/MVP_SPEC.md §4.5).
 *
 * The watchlist is the **manual monitoring** layer over the intelligence
 * pipeline. It owns no scoring, no matching, no economics and no scheduling —
 * it connects a user's *intent to monitor* to stable provider identities, and
 * hands re-evaluation back to the same trusted services the Opportunity Scanner
 * already uses:
 *
 * ```text
 *   save to watchlist
 *     → read last known assessment (historical observation)
 *     → manual re-evaluate: fresh eBay resolve → CJ re-proof → economics
 *         → Opportunity Engine → persist → compare with the previous observation
 * ```
 *
 * Everything here is deliberately user-triggered. There is no cron, no queue, no
 * background worker and no alerting in this layer.
 *
 * This module is pure type declarations plus named constants on purpose (no
 * `server-only`, no I/O) so the model is unit-testable with Node's built-in
 * runner and the same shapes serve the browser UI.
 */

import type {
  MarketplaceId,
  MarketplaceProduct,
  MarketplaceSearchRequest,
  MarketplaceSearchResult,
} from "@/lib/marketplace/types";
import type { SupplierId } from "@/lib/supplier/types";
import type {
  ConfidenceBand,
  MatchCandidate,
  MatchResult,
} from "@/lib/matcher/types";
import type { EconomicsResult } from "@/lib/economics/types";
import type {
  EconomicsCompleteness,
  HistoryEvidenceSummary,
  OpportunityAssessment,
  OpportunityBand,
  OpportunityLimits,
  ConfidenceLevel,
} from "@/lib/opportunity/types";
import type {
  EconomicsOutcome,
  ScanDestination,
} from "@/lib/scanner/types";
import type { PersistedRecords } from "@/lib/persistence/persistence-service";
import type { OpportunityPersistenceReport } from "@/types/opportunity";

/** Version of the watchlist orchestration, carried in results for traceability. */
export const WATCHLIST_VERSION = "watchlist-v1";


// ---------------------------------------------------------------------------
// The entry — monitoring intent, not data
// ---------------------------------------------------------------------------

/**
 * One watchlist entry as the API and the UI see it.
 *
 * It identifies the monitored opportunity by **stable provider identity** — the
 * marketplace's own external id and, when a candidate was selected, the
 * supplier's — never by a title or a price (docs/DATABASE.md §6.9). It holds no
 * economics and no score: those are read from the observation tables every time.
 */
export interface WatchlistEntry {
  id: string;
  marketplace: MarketplaceId;
  marketplaceExternalId: string;
  /** `null` marks a marketplace-only watch — a distinct scope, not a wildcard. */
  supplier: SupplierId | null;
  supplierExternalId: string | null;
  /** The query a re-evaluation replays to re-resolve the listing. */
  replayQuery: string;
  /** Optional free-text user note. */
  label: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The fields a save request carries. The browser never posts prices or scores. */
export interface WatchlistAddInput {
  marketplaceExternalId: string;
  /** Omit for a marketplace-only watch. */
  supplierExternalId?: string | null;
  replayQuery: string;
  label?: string | null;
}

// ---------------------------------------------------------------------------
// Last-known information (all of it historical, never a live claim)
// ---------------------------------------------------------------------------

/** Latest stored marketplace observation for the entry's listing. */
export interface WatchlistMarketplaceInfo {
  title: string | null;
  imageUrl: string | null;
  listingUrl: string | null;
  /** Decimal-string price as observed then, or `null`. */
  price: string | null;
  currency: string | null;
  observedAt: string | null;
}

/** Latest stored supplier observation, present only for a pair watch. */
export interface WatchlistSupplierInfo {
  title: string | null;
  imageUrl: string | null;
  /**
   * Catalogue-level reference cost as observed then, or `null`. A lower bound,
   * never the definitive variant cost (docs/DATABASE.md §6.3).
   */
  referenceCost: string | null;
  currency: string | null;
  observedAt: string | null;
}

/**
 * The most recent persisted Opportunity Assessment for this entry's scope.
 *
 * Every figure is an **observation from a point in time** (`calculatedAt`). It
 * is never a statement about the listing's present price, stock or
 * profitability, and the UI must label it as such (docs/ARCHITECTURE.md §14).
 */
export interface WatchlistAssessmentInfo {
  score: number;
  band: OpportunityBand;
  confidence: number;
  confidenceLevel: ConfidenceLevel;
  matchConfidence: number;
  matchConfidenceBand: ConfidenceBand;
  economicsCompleteness: EconomicsCompleteness;
  /** Decimal-string estimated profit, or `null` when economics are UNAVAILABLE. May be negative. */
  profit: string | null;
  /** Margin in percent, or `null` when not computable. May be negative. */
  marginPercent: number | null;
  calculatedAt: string;
  engineVersion: string;
}

/**
 * Everything one watchlist card displays: the entry, the last-known marketplace
 * and supplier observations, the last-known assessment, and how much history
 * exists behind it. Every nullable field is an honest "not observed yet".
 */
export interface WatchlistEntryDetail {
  entry: WatchlistEntry;
  marketplace: WatchlistMarketplaceInfo | null;
  supplier: WatchlistSupplierInfo | null;
  assessment: WatchlistAssessmentInfo | null;
  /** Persisted assessments for this entry's exact scope. Zero is a valid state. */
  assessmentCount: number;
}

/** A bounded timeline entry for the history view. */
export interface WatchlistHistoryEntry {
  calculatedAt: string;
  score: number;
  band: OpportunityBand;
  confidence: number;
  confidenceLevel: ConfidenceLevel;
  economicsCompleteness: EconomicsCompleteness;
  /** Decimal-string profit, or `null`; may be negative. */
  profit: string | null;
  marginPercent: number | null;
  matchConfidence: number;
  engineVersion: string;
  /** Caveats the assessment carried, kept verbatim so warnings reach the UI. */
  caveats: string[];
}


// ---------------------------------------------------------------------------
// Manual re-evaluation
// ---------------------------------------------------------------------------

/**
 * The outcome of re-evaluating one watched opportunity. Every non-`evaluated`
 * outcome is an explicit, honest state — the entry is **never** removed and the
 * last-known data stays on screen alongside the reason (docs/ARCHITECTURE.md
 * §16.4, §16.7).
 */
export type ReEvaluationOutcome =
  /**
   * A fresh assessment was produced through the trusted pipeline (any
   * economics completeness) and persisted as a new observation.
   */
  | "evaluated"
  /**
   * Marketplace-only scope: the matcher surfaced no candidate this time. Still
   * a full, explainable verdict — the engine hard-caps it at LOW — so this is a
   * result, not an error.
   */
  | "no-candidates"
  /** A candidate exists but no shipping quote could be obtained; the assessment carries an UNAVAILABLE economics component. */
  | "economics-unavailable"
  /** The listing scrolled out of the replayed search window. */
  | "listing-unavailable"
  /**
   * The saved supplier product is no longer a matcher candidate for this
   * listing. It is **never** silently substituted with another supplier and
   * passed off as the same opportunity (docs/ARCHITECTURE.md §16.4).
   */
  | "candidate-not-resolved"
  /** An eBay or CJ failure the re-evaluation could not recover from. */
  | "upstream-error"
  /** The batch's wall-clock budget elapsed before this entry finished. */
  | "timeout"
  /** No watchlist entry exists with this id. */
  | "entry-not-found"
  /** The entry exists but is archived; re-evaluation is refused, not implied. */
  | "archived"
  /** The server has no eBay or CJ configuration, so nothing can be re-evaluated. */
  | "not-configured";

/** The money fields compared between two assessments, in integer minor units. */
export interface ComparisonMoney {
  marketplacePriceCents: number | null;
  supplierCostCents: number | null;
  supplierShippingCents: number | null;
  landedCostCents: number | null;
  estimatedProfitCents: number | null;
  marginPercent: number | null;
}

/** One side of a previous-vs-current comparison, fully normalized. */
export interface ComparisonSide {
  score: number;
  band: OpportunityBand;
  confidence: number;
  confidenceLevel: ConfidenceLevel;
  matchConfidence: number;
  economicsCompleteness: EconomicsCompleteness;
  money: ComparisonMoney;
}

/** A numeric delta. `delta` is `null` when either side is missing. */
export interface NumericDelta {
  field: string;
  label: string;
  /** Decimal-string rendering of the previous value, or `null`. */
  previous: string | null;
  /** Decimal-string rendering of the current value, or `null`. */
  current: string | null;
  /** Decimal-string delta (`current - previous`), or `null` when not comparable. */
  delta: string | null;
  direction: "up" | "down" | "unchanged" | "unknown";
}

/** A categorical change, rendered as `previous → current`. */
export interface CategoricalChange {
  field: string;
  label: string;
  previous: string | null;
  current: string | null;
  changed: boolean;
}

/**
 * The previous-vs-current comparison of one re-evaluation.
 *
 * Terminology is deliberate: this is a **change since the previous evaluation**,
 * not a trend, not growth and not momentum — two observations cannot establish a
 * direction of travel (docs/ARCHITECTURE.md §16.8).
 */
export interface AssessmentComparison {
  previousCalculatedAt: string | null;
  currentCalculatedAt: string | null;
  numeric: NumericDelta[];
  categorical: CategoricalChange[];
  /** `true` only when no prior assessment existed at all. */
  noPrevious: boolean;
}

/** The result of re-evaluating one entry. */
export interface ReEvaluationResult {
  entryId: string;
  outcome: ReEvaluationOutcome;
  /** Present only for failure outcomes; safe to display. */
  failureCode?: string;
  failureMessage?: string;
  /** The fresh assessment, present only for verdict outcomes. */
  assessment: OpportunityAssessment | null;
  /** The comparison against the immediately previous observation. */
  comparison: AssessmentComparison | null;
  /** Outcome of persisting the new assessment; absent when nothing was persisted. */
  persistence?: OpportunityPersistenceReport;
  /** ISO 8601 UTC — when the attempt ran (present for every outcome). */
  evaluatedAt: string;
  durationMs: number;
}

/** The bounded batch result; every entry resolves to its own outcome. */
export interface ReEvaluationBatchResult {
  status: "ok" | "partial";
  results: ReEvaluationResult[];
  /** The bounds actually applied, so the UI shows real limits, not requested ones. */
  limits: {
    maxReEvaluations: number;
    concurrency: number;
    deadlineMs: number;
  };
  durationMs: number;
}


// ---------------------------------------------------------------------------
// Injected ports
// ---------------------------------------------------------------------------

/**
 * The entry as the re-evaluation orchestrator needs it: stable identity, the
 * query to replay, and the archive state. Everything else is re-derived.
 */
export interface WatchlistEntrySnapshot {
  id: string;
  marketplaceExternalId: string;
  /** `null` for a marketplace-only watch. */
  supplierExternalId: string | null;
  replayQuery: string;
  archivedAt: string | null;
}

/**
 * The immediately previous observation for an entry's scope — read **before**
 * the new assessment is persisted, so a fresh assessment never counts itself as
 * its own prior (the same ordering the opportunity route uses,
 * docs/ARCHITECTURE.md §9.8).
 */
export interface PreviousObservation {
  assessment: OpportunityAssessment;
  /** Money fields from the economics observation that assessment linked to, or nulls when it linked to none. */
  money: ComparisonMoney;
}

/**
 * Everything the manual re-evaluation touches, injected by the route.
 *
 * Constructing adapters and repositories inside the orchestrator would make it
 * untestable without a network and would hide how many upstream calls one
 * re-evaluation costs; injecting them makes both explicit — exactly the same
 * reasoning as `ScannerPorts` (docs/ARCHITECTURE.md §15.2).
 *
 * Upstream budget per re-evaluation, identical to the opportunity route's: one
 * eBay search (replayed to re-resolve the listing, then reused verbatim as
 * competition evidence) plus ≤ 6 CJ calls (matcher searches, one variant query,
 * one or two freight calculations) — docs/API_INTEGRATIONS.md §3, §4.
 */
export interface WatchlistPorts {
  /** Reads one entry by id, or `null` when it does not exist. */
  readEntry(id: string): Promise<WatchlistEntrySnapshot | null>;
  /** Reads the immediately previous observation for an entry's scope, or `null` when none exists yet. */
  readPreviousObservation(params: {
    marketplaceExternalId: string;
    supplierExternalId: string | null;
  }): Promise<PreviousObservation | null>;
  /** Replays the marketplace search that surfaced the listing. */
  searchMarketplace(request: MarketplaceSearchRequest): Promise<MarketplaceSearchResult>;
  /** Runs the bounded matcher against the re-resolved listing. */
  matchCandidates(product: MarketplaceProduct): Promise<MatchResult>;
  /** Computes economics for one matcher candidate. */
  computeEconomics(request: {
    candidate: MatchCandidate;
    destination: ScanDestination;
  }): Promise<EconomicsOutcome>;
  /** Reads the bounded history the engine is allowed to see. */
  readEvidence(params: {
    marketplace: MarketplaceProduct["marketplace"];
    marketplaceExternalId: string;
    supplierExternalId: string | null;
    limits: OpportunityLimits;
  }): Promise<HistoryEvidenceSummary | null>;
  /** Persists one economics evaluation, best-effort. */
  persistEvaluation(params: {
    marketplaceProduct: MarketplaceProduct;
    candidate: MatchCandidate;
    economics: EconomicsResult;
    selectedVariant: EconomicsOutcome["selectedVariant"];
  }): Promise<PersistedRecords | null>;
  /** Persists one assessment as a historical observation, best-effort. */
  persistAssessment(params: {
    assessment: OpportunityAssessment;
    marketplaceProduct: MarketplaceProduct;
    evaluation: PersistedRecords | null;
  }): Promise<OpportunityPersistenceReport | undefined>;
}
