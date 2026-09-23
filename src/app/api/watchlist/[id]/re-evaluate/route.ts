import "server-only";

import { NextResponse } from "next/server";

import { createWatchlistService } from "@/lib/watchlist/watchlist-ports";
import {
  parseDestinationOverride,
  readWatchlistBody,
  requireProvidersConfigured,
  resolveWatchlistDestination,
  responseOutcome,
  validEntryId,
  watchlistJsonError,
} from "@/lib/watchlist/watchlist-http";
import { reevaluateEntry } from "@/lib/watchlist/reevaluate";
import {
  outcomeHasVerdict,
  outcomeToHttpStatus,
  type WatchlistReEvaluateSuccessResponse,
} from "@/types/watchlist";

/**
 * Watchlist boundary — re-evaluate one watched opportunity.
 *
 *   POST /api/watchlist/{id}/re-evaluate
 *   POST /api/watchlist/{id}/re-evaluate   { "destinationCountry": "DE" }
 *
 * The only way a watched opportunity gets fresh numbers. It replays the saved
 * search to re-resolve the listing, re-proves the saved supplier candidate
 * (never substituting another), runs economics and the Opportunity Engine, and
 * persists the result as a new observation (docs/ARCHITECTURE.md §16.4).
 *
 * The orchestrator never throws: every failure becomes an explicit outcome and
 * the entry is **never removed** — the last-known data stays on screen alongside
 * the reason. Every figure returned is an observation from `evaluatedAt`, never
 * a claim about the listing's present state.
 *
 * Upstream budget per call (docs/API_INTEGRATIONS.md §3, §4): 1 eBay search,
 * reused as competition evidence, plus ≤6 CJ calls.
 */

// Assessments must always reflect fresh upstream round-trips.
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
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

  // A re-evaluation needs both providers: eBay to re-resolve the listing, CJ to
  // re-prove the candidate. Refused up front, by variable name.
  const providers = requireProvidersConfigured(timestamp);
  if (providers !== null) {
    return providers;
  }

  const { id } = await context.params;
  const entryId = validEntryId(id);
  if (entryId === null) {
    return watchlistJsonError(400, "INVALID_ENTRY_ID", "The entry id must be a uuid.", timestamp);
  }

  const body = await readWatchlistBody(request, timestamp);
  if (body instanceof Response) {
    return body;
  }

  const destination = resolveWatchlistDestination(
    parseDestinationOverride(body.destinationCountry),
  );

  const result = await reevaluateEntry({
    ports: service.ports,
    entryId,
    destination,
    now: timestamp,
  });

  const outcome = responseOutcome(result);
  const response: WatchlistReEvaluateSuccessResponse = {
    status: "ok",
    outcome,
    result,
    ...(outcomeHasVerdict(outcome) && result.assessment !== null
      ? { assessment: result.assessment, comparison: result.comparison }
      : {}),
    timestamp,
  };

  return NextResponse.json(response, {
    status: outcomeToHttpStatus(outcome),
    headers: { "Cache-Control": "no-store" },
  });
}
