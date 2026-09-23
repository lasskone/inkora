/**
 * Opportunity Scanner V1 — type declarations.
 *
 * The scanner is a **bounded orchestration layer** over services that already
 * exist and are independently tested (docs/ARCHITECTURE.md §15):
 *
 * ```text
 *   eBay search  →  candidate selection  →  Product Matcher
 *                                          →  Economics Engine
 *                                          →  Opportunity Engine
 *                                          →  persistence
 *                                          →  deterministic ranking
 * ```
 *
 * It composes; it does not duplicate. Every domain decision — what a match is,
 * what a profit figure means, what a score says — stays owned by the engine that
 * produced it. The scanner adds exactly three things:
 *
 *   1. a bounded batch (selection → deep evaluation with a concurrency cap);
 *   2. failure isolation, so one bad listing never kills the scan;
 *   3. a deterministic ranking with documented tie-breakers.
 *
 * This module is pure type declarations on purpose (no `server-only`, no runtime
 * imports) so the orchestration is unit-testable with Node's built-in runner and
 * the same shapes serve the browser UI.
 */

import type {
  MarketplaceProduct,
  MarketplaceSearchResult,
} from "@/lib/marketplace/types";
import type { MatchCandidate, MatchResult } from "@/lib/matcher/types";
import type { EconomicsResult } from "@/lib/economics/types";
import type { SupplierVariant } from "@/lib/supplier/types";
import type {
  HistoryEvidenceSummary,
  OpportunityAssessment,
  OpportunityLimits,
} from "@/lib/opportunity/types";
import type { OpportunityPersistenceReport } from "@/types/opportunity";
import type { PersistedRecords } from "@/lib/persistence/persistence-service";

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * How the user wants the scan to select the batch it deep-evaluates.
 *
 * - `manual` — the browser names the eBay item ids it has already seen in the
 *   discovery grid; the server re-resolves each one against its own replayed
 *   search window and reports any id that scrolled out.
 * - `batch`   — the server picks the first `limit` listings of the discovery
 *   window deterministically, with no client input into *which* ones.
 *
 * Either way the client never supplies a product object, a price, or a
 * candidate — only opaque ids and a query (docs/ARCHITECTURE.md §15).
 */
export type ScanMode = "manual" | "batch";

/** What one scan is asked to do. */
export interface ScanRequest {
  query: string;
  mode: ScanMode;
  /**
   * `manual` mode only: eBay item ids the user selected from the discovery
   * grid. Duplicates are collapsed; the server never evaluates more than
   * `SCANNER_MAX_EVALUATIONS`, and every id must resolve inside the replayed
   * window or it is reported, not matched.
   */
  itemIds?: string[];
  /**
   * `batch` mode only: how many of the discovery window to deep-evaluate.
   * Clamped to `[1, SCANNER_MAX_EVALUATIONS]` server-side; a client value above
   * the cap is clamped, never honoured.
   */
  limit?: number;
  /** Optional ISO 3166-1 alpha-2 destination override, as the economics route accepts. */
  destinationCountry?: string;
}

// ---------------------------------------------------------------------------
// Per-item outcomes
// ---------------------------------------------------------------------------

/**
 * What actually happened to one listing inside the scan. The scanner reports
 * this per item and never lets one outcome fail the batch
 * (docs/ARCHITECTURE.md §15.3).
 *
 * Only the first three are *verdicts* — the Opportunity Engine produced a
 * complete, explainable assessment. The rest are honest failures the UI shows
 * beside the successes.
 */
export type ScanItemOutcome =
  /**
   * Matched, economics computed (any completeness), full assessment produced.
   */
  | "evaluated"
  /**
   * The matcher surfaced no candidate. Still a complete assessment, hard-capped
   * at LOW by the engine — a verdict about the listing, not an error.
   */
  | "no-candidates"
  /**
   * A candidate exists but economics could not be computed (for example a CJ
   * freight failure). The engine assesses with `economics: null`; the result is
   * a real assessment with an explicit UNAVAILABLE economics component.
   */
  | "economics-unavailable"
  /** The item id scrolled out of the replayed discovery window. */
  | "item-not-found"
  /** A CJ/eBay failure this item could not recover from. */
  | "upstream-error"
  /** The scan's wall-clock budget elapsed before this item finished. */
  | "timeout";

/**
 * One listing's result inside a scan. Carries everything the UI needs to show a
 * side-by-side eBay↔CJ comparison and the full reasoning behind the verdict.
 */
