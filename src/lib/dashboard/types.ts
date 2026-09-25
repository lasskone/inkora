/**
 * Dashboard V1 — the read model (docs/MVP_SPEC.md §4.1,
 * docs/ARCHITECTURE.md §19).
 *
 * The Dashboard is **not an intelligence engine**. It is a read and aggregation
 * surface over intelligence INKORA has already computed and persisted: the
 * Opportunity Engine's own append-only assessments, the watchlist's monitoring
 * intent, and the marketplace and seller observation layers. Nothing here
 * re-scores, re-matches, re-prices or re-invents a figure — every number is a
 * stored observation with its own timestamp, or a value derived deterministically
 * from stored observations (a count, a band tally, or a previous-vs-current
 * comparison).
 *
 * The Dashboard introduces **no score of its own**. Where it ranks, it ranks by
 * the Opportunity Engine's `score` under a fully deterministic tie-break ladder
 * that introduces no new weighting (docs/ARCHITECTURE.md §19.4). Where it flags
 * attention, it flags named conditions the existing engines already recorded,
 * with reason codes and no invented severity (§19.5).
 *
 * This module is pure type declarations on purpose (no `server-only`, no I/O) so
 * the read model is unit-testable with fixtures and the same shapes serve the
 * browser UI.
 */

import type { MarketplaceId } from "@/lib/marketplace/types";
import type { SupplierId } from "@/lib/supplier/types";
import type { ConfidenceBand } from "@/lib/matcher/types";
import type {
  ConfidenceLevel,
  EconomicsCompleteness,
  OpportunityBand,
} from "@/lib/opportunity/types";

/**
 * The standing of one Dashboard section.
 *
 * - `available`   — the section's evidence exists and is complete enough to state.
 * - `partial`     — evidence exists but a documented part of it is missing — for
 *                   example scopes that exist but match no applied filter, or a
 *                   changes feed where every observation is a first observation.
 * - `unavailable` — no evidence exists for this section, or its read failed.
 *                   Reported honestly, never as zero and never as a fabricated
 *                   value.
 *
 * One failing read degrades only its own section: the route still answers `200`
 * with the sections that could be assembled (docs/ARCHITECTURE.md §19.7), so a
 * broken watchlist query never blanks a page whose opportunity summary is fine.
 */
export type SectionStatus = "available" | "partial" | "unavailable";

/**
 * One evaluated opportunity scope, as the Dashboard sees it.
 *
 * A scope is a marketplace listing **and, when the matcher selected one, the
 * supplier candidate it was assessed against**. A listing assessed with no
 * candidate is its own scope — the marketplace-only verdict, hard-capped at LOW
 * — never a placeholder and never a wildcard (docs/ARCHITECTURE.md §16.2).
 *
 * Every figure comes from one persisted assessment row. Internal uuids stay in
 * the repository; the read model speaks provider external ids only.
 */
export interface ScopeAssessment {
  /** Stable marketplace item id (`v1|265983500898|0`). */
  marketplaceExternalId: string;
  /** Stable supplier product id, or `null` for a marketplace-only scope. */
  supplierExternalId: string | null;
  /** The Opportunity Engine's verdict, unmodified. */
  score: number;
  band: OpportunityBand;
  /** Evidence confidence — a separate number from `score`, never derived from it. */
  confidence: number;
  confidenceLevel: ConfidenceLevel;
  /** The Product Matcher's own confidence for this pairing. */
  matchConfidence: number;
  matchConfidenceBand: ConfidenceBand;
  /** The economics layer's completeness verdict for this assessment. */
  economicsCompleteness: EconomicsCompleteness;
  /** Estimated profit as a decimal-string money value; may be negative; `null` when unknown. */
  estimatedProfit: string | null;
  /** Estimated margin in percent; may be negative; `null` when unknown. */
  marginPercent: number | null;
  /** ISO 8601 UTC of the assessment. */
  calculatedAt: string;
  /** Logic version that produced this assessment. */
  engineVersion: string;
  /**
   * The competition query the assessment replayed — the closest persisted thing
   * to the search that surfaced the listing, used to build a Product Detail link
   * the page can actually open. `null` when the assessment recorded none.
   */
  competitionQuery: string | null;
  /** Whether the assessment's inputs included a supplier observation. */
  supplierSnapshotObservedAt: string | null;
  /** Stable observation row id — the final tie-break in every ladder. */
  observationId: string;
}

// ---------------------------------------------------------------------------
// Summary — the KPI cards
// ---------------------------------------------------------------------------

/**
 * A band tally, named so the UI renders a fixed vocabulary and never invents one.
 */
export interface BandTally {
  HIGH: number;
  MEDIUM: number;
  LOW: number;
}

/**
 * An economics completeness tally (COMPLETE / PARTIAL / UNAVAILABLE).
 */
export interface CompletenessTally {
  COMPLETE: number;
  PARTIAL: number;
  UNAVAILABLE: number;
}

