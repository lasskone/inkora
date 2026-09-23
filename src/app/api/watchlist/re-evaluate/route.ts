import "server-only";

import { NextResponse } from "next/server";

import { createWatchlistService } from "@/lib/watchlist/watchlist-ports";
import {
  parseBatchEntryIds,
  parseDestinationOverride,
  readWatchlistBody,
  requireProvidersConfigured,
  resolveWatchlistDestination,
  watchlistJsonError,
} from "@/lib/watchlist/watchlist-http";
import { reevaluateBatch } from "@/lib/watchlist/reevaluate";
import { WATCHLIST_MAX_RE_EVALUATIONS } from "@/lib/watchlist/limits";
import type { WatchlistBatchReEvaluateSuccessResponse } from "@/types/watchlist";

/**
 * Watchlist boundary — bounded batch re-evaluation.
 *
 *   POST /api/watchlist/re-evaluate
 *   POST /api/watchlist/re-evaluate   { "entryIds": ["…", "…"], "destinationCountry": "DE" }
 *
 * Re-evaluates a *named* set of entries. There is deliberately no
 * "re-evaluate all": the batch cap bounds cost and wall-clock and is never
 * raised by a query parameter (docs/ARCHITECTURE.md §16.6).
 *
 * Bounds are applied, not requested: the entry ids are deduped and capped, the
 * whole batch runs under a fixed concurrency and a hard wall-clock deadline, and
 * every entry resolves to its own outcome — one bad listing never costs the
 * others. The response reports the bounds actually used, and `status: "partial"`
 * when the deadline cut the batch short.
 *
 * The worst case this endpoint can issue is ≤6 eBay searches plus ≤36 CJ calls,
 * in ≤3 concurrency waves (docs/API_INTEGRATIONS.md §3, §4).
 */

// Assessments must always reflect fresh upstream round-trips.
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const timestamp = new Date().toISOString();

  const service = createWatchlistService();
  if (service === null) {
    return watchlistJsonError(
      503,
      "WATCHLIST_NOT_CONFIGURED",
      "Watchlist storage is not configured on this server, so nothing can be re-evaluated.",
      timestamp,
      "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.",
    );
  }

  const providers = requireProvidersConfigured(timestamp);
  if (providers !== null) {
    return providers;
  }

  const body = await readWatchlistBody(request, timestamp);
  if (body instanceof Response) {
    return body;
  }

  const entryIds = parseBatchEntryIds(body.entryIds);
  if (entryIds === null) {
    return watchlistJsonError(
      400,
      body.entryIds === undefined ? "ENTRIES_REQUIRED" : "TOO_MANY_ENTRIES",
      body.entryIds === undefined
        ? "Name the entries to re-evaluate."
        : `A batch re-evaluation accepts at most ${WATCHLIST_MAX_RE_EVALUATIONS} entries.`,
      timestamp,
    );
  }

  const destination = resolveWatchlistDestination(
    parseDestinationOverride(body.destinationCountry),
  );

  const batch = await reevaluateBatch({
    ports: service.ports,
    entryIds,
    destination,
    now: timestamp,
  });

  const response: WatchlistBatchReEvaluateSuccessResponse = {
    status: "ok",
    batch,
    timestamp,
  };

  return NextResponse.json(response, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