export interface ScanItem {
  /** Stable position of the listing in the replayed discovery window. */
  discoveryIndex: number;
  /**
   * The marketplace listing, resolved server-side — never browser-supplied.
   * `null` only for an id that scrolled out of the replayed window, in which
   * case `requestedItemId` names what was asked for.
   */
  marketplaceProduct: MarketplaceProduct | null;
  /** The id the browser asked for, when it could not be resolved. */
  requestedItemId?: string;
  /** The matcher's full result, including every query and why it was generated. */
  matchResult: MatchResult | null;
  /** The candidate the assessment scored, or `null` when the matcher found none. */
  candidate: MatchCandidate | null;
  /** Economics for that candidate, or `null` when they could not be computed. */
  economics: EconomicsResult | null;
  /** The complete, self-explaining assessment. Always present for verdict outcomes. */
  assessment: OpportunityAssessment | null;
  /** Bounded history the engine was allowed to see, or `null` when none exists. */
  history: HistoryEvidenceSummary | null;
  /** Outcome classification; the UI never has to guess why a field is null. */
  outcome: ScanItemOutcome;
  /**
   * Secret-free reason explaining a non-verdict outcome, or a verdict whose
   * economics could not be computed. Absent when nothing notable happened. Safe
   * to render: it carries no token, credential, or raw provider payload.
   */
  failureCode?: string;
  failureMessage?: string;
  /** Outcome of persisting this item's assessment. Absent when nothing was persisted. */
  persistence?: OpportunityPersistenceReport;
  /** Milliseconds this item's deep evaluation took, for the scan report. */
  durationMs: number;
}


// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/**
 * The scan's own identity. A scan is user-triggered, stateless, and deliberately
 * *not* persisted as its own job: every item's assessment is already an
 * append-only observation carrying its query and timestamp, so a scan row would
 * duplicate observations that already exist (docs/ARCHITECTURE.md §15.4).
 */
export interface ScanMeta {
  /** Scanner orchestration version. */
  scannerVersion: string;
  /** ISO 8601 UTC timestamp the scan started. */
  startedAt: string;
  /** ISO 8601 UTC timestamp the scan completed. */
  completedAt: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  query: string;
  mode: ScanMode;
  /** How many listings the discovery window actually surfaced. */
  discoveryCount: number;
  /** How many listings the scan attempted to deep-evaluate. */
  selectedCount: number;
  /** How many produced a verdict (any of the three verdict outcomes). */
  evaluatedCount: number;
  /** How many produced no verdict, for any reason. */
  failedCount: number;
  /** The destination economics were quoted against. */
  destinationLabel: string;
  /** The effective, server-enforced limits actually applied. */
  limits: ScanLimits;
}

/** Effective bounds a scan ran under, reported so the UI can show them. */
export interface ScanLimits {
  discoveryLimit: number;
  maxEvaluations: number;
  concurrency: number;
  deadlineMs: number;
}

/** Overall scan status. `partial` means at least one item produced no verdict. */
export type ScanStatus = "ok" | "partial";

/**
 * The complete result of one scan: a ranked, explainable set of opportunities
 * plus an honest report of everything that did not work.
 */
export interface ScanResult {
  status: ScanStatus;
  meta: ScanMeta;
  /**
   * Ranked results — verdict items only, best Opportunity Score first. Items
   * that produced no verdict are in `failures`, not here, so a caller consuming
   * the ranking never has to filter out an unassessable row.
   */
  results: ScanItem[];
  /** Items that produced no verdict, with their reasons. */
  failures: ScanItem[];
}

// ---------------------------------------------------------------------------
// Injected ports
// ---------------------------------------------------------------------------

/**
 * The external capabilities the scanner needs, injected by the route.
 *
 * Constructing adapters inside the scanner would make it untestable without a
 * network and would hide how many upstream calls one scan costs; injecting them
 * makes both explicit — the same reasoning as `CandidateResolutionPorts`
 * (docs/ARCHITECTURE.md §8.3, §15.2).
 */
export interface ScannerPorts {
  /** Replays the marketplace search that surfaced the discovery window. */
  searchMarketplace(request: {
    query: string;
    limit: number;
    offset: number;
  }): Promise<MarketplaceSearchResult>;
  /** Runs the bounded matcher against one listing. */
  matchCandidates(product: MarketplaceProduct): Promise<MatchResult>;
  /** Computes economics for one matcher candidate. */
  computeEconomics(request: {
    candidate: MatchCandidate;
    destination: ScanDestination;
  }): Promise<EconomicsOutcome>;
  /** Reads the bounded history one assessment is allowed to see. */
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
    selectedVariant: SupplierVariant | null;
  }): Promise<PersistedRecords | null>;
  /** Persists one assessment as a historical observation, best-effort. */
  persistAssessment(params: {
    assessment: OpportunityAssessment;
    marketplaceProduct: MarketplaceProduct;
    evaluation: PersistedRecords | null;
  }): Promise<OpportunityPersistenceReport | undefined>;
}

/** The destination economics are quoted against, mirroring `ShippingBaseline`. */
export interface ScanDestination {
  countryCode: string;
  postalCode: string | null;
  label: string;
}

/** What the economics port returns: the result plus the resolved variant. */
export interface EconomicsOutcome {
  result: EconomicsResult;
  selectedVariant: SupplierVariant | null;
}

// ---------------------------------------------------------------------------
// Outcome helpers
// ---------------------------------------------------------------------------

/** The three outcomes that mean "the Opportunity Engine produced a verdict". */
export const VERDICT_OUTCOMES: ReadonlySet<ScanItemOutcome> = new Set([
  "evaluated",
  "no-candidates",
  "economics-unavailable",
]);

/** Whether an item's outcome is a verdict the Opportunity Engine produced. */
export function isVerdict(outcome: ScanItemOutcome): boolean {
  return VERDICT_OUTCOMES.has(outcome);
}
