import type { ScanResult } from "@/lib/scanner/types";
import type { UpstreamErrorCode } from "@/lib/products/upstream-errors";

/**
 * Response shapes of the scanner API boundary
 * (`POST /api/scanner/scan`).
 *
 * The scanner is user-triggered and bounded: one request fans out into a
 * fixed, auditable number of upstream calls (docs/ARCHITECTURE.md §15,
 * docs/API_INTEGRATIONS.md §2.3), and every limit the server applied is echoed
 * back in `meta.limits` so the UI can display the actual bounds, not the ones
 * it asked for. As with every other intelligence boundary, responses never
 * carry upstream tokens, credentials, or raw provider payloads.
 *
 * A `partial` status is a success: the scan ran, produced verdicts, and is
 * honestly reporting which listings it could not assess. Only a whole-pipeline
 * failure is an HTTP error.
 */

export type ScannerErrorCode =
  | UpstreamErrorCode
  | "INVALID_QUERY"
  | "INVALID_MODE"
  | "ITEMS_REQUIRED"
  | "INVALID_ITEM_ID"
  | "TOO_MANY_ITEMS"
  | "ITEM_NOT_RESOLVED"
  | "INVALID_DESTINATION"
  | "DISCOVERY_FAILED"
  | "MALFORMED_BODY";

export interface ScannerSuccessResponse extends ScanResult {
  status: "ok" | "partial";
  timestamp: string;
}

export interface ScannerErrorResponse {
  status: "error";
  error: string;
  code: ScannerErrorCode;
  /**
   * Developer-facing hint naming the variable to configure or the input to fix.
   * Variable *names* only (they are public in `.env.example`) — never a value.
   */
  detail?: string;
  timestamp: string;
}
