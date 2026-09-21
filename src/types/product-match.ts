import type { MatchResult } from "@/lib/matcher/types";

/**
 * Response shapes of the Product Matcher API boundary.
 *
 * Like the marketplace and supplier boundaries, responses are sanitized: they
 * never carry upstream tokens, credentials, or raw provider error payloads.
 * The match confidence itself is always labelled `ESTIMATED`, because it is
 * derived by Inkora rather than asserted by eBay or CJ
 * (docs/ARCHITECTURE.md §7 and §8).
 */

export type ProductMatchErrorCode =
  | "INVALID_ITEM_ID"
  | "INVALID_QUERY"
  | "INVALID_LIMIT"
  | "EBAY_NOT_CONFIGURED"
  | "EBAY_AUTH_FAILED"
  | "EBAY_UPSTREAM_ERROR"
  | "EBAY_RATE_LIMITED"
  | "ITEM_NOT_RESOLVED"
  | "CJ_NOT_CONFIGURED"
  | "CJ_AUTH_FAILED"
  | "CJ_UPSTREAM_ERROR"
  | "CJ_RATE_LIMITED"
  | "INTERNAL_ERROR";

export interface ProductMatchSuccessResponse extends MatchResult {
  status: "ok";
  timestamp: string;
}

export interface ProductMatchErrorResponse {
  status: "error";
  error: string;
  code: ProductMatchErrorCode;
  /**
   * Developer-facing hint naming the variable to configure. Variable *names*
   * only (they are public in `.env.example`) — never a value.
   */
  detail?: string;
  timestamp: string;
}
