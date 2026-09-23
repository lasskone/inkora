/**
 * Shared HTTP-boundary helpers for the watchlist routes
 * (docs/ARCHITECTURE.md §16, docs/API_INTEGRATIONS.md §5).
 *
 * Every route of this boundary validates the same way, reports errors the same
 * way, and gates on the same configuration, so those rules live here once and
 * are pinned by unit tests rather than re-implemented per endpoint. As
 * everywhere else in the codebase, a request that names an unusable value is
 * rejected with the reason; nothing is silently coerced into a default that
 * could hide a client bug.
 *
 * Responses are built with the standard Web `Response` rather than
 * `NextResponse`: `NextResponse.json` is `Response.json` under the hood, and
 * using the platform primitive keeps this module free of a framework import
 * that Node's own runner cannot resolve — so the contract stays unit-testable
 * with no database, no network and no bundler.
 */

import "server-only";

import { requireCjConfig } from "@/lib/cj/config";
import { resolveEbayConfig } from "@/lib/ebay/config";
import { resolveShippingBaseline } from "@/lib/economics/config";
import type { ConfidenceLevel, OpportunityBand } from "@/lib/opportunity/types";
import type { EconomicsCompleteness } from "@/lib/economics/types";
import type { ScanDestination } from "@/lib/scanner/types";

import { WATCHLIST_MAX_RE_EVALUATIONS } from "./limits";
import { WATCHLIST_SORT_KEYS, type WatchlistFilters, type WatchlistSortKey } from "./sorting";
import type {
  ReEvaluationOutcome,
  ReEvaluationResult,
  WatchlistAddInput,
} from "./types";
import type { WatchlistErrorCode, WatchlistErrorResponse } from "@/types/watchlist";

/** A watchlist request body is a handful of ids and a query, never a payload. */
export const MAX_BODY_BYTES = 8_192;

/** A provider external id is short and opaque; this is a shape check, not a semantic one. */
const EXTERNAL_ID_MAX_LENGTH = 64;

/** Mirrors the scanner's query bound so a replay sees the same window shape. */
const QUERY_MAX_LENGTH = 100;

/** A free-text note stays short. */
const LABEL_MAX_LENGTH = 200;

/** ISO 3166-1 alpha-2, the only destination shape this boundary understands. */
const COUNTRY_CODE = /^[A-Z]{2}$/;

/** The watchlist's ids are server-assigned uuids; nothing else is accepted. */
const ENTRY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Builds the boundary's error body. `detail` names an environment variable only
 * (those are public in `.env.example`) — never a value, never a token.
 */
export function watchlistJsonError(
  status: number,
  code: WatchlistErrorCode,
  message: string,
  timestamp: string,
  detail?: string,
): Response {
  const body: WatchlistErrorResponse = {
    status: "error",
    error: message,
    code,
    timestamp,
    ...(detail !== undefined && detail.length > 0 ? { detail } : {}),
  };
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Reads and validates the request body as a plain object. Returns the parsed
 * object, or an already-built error response the route returns verbatim.
 */
export async function readWatchlistBody(
  request: Request,
  timestamp: string,
): Promise<Record<string, unknown> | Response> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return watchlistJsonError(400, "MALFORMED_BODY", "The request body could not be read.", timestamp);
  }

  // A re-evaluation may legitimately post no body at all; an empty body is an
  // empty object, so the endpoint stays usable without a payload.
  if (text.trim().length === 0) {
    return {};
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return watchlistJsonError(
      400,
      "MALFORMED_BODY",
      "Send a JSON body with Content-Type: application/json.",
      timestamp,
    );
  }

  if (text.length > MAX_BODY_BYTES) {
    return watchlistJsonError(
      413,
      "MALFORMED_BODY",
      "The request body is larger than this endpoint accepts.",
      timestamp,
    );
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return watchlistJsonError(400, "MALFORMED_BODY", "The body must be a JSON object.", timestamp);
    }
    return parsed as Record<string, unknown>;
  } catch {
    return watchlistJsonError(400, "MALFORMED_BODY", "The request body is not valid JSON.", timestamp);
  }
}

/**
 * eBay configuration gate that returns instead of throwing, so a route can
 * report the missing variable by name instead of surfacing a 500.
 */
export function resolveEbayConfigSafe(): unknown {
  try {
    return resolveEbayConfig();
  } catch {
    return null;
  }
}

/** CJ configuration gate that returns instead of throwing. */
export function requireCjConfigSafe(): unknown {
  try {
    return requireCjConfig();
  } catch {
    return null;
  }
}

