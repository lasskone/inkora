import "server-only";

import { NextResponse } from "next/server";

import {
  createWatchlistService,
  findEntryById,
  readEntryHistory,
} from "@/lib/watchlist/watchlist-ports";
import { validEntryId, watchlistJsonError } from "@/lib/watchlist/watchlist-http";
import { WATCHLIST_HISTORY_LIMIT } from "@/lib/watchlist/limits";
import type { WatchlistHistorySuccessResponse } from "@/types/watchlist";

/**
 * Watchlist boundary — one entry's bounded assessment timeline.
 *
 *   GET /api/watchlist/{id}/history
 *
 * Returns the persisted assessments for the entry's exact scope, newest first,
 * bounded — every one an observation from its own `calculatedAt`. Archived
 * entries keep their history: archiving is a soft removal and never deletes the
 * record of what was observed (docs/DATABASE.md §6.9).
 *
 * History is scoped strictly: a marketplace-only entry never sees a pair
 * assessment of the same listing, because a NULL supplier is a scope, not a
 * wildcard.
 */

// History grows with every re-evaluation.
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const timestamp = new Date().toISOString();

  const service = createWatchlistService();
  if (service === null) {
    return watchlistJsonError(
      503,
      "WATCHLIST_NOT_CONFIGURED",
      "Watchlist storage is not configured on this server, so no history can be read.",
      timestamp,
      "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.",
    );
  }

  const { id } = await context.params;
  const entryId = validEntryId(id);
  if (entryId === null) {
    return watchlistJsonError(400, "INVALID_ENTRY_ID", "The entry id must be a uuid.", timestamp);
  }

  const entry = await findEntryById(service.client, entryId);
  if (entry === null) {
    return watchlistJsonError(
      404,
      "ENTRY_NOT_FOUND",
      "No watchlist entry exists with this id.",
      timestamp,
    );
  }

  const history = await readEntryHistory(service.client, entry, WATCHLIST_HISTORY_LIMIT);

  const response: WatchlistHistorySuccessResponse = {
    status: "ok",
    history,
    limit: WATCHLIST_HISTORY_LIMIT,
    timestamp,
  };

  return NextResponse.json(response, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
