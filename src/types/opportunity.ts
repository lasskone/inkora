import type { OpportunityAssessment } from "@/lib/opportunity/types";
import type { UpstreamErrorCode } from "@/lib/products/upstream-errors";

/**
 * Response shapes of the opportunity API boundary.
 *
 * The assessment itself is the whole response body: it already carries its
 * score, its confidence, every component, every factor, every cap, and its own
 * caveats, so the boundary adds nothing to it but the outcome of persisting it.
 * Like the other intelligence boundaries, responses never carry upstream tokens,
 * credentials, or raw provider payloads.
 */

/**
 * Everything this route can report. The upstream failures are shared with the
 * economics route (`UpstreamErrorCode`); the rest are this route's own
 * contract.
 */
export type OpportunityErrorCode =
  | UpstreamErrorCode
  | "INVALID_ITEM_ID"
  | "INVALID_QUERY"
  | "INVALID_SUPPLIER_PRODUCT_ID"
  | "INVALID_DESTINATION"
  /** The listing scrolled out of the replayed search window. */
  | "ITEM_NOT_RESOLVED"
  /** A requested supplier product is not a matcher candidate for this listing. */
  | "CANDIDATE_NOT_FOUND";

/**
 * Honest report of what happened to the assessment this request produced.
 * Persistence is best-effort (docs/ARCHITECTURE.md §13): it never turns a
 * successful assessment into an error, and it never claims a write that did not
 * happen. The field is absent when this deployment does not persist.
 */
export interface OpportunityPersistenceReport {
  status: "ok" | "disabled" | "failed";
  /** Present only when `status` is `"failed"`; secret-free. */
  message?: string;
  /**
   * Present only when `status` is `"ok"`. `true` means a new assessment row was
   * inserted; `false` means deduplication found an identical latest assessment
   * and reused it, so the verdict is unchanged since last time.
   */
  inserted?: boolean;
}

export interface OpportunitySuccessResponse {
  status: "ok";
  assessment: OpportunityAssessment;
  /** Outcome of persisting this assessment as a historical observation. */
  persistence?: OpportunityPersistenceReport;
  timestamp: string;
}

export interface OpportunityErrorResponse {
  status: "error";
  error: string;
  code: OpportunityErrorCode;
  /**
   * Developer-facing hint naming the variable to configure. Variable *names*
   * only (they are public in `.env.example`) — never a value.
   */
  detail?: string;
  timestamp: string;
}
