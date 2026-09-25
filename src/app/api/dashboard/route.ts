import "server-only";

import { NextResponse } from "next/server";

import {
  DASHBOARD_ACTIVITY_LIMIT,
  DASHBOARD_ASSESSMENT_WINDOW,
  DASHBOARD_ATTENTION_LIMIT,
  DASHBOARD_CHANGES_LIMIT,
  DASHBOARD_DEFAULT_LIMIT,
  DASHBOARD_MAX_LIMIT,
  DASHBOARD_SNAPSHOT_READ_CAP,
  DASHBOARD_WATCHLIST_PREVIEW,
  DASHBOARD_WATCHLIST_READ,
} from "@/lib/dashboard/limits";
import {
  dashboardJsonError,
  readDashboardQuery,
} from "@/lib/dashboard/dashboard-http";
import { loadDashboard } from "@/lib/dashboard/dashboard-service";
import type { DashboardSuccessResponse } from "@/types/dashboard";

/**
 * Dashboard boundary — the read-only aggregation surface
 * (docs/ARCHITECTURE.md §19).
 *
 *   GET /api/dashboard   the whole Dashboard read model, one round trip
 *
 * Everything the response reports is intelligence INKORA already persisted: the
 * Opportunity Engine's append-only assessments, the watchlist's monitoring
 * intent, and the marketplace and seller observation layers. This route performs
 * **no eBay call, no CJ call, no freight call and no scoring call** — no upstream
 * port is wired into the read path at all, so a normal load costs zero upstream
 * budget (docs/ARCHITECTURE.md §19.1).
 *
 * `Cache-Control: no-store` and `force-dynamic`: the page summarizes history that
 * grows with every scan, so no intermediate may cache it and present a stale
 * assessment as a live one.
 */

// The Dashboard summarizes tables that change on every scan and re-evaluation.
export const dynamic = "force-dynamic";

/**
 * Loads the Dashboard.
 *
 * Query parameters, all optional:
 *
 *   limit           1–50 (default 12); clamped, never rejected
 *   sort            score | confidence | profit | margin | match | recently-evaluated
 *   band            LOW | MEDIUM | HIGH
 *   evidence        LOW | MEDIUM | HIGH
 *   match           LOW | MEDIUM | HIGH
 *   economics       COMPLETE | PARTIAL | UNAVAILABLE
 *   profitability   profitable | losing | unknown
 *   supplierScope   pair | marketplace-only
 *   watchState      watched | unwatched
 *
 * A value outside a vocabulary is answered with `400` naming the field and the
 * value; it is never silently coerced, because a deep link that quietly widens a
 * filter is worse than one that reports itself. `limit` is the exception — it is
 * a hint, clamped to the server-owned ceiling whatever was asked.
 *
 * The route answers `200` for both `ok` and `degraded`: a Dashboard whose
 * watchlist read failed is still the best available answer, and the failed
 * section says so about itself rather than failing the request (§19.7).
 */
export async function GET(request: Request): Promise<Response> {
  const timestamp = new Date().toISOString();

  const parsed = readDashboardQuery(new URL(request.url).searchParams);
  if (parsed instanceof Response) {
    return parsed;
  }

  const result = await loadDashboard({
    filters: parsed.filters,
    sort: parsed.sort,
    limit: parsed.limit,
  });

  if (result.status === "disabled") {
    return dashboardJsonError(
      503,
      "DASHBOARD_NOT_CONFIGURED",
      "Persistence is not configured on this server, so no intelligence can be summarized.",
      timestamp,
      "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.",
    );
  }

  const response: DashboardSuccessResponse = {
    status: result.status,
    dashboard: result.dashboard,
    bounds: {
      limit: parsed.limit,
      sort: parsed.sort,
      filters: parsed.filters,
      assessmentWindow: DASHBOARD_ASSESSMENT_WINDOW,
      attentionLimit: DASHBOARD_ATTENTION_LIMIT,
      changesLimit: DASHBOARD_CHANGES_LIMIT,
      activityLimit: DASHBOARD_ACTIVITY_LIMIT,
      watchlistRead: DASHBOARD_WATCHLIST_READ,
      watchlistPreview: DASHBOARD_WATCHLIST_PREVIEW,
      snapshotReadCap: DASHBOARD_SNAPSHOT_READ_CAP,
      defaultLimit: DASHBOARD_DEFAULT_LIMIT,
      maxLimit: DASHBOARD_MAX_LIMIT,
    },
    timestamp,
  };

  return NextResponse.json(response, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