/**
 * Refuses the request when either provider is unconfigured. Without eBay there
 * is no listing to re-resolve and without CJ there is no candidate to prove, so
 * there is nothing honest to return but the names of the variables.
 *
 * Returns `null` when both are configured and the route may proceed.
 */
export function requireProvidersConfigured(timestamp: string): Response | null {
  if (resolveEbayConfigSafe() === null) {
    return watchlistJsonError(
      503,
      "EBAY_NOT_CONFIGURED",
      "eBay marketplace search is not configured on this server.",
      timestamp,
      "Set EBAY_ENV, EBAY_CLIENT_ID and EBAY_CLIENT_SECRET in .env.local.",
    );
  }
  if (requireCjConfigSafe() === null) {
    return watchlistJsonError(
      503,
      "CJ_NOT_CONFIGURED",
      "CJdropshipping is not configured on this server, so no opportunity can be assessed.",
      timestamp,
      "Set CJ_API_KEY in .env.local.",
    );
  }
  return null;
}


/** Trims a value into a string, or `null` when it is absent or not a string. */
function trimString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() : null;
}

/** A provider external id, or `null` when the value is unusable. */
function validExternalId(value: unknown): string | null {
  const trimmed = trimString(value);
  if (trimmed === null || trimmed.length === 0 || trimmed.length > EXTERNAL_ID_MAX_LENGTH) {
    return null;
  }
  return trimmed;
}

/** The query a re-evaluation replays, or `null` when it is unusable. */
function validQuery(value: unknown): string | null {
  const trimmed = trimString(value);
  if (trimmed === null || trimmed.length === 0 || trimmed.length > QUERY_MAX_LENGTH) {
    return null;
  }
  return trimmed;
}

/** A user note, or `null` when it is absent or too long. */
function validLabel(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = trimString(value);
  if (trimmed === null || trimmed.length > LABEL_MAX_LENGTH) {
    return null;
  }
  return trimmed;
}

/** A destination country code, normalized to uppercase, or `null` when unusable. */
function validCountryCode(value: unknown): string | null {
  const trimmed = trimString(value);
  if (trimmed === null || !COUNTRY_CODE.test(trimmed.toUpperCase())) {
    return null;
  }
  return trimmed.toUpperCase();
}

/** A watchlist entry id, or `null` when it is not a uuid. */
export function validEntryId(value: unknown): string | null {
  const trimmed = trimString(value);
  if (trimmed === null || !ENTRY_ID.test(trimmed)) {
    return null;
  }
  return trimmed.toLowerCase();
}

/**
 * Validates an add request. The browser posts only stable provider ids, the
 * replay query and an optional note — never a product, a price or a score
 * (docs/ARCHITECTURE.md §16.1).
 *
 * A missing or null `supplierExternalId` is a **marketplace-only watch** — a
 * distinct scope, not a wildcard (docs/DATABASE.md §6.9).
 */
export function parseAddInput(body: Record<string, unknown>): WatchlistAddInput | null {
  const marketplaceExternalId = validExternalId(body.marketplaceExternalId);
  if (marketplaceExternalId === null) {
    return null;
  }
  const replayQuery = validQuery(body.replayQuery);
  if (replayQuery === null) {
    return null;
  }
  const label = validLabel(body.label);

  const supplierRaw = body.supplierExternalId;
  if (supplierRaw === undefined || supplierRaw === null) {
    return { marketplaceExternalId, supplierExternalId: null, replayQuery, label };
  }
  const supplierExternalId = validExternalId(supplierRaw);
  if (supplierExternalId === null) {
    return null;
  }
  return { marketplaceExternalId, supplierExternalId, replayQuery, label };
}

/** A destination country override, or `null` when the request names none. */
export function parseDestinationOverride(value: unknown): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return validCountryCode(value);
}

/**
 * The destination economics are quoted against, mirroring the scanner route: the
 * server's configured baseline, possibly overridden by a two-letter country.
 * (docs/ARCHITECTURE.md §16.2).
 */
export function resolveWatchlistDestination(override: string | null): ScanDestination {
  const baseline = resolveShippingBaseline();
  if (override === null || override === baseline.countryCode) {
    return baseline;
  }
  return {
    countryCode: override,
    postalCode: baseline.postalCode,
    label: `requested destination ${override}`,
  };
}

/**
 * The outcome as the response reports it. A config failure arrives from the
 * orchestrator as `upstream-error` with a `EBAY_NOT_CONFIGURED` /
 * `CJ_NOT_CONFIGURED` code; the boundary re-labels it `not-configured` so the
 * status is 503 (fixable by the operator) rather than 502 (upstream's fault).
 */
