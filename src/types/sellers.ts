/**
 * Browser-facing response shapes for the Seller Scanner boundary.
 *
 * These are the only scanner types the client may import. They carry the
 * provider-independent result model and the boundary's fixed error vocabulary —
 * never credentials, never raw upstream payloads, and never a marketplace
 * error body (docs/ARCHITECTURE.md §4.2).
 */

import type { SellerScan } from "@/lib/sellers/types";

export interface SellerScanSuccessResponse {
  status: "ok";
  scan: SellerScan;
  timestamp: string;
}

export type SellerScanErrorCode =
  /** The seller identifier was absent or not a usable handle. */
  | "INVALID_SELLER"
  /** The search context scoping the scan was missing or too long. */
  | "INVALID_QUERY"
  /** The seller was not resolvable, or the marketplace would not scope to it. */
  | "SELLER_NOT_FOUND"
  /** eBay credentials are absent from this server. */
  | "EBAY_NOT_CONFIGURED"
  /** eBay rejected this server's credentials. */
  | "EBAY_AUTH_FAILED"
  /** eBay could not complete the request just now. */
  | "EBAY_UPSTREAM_ERROR"
  /** eBay is rate-limiting this application. */
  | "EBAY_RATE_LIMITED"
  /** A marketplace call failed in a way the caller may retry. */
  | "UPSTREAM_ERROR"
  /** An unexpected failure inside the boundary. */
  | "INTERNAL_ERROR";

export interface SellerScanErrorResponse {
  status: "error";
  error: string;
  code: SellerScanErrorCode;
  timestamp: string;
  /**
   * Additional context that is safe to return: an environment variable *name*,
   * a fixed public OAuth error code, or a bound. Never a value, token or
   * upstream body.
   */
  detail?: string;
}
