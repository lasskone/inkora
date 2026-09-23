import type { OpportunityAssessment } from "@/lib/opportunity/types";
import type { UpstreamErrorCode } from "@/lib/products/upstream-errors";
import type {
  AssessmentComparison,
  ReEvaluationBatchResult,
  ReEvaluationOutcome,
  ReEvaluationResult,
  WatchlistEntryDetail,
  WatchlistHistoryEntry,
} from "@/lib/watchlist/types";

/**
 * Response shapes of the watchlist API boundary
 * (docs/ARCHITECTURE.md §16, docs/API_INTEGRATIONS.md §5).
 *
 * The watchlist is a monitoring layer, so its responses are either *stored
 * observations* (every one explicitly historical) or the outcome of one
 * user-triggered re-evaluation. Nothing here is a live claim about a listing's
 * current price or stock, and no response ever carries credentials, tokens, or
 * raw upstream payloads.
 */

/**
 * Everything the watchlist boundary can report. The upstream failures are
 * shared with the product-intelligence routes (`UpstreamErrorCode`); the rest
 * are this boundary's own contract.
 */
export type WatchlistErrorCode =
  | UpstreamErrorCode
  | "MALFORMED_BODY"
  | "INVALID_ITEM_ID"
  | "INVALID_SUPPLIER_PRODUCT_ID"
  | "INVALID_QUERY"
  | "INVALID_LABEL"
  | "INVALID_DESTINATION"
  | "INVALID_SORT"
  | "INVALID_FILTER"
  | "INVALID_ENTRY_ID"
  | "INVALID_LIMIT"
  /** The marketplace or supplier identity was never persisted, so there is nothing to watch. */
  | "NOT_OBSERVED"
  /** The entry does not exist, or is already archived. */
  | "ENTRY_NOT_FOUND"
  | "ENTRY_ARCHIVED"
  /** No active slot: the entry cap is reached, so an entry must be archived first. */
  | "WATCHLIST_FULL"
  /** Persistence is not configured, so no watchlist state can be stored or read. */
  | "WATCHLIST_NOT_CONFIGURED"
  /** A write the boundary expected to succeed was rejected by storage. */
  | "PERSISTENCE_FAILED"
  /** The batch named no entry, or more ids than the cap allows. */
  | "ENTRIES_REQUIRED"
  | "TOO_MANY_ENTRIES"
  | "NO_ASSESSMENTS";

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface WatchlistListSuccessResponse {
  status: "ok";
  entries: WatchlistEntryDetail[];
  /** The bounds actually applied — the UI shows real limits, not requested ones. */
  limit: number;
  /** The sort key actually used. */
  sort: string;
  /** The filters actually applied, echoing back every recognized one. */
  filters: Record<string, string>;
  total: number;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Add
// ---------------------------------------------------------------------------

export interface WatchlistAddSuccessResponse {
  status: "ok";
  /** `inserted` the first time this scope is watched; `reused` for a repeat save (idempotent). */
  action: "inserted" | "reused";
  entry: WatchlistEntryDetail;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

export interface WatchlistArchiveSuccessResponse {
  status: "ok";
  /** `archived` when an active entry was archived; `already-archived` is a no-op success. */
  action: "archived" | "already-archived";
  entryId: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface WatchlistHistorySuccessResponse {
  status: "ok";
  history: WatchlistHistoryEntry[];
  limit: number;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Re-evaluation
// ---------------------------------------------------------------------------

/**
 * Maps a re-evaluation outcome onto an HTTP status. Verdict outcomes are 200;
 * everything else is an honest, retryable state that leaves the entry untouched.
 */
export function outcomeToHttpStatus(outcome: ReEvaluationOutcome): number {
  switch (outcome) {
    case "evaluated":
    case "no-candidates":
    case "economics-unavailable":
      return 200;
    case "entry-not-found":
      return 404;
    case "archived":
      return 409;
    case "not-configured":
      return 503;
    case "listing-unavailable":
    case "candidate-not-resolved":
      return 410;
    case "timeout":
      return 504;
    case "upstream-error":
    default:
      return 502;
  }
}

/**
 * Whether an outcome still carries a fresh assessment worth returning in the
 * body — the route reports the assessment and comparison alongside the outcome.
 */
export function outcomeHasVerdict(outcome: ReEvaluationOutcome): boolean {
  return outcome === "evaluated" || outcome === "no-candidates" || outcome === "economics-unavailable";
}

/** A single-entry re-evaluation response. */
export interface WatchlistReEvaluateSuccessResponse {
  status: "ok";
  outcome: ReEvaluationOutcome;
  result: ReEvaluationResult;
  /** Present only for verdict outcomes. */
  assessment?: OpportunityAssessment;
  comparison?: AssessmentComparison | null;
  timestamp: string;
}

/** A bounded batch re-evaluation response. */
export interface WatchlistBatchReEvaluateSuccessResponse {
  status: "ok";
  batch: ReEvaluationBatchResult;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface WatchlistErrorResponse {
  status: "error";
  error: string;
  code: WatchlistErrorCode;
  /**
   * Developer-facing hint naming the variable to configure. Variable *names*
   * only (they are public in `.env.example`) — never a value.
   */
  detail?: string;
  timestamp: string;
}