export function responseOutcome(result: ReEvaluationResult): ReEvaluationOutcome {
  if (
    result.failureCode === "EBAY_NOT_CONFIGURED" ||
    result.failureCode === "CJ_NOT_CONFIGURED"
  ) {
    return "not-configured";
  }
  return result.outcome;
}

/**
 * The sort key a client may request, or `null` when it names something this
 * boundary does not order by. The watchlist invents no score of its own
 * (docs/ARCHITECTURE.md §16.9): every key here is a transparent existing field.
 */
export function parseSortKey(value: unknown): WatchlistSortKey | null {
  if (typeof value !== "string") {
    return null;
  }
  return (WATCHLIST_SORT_KEYS as readonly string[]).includes(value)
    ? (value as WatchlistSortKey)
    : null;
}

const BANDS: readonly OpportunityBand[] = ["LOW", "MEDIUM", "HIGH"];
const LEVELS: readonly ConfidenceLevel[] = ["LOW", "MEDIUM", "HIGH"];
const COMPLETENESS: readonly EconomicsCompleteness[] = ["COMPLETE", "PARTIAL", "UNAVAILABLE"];
const PROFITABILITY = ["profitable", "unprofitable"] as const;
const SUPPLIER_SCOPE = ["pair", "marketplace-only"] as const;

/**
 * Validates the filters a client may request. An unrecognized value is refused
 * rather than ignored, so a typo in `?band=HGH` is visible instead of silently
 * returning every entry.
 *
 * Returns the filters (only the recognized ones) and the echo the response
 * carries back, so the UI can render exactly what was applied.
 */
export function parseFilters(
  params: URLSearchParams,
): { filters: WatchlistFilters; echo: Record<string, string> } {
  const filters: WatchlistFilters = {};
  const echo: Record<string, string> = {};

  const band = params.get("band");
  if (band !== null) {
    if (!(BANDS as readonly string[]).includes(band)) {
      throw new FilterRejectedError("band", band);
    }
    filters.band = band as OpportunityBand;
    echo.band = band;
  }

  const confidenceLevel = params.get("confidenceLevel");
  if (confidenceLevel !== null) {
    if (!(LEVELS as readonly string[]).includes(confidenceLevel)) {
      throw new FilterRejectedError("confidenceLevel", confidenceLevel);
    }
    filters.confidenceLevel = confidenceLevel as ConfidenceLevel;
    echo.confidenceLevel = confidenceLevel;
  }

  const completeness = params.get("completeness");
  if (completeness !== null) {
    if (!(COMPLETENESS as readonly string[]).includes(completeness)) {
      throw new FilterRejectedError("completeness", completeness);
    }
    filters.completeness = completeness as EconomicsCompleteness;
    echo.completeness = completeness;
  }

  const profitability = params.get("profitability");
  if (profitability !== null) {
    if (!(PROFITABILITY as readonly string[]).includes(profitability)) {
      throw new FilterRejectedError("profitability", profitability);
    }
    filters.profitability = profitability as (typeof PROFITABILITY)[number];
    echo.profitability = profitability;
  }

  const supplierScope = params.get("supplierScope");
  if (supplierScope !== null) {
    if (!(SUPPLIER_SCOPE as readonly string[]).includes(supplierScope)) {
      throw new FilterRejectedError("supplierScope", supplierScope);
    }
    filters.supplierScope = supplierScope as (typeof SUPPLIER_SCOPE)[number];
    echo.supplierScope = supplierScope;
  }

  return { filters, echo };
}

/** Raised when a client names a filter value this boundary does not know. */
export class FilterRejectedError extends Error {
  readonly field: string;
  readonly value: string;

  constructor(field: string, value: string) {
    super(`Unsupported ${field} filter value: ${value}`);
    this.name = "FilterRejectedError";
    this.field = field;
    this.value = value;
  }
}

/**
 * The batch ids a client may name: distinct, bounded, and every one a uuid.
 *
 * A repeated id is rejected wholesale rather than silently collapsed: a
 * duplicate in the request is a client bug, and the batch cap is a cost bound
 * that a malformed request must never widen. (`reevaluateBatch` dedupes as
 * defense in depth regardless.)
 */
export function parseBatchEntryIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  if (value.length > WATCHLIST_MAX_RE_EVALUATIONS) {
    return null;
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const id = validEntryId(item);
    if (id === null || seen.has(id)) {
      return null;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}