export interface SummarySection {
  status: SectionStatus;
  note: string;
  /**
   * Distinct evaluated scopes whose latest assessment falls inside the
   * Dashboard's assessment window. This is the honest definition of "how many
   * opportunities does INKORA know about": scopes whose last assessment predates
   * the window are not represented on this page.
   */
  evaluatedOpportunities: number;
  /** Active watchlist entries over the whole table — an exact head count. */
  watchedOpportunities: number;
  /** Scopes whose latest assessment records a profit strictly greater than zero. */
  profitable: number;
  /** Scopes whose latest assessment records a loss (profit strictly below zero). */
  losing: number;
  /** Scopes whose latest assessment records no profit figure at all. Never zero-as-unknown. */
  profitUnknown: number;
  /** Count of deterministic attention items this page derived (§19.5). */
  needsAttention: number;
  /** All persisted assessments, exact head count over the whole table. */
  persistedAssessments: number;
  /** Opportunity band distribution of the latest assessment per scope. */
  bands: BandTally;
  /** Evidence confidence distribution of the latest assessment per scope. */
  evidenceConfidence: BandTally;
  /** Economics completeness distribution of the latest assessment per scope. */
  economicsCompleteness: CompletenessTally;
}

// ---------------------------------------------------------------------------
// Top opportunities
// ---------------------------------------------------------------------------

/** Marketplace presentation fields for one displayed opportunity. */
export interface OpportunityMarketInfo {
  title: string | null;
  imageUrl: string | null;
  /** Latest persisted marketplace price, decimal string, or `null` when never stored. */
  price: string | null;
  currency: string | null;
  observedAt: string | null;
}

export interface TopOpportunityRow {
  scope: ScopeAssessment;
  market: OpportunityMarketInfo | null;
  /** `true` when an active watchlist entry covers this exact scope. */
  watched: boolean;
  /** Product Detail href for this scope, or `null` when no replay query is persisted. */
  detailHref: string | null;
}

export interface TopOpportunitiesSection {
  status: SectionStatus;
  note: string;
  rows: TopOpportunityRow[];
  /** The sort key actually applied, echoed so the UI never displays an unapplied control. */
  sort: DashboardSortKey;
  /** The limit actually applied. */
  limit: number;
  /** Scopes the window holds, after filtering — the pool the limit was taken from. */
  filteredCount: number;
}


// ---------------------------------------------------------------------------
// Needs attention — deterministic conditions, no severity
// ---------------------------------------------------------------------------

/**
 * One named condition an existing engine already recorded.
 *
 * The Dashboard invents no priority, no weight and no severity score: the reasons
 * are reported as a list, in a fixed order, and the item's position in the section
 * comes from the Opportunity Engine's own score under the same ladder every other
 * list uses (docs/ARCHITECTURE.md §19.5).
 */
export interface AttentionReason {
  /** Stable machine name, e.g. `low-match-profitable`. */
  code: AttentionReasonCode;
  /** Human-readable explanation, never a value judgement. */
  message: string;
}

export type AttentionReasonCode =
  | "low-match-profitable"
  | "low-evidence-strong-score"
  | "economics-unavailable"
  | "economics-partial"
  | "negative-profit"
  | "no-supplier-candidate"
  | "supplier-availability-unknown"
  | "watch-changed";

export interface AttentionItem {
  scope: ScopeAssessment;
  market: OpportunityMarketInfo | null;
  reasons: AttentionReason[];
  watched: boolean;
  detailHref: string | null;
}

export interface AttentionSection {
  status: SectionStatus;
  note: string;
  items: AttentionItem[];
  /** Hard bound actually applied. */
  limit: number;
}

// ---------------------------------------------------------------------------
// Recent changes — previous vs current, never a trend
// ---------------------------------------------------------------------------

/** Direction of one comparison; `unknown` when either side is missing. */
export type ChangeDirection = "up" | "down" | "unchanged" | "unknown";

export interface DashboardChangeRow {
  /** Stable machine name, e.g. `estimatedProfit`. */
  field: string;
  /** Human-readable label, e.g. `Estimated profit`. */
  label: string;
  /** Decimal-string money, a plain number as a string, or a band name. */
  previous: string | null;
  current: string | null;
  /** Signed money delta for money fields; `null` for categorical ones. */
  delta: string | null;
  direction: ChangeDirection;
}

export interface ScopeChange {
  scope: ScopeAssessment;
  market: OpportunityMarketInfo | null;
  rows: DashboardChangeRow[];
  /** ISO 8601 UTC of the *current* observation the change was measured against. */
  calculatedAt: string;
  detailHref: string | null;
}

export interface RecentChangesSection {
  status: SectionStatus;
  note: string;
  changes: ScopeChange[];
  limit: number;
}

// ---------------------------------------------------------------------------
// Watchlist summary
// ---------------------------------------------------------------------------

export interface WatchlistPreviewRow {
  /** Stable entry id — watchlist ids are public (they are the API's own resource id). */
  entryId: string;
  marketplaceExternalId: string;
  supplierExternalId: string | null;
  replayQuery: string;
  label: string | null;
  /** The entry's own last-known assessment, or `null` when it has none yet. */
  assessment: ScopeAssessment | null;
  /** Whether the entry's latest assessment differs materially from its previous one. */
  changed: boolean;
  createdAt: string;
  updatedAt: string;
  detailHref: string | null;
}

