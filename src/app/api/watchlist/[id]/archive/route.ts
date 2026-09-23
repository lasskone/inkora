import "server-only";

import { NextResponse } from "next/server";

import { archiveEntry, createWatchlistService, findEntryById } from "@/lib/watchlist/watchlist-ports";
import { validEntryId, watchlistJsonError } from "@/lib/watchlist/watchlist-http";
import type { WatchlistArchiveSuccessResponse } from "@/types/watchlist";

/**
 * Watchlist boundary — archive one entry.
 *
 *   POST /api/watchlist/{id}/archive
 *
 * Archiving is the watchlist's only removal path, and it is soft: the row stays
 * so the monitoring-intent history stays auditable, and its assessments are
 * retained (docs/DATABASE.md §6.9, docs/ARCHITECTURE.md §16.5). An archived entry
 * frees its slot against the entry cap and stops appearing in the list.
 *
 * Idempotent: archiving an already-archived entry is `already-archived`, not an
 * error.
 */

// Archiving changes what the list shows.
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
      "Watchlist storage is not configured on this server, so nothing can be archived.",
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

  // Already archived is a success, not a conflict: the requested state holds.
  if (entry.archivedAt !== null) {
    const response: WatchlistArchiveSuccessResponse = {
      status: "ok",
      action: "already-archived",
      entryId: entry.id,
      timestamp,
    };
    return NextResponse.json(response, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }

  // The read above and this write race in principle; the repository's own
  // discriminant is authoritative, so a concurrent archive is still a success.
  const outcome = await archiveEntry(service.client, entry.id);

  switch (outcome) {
    case "archived":
    case "already-archived": {
      const response: WatchlistArchiveSuccessResponse = {
        status: "ok",
        action: outcome,
        entryId: entry.id,
        timestamp,
      };
      return NextResponse.json(response, {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      });
    }

    case "not-found":
      return watchlistJsonError(
        404,
        "ENTRY_NOT_FOUND",
        "No watchlist entry exists with this id.",
        timestamp,
      );

    case "failed":
      console.error("[watchlist] archiveEntry failed:", entry.id);
      return watchlistJsonError(
        500,
        "PERSISTENCE_FAILED",
        "The entry could not be archived. Please try again.",
        timestamp,
      );
  }
}
