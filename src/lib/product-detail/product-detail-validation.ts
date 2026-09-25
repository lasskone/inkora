/**
 * Pure input validation for the Product Detail boundary
 * (docs/ARCHITECTURE.md §18.3).
 *
 * This module is deliberately free of any `server-only` dependency: the same
 * validators serve the route, the client-side link builders and the unit tests,
 * so a deep link can never be built that the server would accept differently
 * than the page that generated it.
 *
 * The browser never posts intelligence values — only opaque provider ids and
 * the query it searched. Everything else is re-derived server-side, so the
 * surface an attacker can reach is exactly the two strings validated here.
 *
 * Ids are validated structurally and then only ever compared for equality
 * against ids the server itself resolved — never interpolated into a URL or an
 * upstream query — exactly as the opportunity route treats them
 * (docs/ARCHITECTURE.md §8.3).
 */

import type { ProductDetailErrorCode } from "@/types/product-detail";

/** eBay item ids are opaque composite strings, e.g. `v1|265983500898|0`. */
export const ITEM_ID_PATTERN = /^[A-Za-z0-9|._-]{1,60}$/;

/** CJ product ids are opaque keys handled exactly like eBay item ids. */
export const SUPPLIER_PRODUCT_ID_PATTERN = /^[A-Za-z0-9|._-]{1,100}$/;

/** ISO 3166-1 alpha-2 destination code. */
export const DESTINATION_PATTERN = /^[A-Za-z]{2}$/;

export const MIN_QUERY_LENGTH = 1;
export const MAX_QUERY_LENGTH = 100;

/** A validated Product Detail request — ids only, never intelligence values. */
export interface ProductDetailRequest {
  itemId: string;
  query: string;
  supplierProductId: string | null;
  destinationCountry: string | null;
}

/** Outcome of validating one request. Errors are returned, never thrown. */
export type ValidationResult =
  | { status: "valid"; request: ProductDetailRequest }
  | { status: "invalid"; code: ProductDetailErrorCode; message: string };

/**
 * Validates a GET request's query string.
 *
 * `itemId` is mandatory — without it there is no product to detail. `query` is
 * mandatory too, because it is the window the server replays to re-resolve the
 * listing on a refresh; without it a refresh can only refuse. A supplier id is
 * optional and names the pairing in scope.
 */
export function validateProductDetailRequest(params: {
  itemId: string | null;
  query: string | null;
  supplierProductId?: string | null;
  destinationCountry?: string | null;
}): ValidationResult {
  const itemId = (params.itemId ?? "").trim();
  if (!ITEM_ID_PATTERN.test(itemId)) {
    return {
      status: "invalid",
      code: "INVALID_ITEM_ID",
      message: "A valid marketplace item id is required.",
    };
  }

  const query = (params.query ?? "").trim();
  if (query.length < MIN_QUERY_LENGTH || query.length > MAX_QUERY_LENGTH) {
    return {
      status: "invalid",
      code: "INVALID_QUERY",
      message: "The search term that surfaced this listing is required (1–100 characters).",
    };
  }

  const supplierProductId = (params.supplierProductId ?? "").trim();
  if (supplierProductId !== "" && !SUPPLIER_PRODUCT_ID_PATTERN.test(supplierProductId)) {
    return {
      status: "invalid",
      code: "INVALID_SUPPLIER_PRODUCT_ID",
      message: "A supplier product id, when provided, must be a valid supplier product id.",
    };
  }

  const destinationCountry = (params.destinationCountry ?? "").trim().toUpperCase();
  if (destinationCountry !== "" && !DESTINATION_PATTERN.test(destinationCountry)) {
    return {
      status: "invalid",
      code: "INVALID_DESTINATION",
      message: "A destination country, when provided, must be a two-letter country code.",
    };
  }

  return {
    status: "valid",
    request: {
      itemId,
      query,
      supplierProductId: supplierProductId === "" ? null : supplierProductId,
      destinationCountry: destinationCountry === "" ? null : destinationCountry,
    },
  };
}

/**
 * Validates a refresh request's JSON body. The body may carry the same fields
 * as the read request; anything else present is ignored rather than trusted,
 * and no intelligence value is ever read from it.
 */
export function validateProductDetailRefreshBody(body: unknown): ValidationResult {
  if (typeof body !== "object" || body === null) {
    return {
      status: "invalid",
      code: "MALFORMED_BODY",
      message: "The request body must be a JSON object.",
    };
  }

  const record = body as Record<string, unknown>;
  return validateProductDetailRequest({
    itemId: typeof record.itemId === "string" ? record.itemId : null,
    query: typeof record.query === "string" ? record.query : null,
    supplierProductId:
      typeof record.supplierProductId === "string" ? record.supplierProductId : null,
    destinationCountry:
      typeof record.destinationCountry === "string" ? record.destinationCountry : null,
  });
}