export interface WatchlistSummarySection {
  status: SectionStatus;
  note: string;
  /** Active entries, exact head count over the whole table. */
  activeCount: number;
  /** Active entries watching a marketplace-only scope. */
  marketplaceOnlyCount: number;
  /** Entries whose latest assessment differs from the previous one. */
  changedCount: number;
  /** Bounded preview; the full list lives on the watchlist page. */
  preview: WatchlistPreviewRow[];
  limit: number;
}

// ---------------------------------------------------------------------------
// Data coverage
// ---------------------------------------------------------------------------

export interface SupplierEvidenceTally {
  /** A supplier candidate is in scope and a supplier observation was stored. */
  confirmed: number;
  /** A supplier candidate is in scope but no supplier observation was stored. */
  unknown: number;
  /** The assessment has no supplier candidate (marketplace-only scope). */
  none: number;
}

export interface DataCoverageSection {
  status: SectionStatus;
  note: string;
  /** Economics completeness across the latest assessment per scope. */
  economicsCompleteness: CompletenessTally;
  /** Evidence confidence band across the latest assessment per scope. */
  evidenceConfidence: BandTally;
  /** Match confidence band across the latest assessment per scope. */
  matchConfidence: BandTally;
  /** Supplier evidence across the latest assessment per scope. */
  supplierEvidence: SupplierEvidenceTally;
}

// ---------------------------------------------------------------------------
// Recent activity — derived from persisted timestamps, no event table
// ---------------------------------------------------------------------------

export type ActivityType =
  | "opportunity-evaluated"
  | "marketplace-observed"
  | "seller-observed"
  | "watch-added"
  | "watch-re-evaluated";

export interface ActivityEvent {
  type: ActivityType;
  /** Human-readable label, e.g. `Opportunity evaluated`. */
  label: string;
  /** What happened to, when the persisted record identifies it. */
  detail: string;
  /** ISO 8601 UTC the underlying record was observed or calculated. */
  at: string;
  /** Product Detail href when the event identifies one opportunity. */
  detailHref: string | null;
}

export interface ActivitySection {
  status: SectionStatus;
  note: string;
  events: ActivityEvent[];
  limit: number;
  /** Event sources that could not be read, so the feed is labelled partial. */
  unavailableSources: string[];
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
  /** The existing threshold reused, in hours (never a Dashboard invention). */
  staleThresholdHours: number;
  note: string;
}

// ---------------------------------------------------------------------------
// The read model
// ---------------------------------------------------------------------------

/**
 * Everything one Dashboard page renders.
 *
 * Every section carries its own status, so a page whose watchlist evidence is
 * absent still renders the opportunity summary, the changes feed and the
 * freshness panel beside an honest "unavailable" (docs/ARCHITECTURE.md §19.7).
 */
export interface DashboardData {
  marketplace: MarketplaceId;
  supplier: SupplierId;
  /** Whether INKORA holds any persisted intelligence this page can summarise. */
  hasIntelligence: boolean;
  summary: SummarySection;
  topOpportunities: TopOpportunitiesSection;
  attention: AttentionSection;
  changes: RecentChangesSection;
  watchlist: WatchlistSummarySection;
  coverage: DataCoverageSection;
  activity: ActivitySection;
  freshness: FreshnessSection;
  /** Cross-cutting warnings that degrade more than one section. */
  warnings: string[];
}

/**
 * Outcome of assembling the Dashboard.
 *
 *   ok        — a read model was assembled. Sections may still be `unavailable`.
 *   degraded  — assembled, but one or more section reads failed; those sections
 *               report `unavailable` and the rest still render.
 *   disabled  — persistence is not configured, so nothing was read at all.
 */
export type DashboardReadResult =
  | { status: "ok"; dashboard: DashboardData }
  | { status: "degraded"; dashboard: DashboardData }
  | { status: "disabled" };

// ---------------------------------------------------------------------------
// Public controls — filters and sorting
// ---------------------------------------------------------------------------

export type DashboardSortKey =
  | "score"
  | "confidence"
  | "profit"
  | "margin"
  | "match"
  | "recently-evaluated";

export type ProfitabilityFilter = "profitable" | "losing" | "unknown";
export type SupplierScopeFilter = "pair" | "marketplace-only";
export type WatchStateFilter = "watched" | "unwatched";

/**
 * Filters the boundary accepts. Every one is a value from a fixed vocabulary and
 * is compared for equality inside the service — never interpolated into a query,
 * and never a column name (docs/ARCHITECTURE.md §19.6).
 */
export interface DashboardFilters {
  band?: OpportunityBand;
  evidence?: ConfidenceLevel;
  match?: ConfidenceBand;
  economics?: EconomicsCompleteness;
  profitability?: ProfitabilityFilter;
  supplierScope?: SupplierScopeFilter;
  watchState?: WatchStateFilter;
}
