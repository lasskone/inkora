/**
 * Shared HTTP-boundary validation for the Dashboard route
 * (docs/ARCHITECTURE.md §19.6).
 *
 * The Dashboard accepts exactly three kinds of input — a sort key, a page size,
 * and a set of filters — and every one of them is a value from a fixed
 * vocabulary compared for equality inside the service. No client string is ever
 * interpolated into a query, and no filter is a column name: the worst input a
 * crafted request can carry is a value the boundary rejects with a `400`.
 *
 * Uses the platform `Response` rather than `NextResponse` for the same reason as
 * the watchlist boundary (`src/lib/watchlist/watchlist-http.ts`): it keeps this
 * module unit-testable under Node's own runner, with no database, no network and
 * no bundler.
 */

import type {
  ConfidenceLevel,
  EconomicsCompleteness,
  OpportunityBand,
} from "@/lib/opportunity/types";
import type { ConfidenceBand } from "@/lib/matcher/types";

import { clampDashboardLimit } from "./limits";
import { DASHBOARD_SORT_KEYS } from "./sorting";
import type {
  DashboardFilters,
  DashboardSortKey,
  ProfitabilityFilter,
  SupplierScopeFilter,
  WatchStateFilter,
} from "./types";
import type {
  DashboardErrorCode,
  DashboardErrorResponse,
} from "@/types/dashboard";

/** The vocabulary each filter accepts, so the UI and the boundary agree. */
export const BAND_VALUES = ["LOW", "MEDIUM", "HIGH"] as const;
export const ECONOMICS_VALUES = ["COMPLETE", "PARTIAL", "UNAVAILABLE"] as const;
export const PROFITABILITY_VALUES = ["profitable", "losing", "unknown"] as const;
export const SUPPLIER_SCOPE_VALUES = ["pair", "marketplace-only"] as const;
export const WATCH_STATE_VALUES = ["watched", "unwatched"] as const;

/**
 * Thrown when a filter names a value outside its vocabulary. The route turns it
 * into a `400` that names the field and the value, so a bad deep link is visible
 * rather than silently widening the result set.
 */
export class FilterRejectedError extends Error {
  readonly field: string;
  readonly value: string;

  constructor(field: string, value: string) {
    super(`The "${field}" filter does not accept "${value}".`);
    this.name = "FilterRejectedError";
    this.field = field;
    this.value = value;
  }
}

/**
 * Builds the boundary's error body. `detail` names an environment variable only
 * — never a value, never a token.
 */
