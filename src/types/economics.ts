import type { EconomicsResult } from "@/lib/economics/types";
import type { ConfidenceBand } from "@/lib/matcher/types";

/**
 * Response shapes of the economics API boundary.
 *
 * Like the marketplace, supplier and match boundaries, responses are sanitized:
 * they never carry upstream tokens, credentials, or raw provider payloads. The
 * economics figures themselves are Inkora-derived, and every one of them is
 * labelled with its provenance and completeness inside `EconomicsResult`.
 */

export type EconomicsErrorCode =
  | "INVALID_ITEM_ID"
  | "INVALID_QUERY"
  | "INVALID_SUPPLIER_PRODUCT_ID"
  | "INVALID_DESTINATION"
  | "EBAY_NOT_CONFIGURED"
  | "EBAY_AUTH_FAILED"
  | "EBAY_UPSTREAM_ERROR"
  | "EBAY_RATE_LIMITED"
  | "ITEM_NOT_RESOLVED"
  | "CANDIDATE_NOT_FOUND"
  | "CJ_NOT_CONFIGURED"
  | "CJ_AUTH_FAILED"
  | "CJ_UPSTREAM_ERROR"
  | "CJ_RATE_LIMITED"
  | "INTERNAL_ERROR";

/**
 * Honest report of what happened to the observation this evaluation produced.
 * Persistence is best-effort (docs/ARCHITECTURE.md §22): it never turns a
 * successful economics response into an error, and it never claims a write that
 * did not happen. The field is absent when this deployment does not persist.
 */
export interface EconomicsPersistenceReport {
  status: "ok" | "disabled" | "failed";
  /** Present only when `status` is `"failed"`; secret-free. */
  message?: string;
  /**
   * Present only when `status` is `"ok"`. `true` means the observation was newly
   * inserted; `false` means deduplication found an identical latest observation
   * and reused it, so nothing changed.
   */
  inserted?: {
    marketplaceSnapshot: boolean;
    supplierSnapshot: boolean;
    supplierVariantSnapshot: boolean;
    matchObservation: boolean;
    economicsObservation: boolean;
  };
}

export interface EconomicsSuccessResponse {
  status: "ok";
  economics: EconomicsResult;
  /** Matcher confidence of the candidate the economics were computed for. */
  matchConfidence: number;
  matchConfidenceBand: ConfidenceBand;
  /** Outcome of persisting this evaluation as a historical observation. */
  persistence?: EconomicsPersistenceReport;
  timestamp: string;
}

export interface EconomicsErrorResponse {
  status: "error";
  error: string;
  code: EconomicsErrorCode;
  /**
   * Developer-facing hint naming the variable to configure. Variable *names*
   * only (they are public in `.env.example`) — never a value.
   */
  detail?: string;
  timestamp: string;
}
