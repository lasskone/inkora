import type { MarketplaceProduct } from "@/lib/marketplace/types";

/**
 * Response shapes of the marketplace search API boundary.
 *
 * Responses are deliberately sanitized: they never carry upstream tokens,
 * credentials, or raw provider error payloads.
 */
export type EbayEnvironmentLabel = "production" | "sandbox";

export type MarketplaceSearchErrorCode =
  | "INVALID_QUERY"
  | "INVALID_LIMIT"
  | "EBAY_NOT_CONFIGURED"
  | "EBAY_AUTH_FAILED"
  | "EBAY_UPSTREAM_ERROR"
  | "EBAY_RATE_LIMITED"
  | "INTERNAL_ERROR";

export interface MarketplaceSearchSuccessResponse {
  status: "ok";
  marketplace: "ebay";
  /** Reported honestly, so sandbox data is never mistaken for production data. */
  environment: EbayEnvironmentLabel;
  query: string;
  limit: number;
  offset: number;
  total: number | null;
  count: number;
  products: MarketplaceProduct[];
  timestamp: string;
}

export interface MarketplaceSearchErrorResponse {
  status: "error";
  marketplace: "ebay";
  /** Safe, human-readable reason. Never a raw upstream payload. */
  error: string;
  code: MarketplaceSearchErrorCode;
  /**
   * Developer-facing hint naming the variable to configure. Variable *names*
   * only (they are public in `.env.example`) — never a value.
   */
  detail?: string;
  timestamp: string;
}
