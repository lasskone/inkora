/**
 * Product Detail response shapes (docs/ARCHITECTURE.md §18).
 *
 * The browser identifies a listing by its stable marketplace item id and the
 * query that surfaced it — never a product object, price, candidate or score.
 * Every figure in a response is a stored observation or a value derived
 * server-side from stored observations, so no client-submitted intelligence
 * value can ever become trusted truth here.
 */

import type { ProductDetail } from "@/lib/product-detail/types";
import type { OpportunityAssessment } from "@/lib/opportunity/types";
import type { UpstreamErrorCode } from "@/lib/products/upstream-errors";
import type { AssessmentComparison } from "@/lib/watchlist/types";

/** Read outcome the route reports when persistence has nothing for this id. */
export type ProductDetailOutcome = "ok" | "not-observed" | "disabled";

export interface ProductDetailSuccessResponse {
  status: "ok";
  outcome: ProductDetailOutcome;
  /** Present whenever at least one persisted observation exists. */
  detail?: ProductDetail;
  /** The bound actually applied to every history read. */
  historyLimit: number;
  /** Whether a live re-evaluation is available on this server. */
  refreshAvailable: boolean;
  timestamp: string;
}

export interface ProductDetailRefreshSuccessResponse {
  status: "ok";
  outcome: ProductDetailRefreshOutcome;
  /** The fresh assessment, present only for verdict outcomes. */
  assessment?: OpportunityAssessment;
  /** The previous-vs-current comparison, present only for verdict outcomes. */
  comparison?: AssessmentComparison | null;
  /** The read model after the refresh, so the page reflects storage. */
  detail?: ProductDetail;
  /** Outcome of persisting the new assessment; absent when nothing persisted. */
  persistence?: { status: "ok" | "disabled" | "failed"; inserted?: boolean; message?: string };
  historyLimit: number;
  timestamp: string;
}

/**
 * The outcome of one deliberate re-evaluation. Mirrors the watchlist's
 * vocabulary deliberately: the same identity-preserving rules apply, and a
 * non-evaluated outcome never silently swaps the persisted pairing.
 *
 * There is deliberately no `not-observed` here: an unobserved listing is a
 * reason to evaluate, not a refusal, so a refresh can create the *first*
 * observation (and then reports `comparison.noPrevious === true` alongside a
 * null `detail` read-back). Refusing would make a brand-new listing look
 * unassessable when it is simply not yet stored.
 */
export type ProductDetailRefreshOutcome =
  | "evaluated"
  | "no-candidates"
  | "economics-unavailable"
  | "item-not-found"
  | "candidate-not-resolved"
  | "upstream-error";

export type ProductDetailErrorCode =
  | UpstreamErrorCode
  | "INVALID_ITEM_ID"
  | "INVALID_QUERY"
  | "INVALID_SUPPLIER_PRODUCT_ID"
  | "INVALID_DESTINATION"
  | "MALFORMED_BODY"
  | "EBAY_NOT_CONFIGURED"
  | "CJ_NOT_CONFIGURED"
  | "PERSISTENCE_NOT_CONFIGURED"
  | "INTERNAL_ERROR";

export interface ProductDetailErrorResponse {
  status: "error";
  error: string;
  code: ProductDetailErrorCode;
  /**
   * Developer-facing hint naming the variable to configure. Variable *names*
   * only (they are public in `.env.example`) — never a value.
   */
  detail?: string;
  timestamp: string;
}
