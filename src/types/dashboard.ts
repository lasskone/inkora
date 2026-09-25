/**
 * The Dashboard API's public contract (`GET /api/dashboard`,
 * docs/ARCHITECTURE.md §19.2).
 *
 * Mirrors `src/lib/dashboard/types.ts` on purpose: the domain read model *is* the
 * response body, so the boundary adds no second shape to keep in sync and no
 * re-mapping layer that could quietly drop a field. These types are the ones the
 * browser imports, so they carry no `server-only` import and no persistence
 * shape.
 */

import type {
  DashboardData,
  DashboardFilters,
  DashboardSortKey,
} from "@/lib/dashboard/types";

/**
 * Machine-readable error codes for the boundary. The message names the *field*
 * and the *value* a client sent that the boundary could not accept; `detail`
 * names an environment variable only, never a value (docs/ARCHITECTURE.md §19.6).
 */
export type DashboardErrorCode =
  | "INVALID_FILTER"
  | "INVALID_SORT"
  | "DASHBOARD_NOT_CONFIGURED";

export interface DashboardErrorResponse {
  status: "error";
  error: string;
  code: DashboardErrorCode;
  timestamp: string;
  detail?: string;
}

/**
 * The server-owned bounds actually applied to one response, echoed back so a
 * client can never believe an unapplied control (docs/ARCHITECTURE.md §19.3).
 *
 * Every value here is a constant the server holds; none of them comes from the
 * request. `limit` is the clamped page size and `sort` the applied key, so a
 * request for `limit=5000` or an unknown sort is answered with what was used
 * instead, never with what was asked for.
 */
export interface DashboardBounds {
  /** The applied page size, already clamped to `maxLimit`. */
  limit: number;
  sort: DashboardSortKey;
  /** The filters actually applied — absent keys mean "no filter". */
  filters: DashboardFilters;
  assessmentWindow: number;
  attentionLimit: number;
  changesLimit: number;
  activityLimit: number;
  watchlistRead: number;
  watchlistPreview: number;
  snapshotReadCap: number;
  defaultLimit: number;
  maxLimit: number;
}

/**
 * `ok` — every read succeeded. `degraded` — one or more section reads produced
 * nothing, so those sections report `unavailable` and the rest still render. The
 * HTTP status is `200` in both cases: a partially-read Dashboard is still the
 * best available answer, not a server error (docs/ARCHITECTURE.md §19.7).
 */
export interface DashboardSuccessResponse {
  status: "ok" | "degraded";
  dashboard: DashboardData;
  bounds: DashboardBounds;
  timestamp: string;
}