export function dashboardJsonError(
  status: number,
  code: DashboardErrorCode,
  message: string,
  timestamp: string,
  detail?: string,
): Response {
  const body: DashboardErrorResponse = {
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

/** Reads one required-vocabulary string, or returns `null` when it is unusable. */
function readVocabulary(
  params: URLSearchParams,
  name: string,
  allowed: readonly string[],
): string | null {
  const raw = params.get(name);
  if (raw === null) {
    return null;
  }
  const value = raw.trim();
  return allowed.includes(value) ? value : null;
}

/**
 * Parses the sort key. An absent or empty key means "use the default" — but a
 * *present and unrecognized* key is an error, because a deep link that silently
 * re-sorts is worse than one that reports itself.
 */
export function parseDashboardSortKey(value: string | null): DashboardSortKey | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return (DASHBOARD_SORT_KEYS as readonly string[]).includes(trimmed)
    ? (trimmed as DashboardSortKey)
    : null;
}
/**
 * Parses every filter the boundary accepts. A filter that names a value outside
 * its vocabulary throws `FilterRejectedError`; an absent filter is simply not
 * applied, and is never defaulted to a value that would narrow the page.
 *
 * Each value is compared for equality against the vocabulary after parsing, so
 * a value carrying extra characters never reaches a query — and no filter is
 * ever a column or table name (docs/ARCHITECTURE.md §19.6).
 */
export function parseDashboardFilters(params: URLSearchParams): DashboardFilters {
  const filters: DashboardFilters = {};

  const band = readVocabulary(params, "band", BAND_VALUES);
  if (params.has("band")) {
    if (band === null) {
      throw new FilterRejectedError("band", params.get("band") as string);
    }
    filters.band = band as OpportunityBand;
  }

  const evidence = readVocabulary(params, "evidence", BAND_VALUES);
  if (params.has("evidence")) {
    if (evidence === null) {
      throw new FilterRejectedError("evidence", params.get("evidence") as string);
    }
    filters.evidence = evidence as ConfidenceLevel;
  }

  const match = readVocabulary(params, "match", BAND_VALUES);
  if (params.has("match")) {
    if (match === null) {
      throw new FilterRejectedError("match", params.get("match") as string);
    }
    filters.match = match as ConfidenceBand;
  }

  const economics = readVocabulary(params, "economics", ECONOMICS_VALUES);
  if (params.has("economics")) {
    if (economics === null) {
      throw new FilterRejectedError("economics", params.get("economics") as string);
    }
    filters.economics = economics as EconomicsCompleteness;
  }

  const profitability = readVocabulary(params, "profitability", PROFITABILITY_VALUES);
  if (params.has("profitability")) {
    if (profitability === null) {
      throw new FilterRejectedError(
        "profitability",
        params.get("profitability") as string,
      );
    }
    filters.profitability = profitability as ProfitabilityFilter;
  }

  const supplierScope = readVocabulary(params, "supplierScope", SUPPLIER_SCOPE_VALUES);
  if (params.has("supplierScope")) {
    if (supplierScope === null) {
      throw new FilterRejectedError(
        "supplierScope",
        params.get("supplierScope") as string,
      );
    }
    filters.supplierScope = supplierScope as SupplierScopeFilter;
  }

  const watchState = readVocabulary(params, "watchState", WATCH_STATE_VALUES);
  if (params.has("watchState")) {
    if (watchState === null) {
      throw new FilterRejectedError("watchState", params.get("watchState") as string);
    }
    filters.watchState = watchState as WatchStateFilter;
  }

  return filters;
}

/**
 * One entry point for the whole query string: returns the validated controls, or
 * an already-built error `Response` the route returns verbatim.
 *
 * `limit` is clamped rather than rejected — a page size is a hint, and the
 * ceiling is enforced server-side whatever was asked (docs/ARCHITECTURE.md
 * §19.3). Sort and filters are vocabulary-checked and rejected when unusable.
 */
export function readDashboardQuery(params: URLSearchParams): {
  filters: DashboardFilters;
  sort: DashboardSortKey;
  limit: number;
} | Response {
  let filters: DashboardFilters;
  try {
    filters = parseDashboardFilters(params);
  } catch (error) {
    if (error instanceof FilterRejectedError) {
      return dashboardJsonError(
        400,
        "INVALID_FILTER",
        `The "${error.field}" filter does not accept "${error.value}".`,
        new Date().toISOString(),
        acceptedValues(error.field),
      );
    }
    throw error;
  }

  const sort = parseDashboardSortKey(params.get("sort"));
  if (params.has("sort") && sort === null) {
    return dashboardJsonError(
      400,
      "INVALID_SORT",
      `The "sort" control does not accept "${params.get("sort")}".`,
      new Date().toISOString(),
      `Accepted values: ${DASHBOARD_SORT_KEYS.join(", ")}.`,
    );
  }

  return {
    filters,
    sort: sort ?? "score",
    limit: clampDashboardLimit(
      params.has("limit") ? Number(params.get("limit")) : undefined,
    ),
  };
}

/** The vocabulary one rejected filter accepts, so the error is self-documenting. */
function acceptedValues(field: string): string {
  switch (field) {
    case "band":
    case "evidence":
    case "match":
      return `Accepted values: ${BAND_VALUES.join(", ")}.`;
    case "economics":
      return `Accepted values: ${ECONOMICS_VALUES.join(", ")}.`;
    case "profitability":
      return `Accepted values: ${PROFITABILITY_VALUES.join(", ")}.`;
    case "supplierScope":
      return `Accepted values: ${SUPPLIER_SCOPE_VALUES.join(", ")}.`;
    case "watchState":
      return `Accepted values: ${WATCH_STATE_VALUES.join(", ")}.`;
    default:
      return "";
  }
}

