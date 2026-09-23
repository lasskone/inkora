import "server-only";

import { NextResponse } from "next/server";

import {
  buildEntryDetail,
  createWatchlistService,
  addEntry,
  countActiveEntries,
  findActiveEntryIdByScope,
  findEntryById,
  listEntries,
} from "@/lib/watchlist/watchlist-ports";
import {
  FilterRejectedError,
  parseAddInput,
  parseFilters,
  parseSortKey,
  readWatchlistBody,
  watchlistJsonError,
} from "@/lib/watchlist/watchlist-http";
import { WATCHLIST_MAX_ENTRIES, clampWatchlistLimit } from "@/lib/watchlist/limits";
import { filterEntries, sortEntries } from "@/lib/watchlist/sorting";
import type {
  WatchlistAddSuccessResponse,
  WatchlistListSuccessResponse,
} from "@/types/watchlist";

/**
 * Watchlist boundary — list.
 *
 *   GET /api/watchlist            list the active watchlist (sorted, filtered, bounded)
 *
 * The watchlist is a monitoring layer: every figure the list returns is a stored
 * observation from a point in time, never a live claim about a listing's present
 * price or stock (docs/ARCHITECTURE.md §16).
 *
 * Responses carry `Cache-Control: no-store`: a watchlist changes with every save
 * and re-evaluation, so no intermediate may cache it.
 */

// The watchlist is user-specific and changes on every write.
export const dynamic = "force-dynamic";

/**
 * Lists the active watchlist.
 *
 * Query parameters, all optional:
 *
 *   limit             1–50 (default 20)
 *   sort              recently-evaluated | score | profit | margin | confidence | added
 *   band              LOW | MEDIUM | HIGH
 *   confidenceLevel   LOW | MEDIUM | HIGH
 *   completeness      COMPLETE | PARTIAL | UNAVAILABLE
 *   profitability     profitable | unprofitable
 *   supplierScope     pair | marketplace-only
 *
 * Entries are read active-only, then sorted and filtered over the already-loaded
 * detail. That keeps sorting honest about missing values (an entry with no
 * assessment never counts as score zero, docs/ARCHITECTURE.md §16.9) and keeps
 * the SQL simple; the read is bounded by the cap either way.
 */
export async function GET(request: Request): Promise<Response> {
  const timestamp = new Date().toISOString();

  const service = createWatchlistService();
  if (service === null) {
    return watchlistJsonError(
      503,
      "WATCHLIST_NOT_CONFIGURED",
      "Watchlist storage is not configured on this server, so no watchlist can be read.",
      timestamp,
      "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.",
    );
  }

  const params = new URL(request.url).searchParams;

  const limit = clampWatchlistLimit(
    params.has("limit") ? Number(params.get("limit")) : undefined,
  );

  const sortKey = parseSortKey(params.get("sort")) ?? "recently-evaluated";

  let parsedFilters;
  try {
    parsedFilters = parseFilters(params);
  } catch (error) {
    if (error instanceof FilterRejectedError) {
      return watchlistJsonError(
        400,
        "INVALID_FILTER",
        `The "${error.field}" filter does not accept "${error.value}".`,
        timestamp,
      );
    }
    throw error;
  }

  const entries = await listEntries(service.client, { limit });
  const details = await Promise.all(
    entries.map((entry) => buildEntryDetail(service.client, entry)),
  );

  const visible = sortEntries(filterEntries(details, parsedFilters.filters), sortKey);

  const response: WatchlistListSuccessResponse = {
    status: "ok",
    entries: visible,
    limit,
    sort: sortKey,
    filters: parsedFilters.echo,
    total: visible.length,
    timestamp,
  };

  return NextResponse.json(response, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}


// --------------------------------------------------------------- POST --------

/**
 * Saves an opportunity to the watchlist.
 *
 * ```json
 * { "marketplaceExternalId": "v1|123456789|0", "replayQuery": "wireless earbuds" }
 * { "marketplaceExternalId": "…", "supplierExternalId": "CJ-abc123", "replayQuery": "…", "label": "black" }
 * ```
 *
 * Idempotent: saving the same active scope twice returns the existing entry with
 * `action: "reused"`, never a duplicate. An omitted or null supplier is a
 * *distinct* marketplace-only scope, not a wildcard (docs/DATABASE.md §6.9).
 *
 * Adding records *intent to monitor* only — it stores no price and no score, and
 * never calls eBay or CJ. The entry cap is enforced before the write; an
 * archived entry frees its slot, so archiving is how room is made.
 */
export async function POST(request: Request): Promise<Response> {
  const timestamp = new Date().toISOString();

  const service = createWatchlistService();
  if (service === null) {
    return watchlistJsonError(
      503,
      "WATCHLIST_NOT_CONFIGURED",
      "Watchlist storage is not configured on this server, so nothing can be saved.",
      timestamp,
      "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.",
    );
  }

  const body = await readWatchlistBody(request, timestamp);
  if (body instanceof Response) {
    return body;
  }

  const input = parseAddInput(body);
  if (input === null) {
    return watchlistJsonError(
      400,
      "INVALID_ITEM_ID",
      "A save needs a marketplace item id and the search query that surfaced it.",
      timestamp,
    );
  }

  // The cap is checked before the write so a full watchlist never duplicates an
  // entry it then has to reject. A reuse adds nothing and always succeeds.
  if ((await countActiveEntries(service.client)) >= WATCHLIST_MAX_ENTRIES) {
    const existingId = await findActiveEntryIdByScope(service.client, input);
    if (existingId !== null) {
      return addResponse("reused", existingId, service.client, timestamp);
    }
    return watchlistJsonError(
      409,
      "WATCHLIST_FULL",
      `The watchlist already holds ${WATCHLIST_MAX_ENTRIES} active entries. Archive one to add another.`,
      timestamp,
    );
  }

  const result = await addEntry(service.client, input);

  switch (result.status) {
    case "inserted":
      return addResponse("inserted", result.row.id, service.client, timestamp);

    case "reused":
      return addResponse("reused", result.row.id, service.client, timestamp);

    case "not-observed":
      return watchlistJsonError(
        404,
        "NOT_OBSERVED",
        result.which === "marketplace"
          ? "This listing has never been assessed, so there is nothing to watch yet."
          : "This supplier product has never been assessed, so there is nothing to watch yet.",
        timestamp,
      );

    case "failed":
      console.error("[watchlist] addEntry failed:", result.code);
      return watchlistJsonError(
        500,
        "PERSISTENCE_FAILED",
        "The watchlist entry could not be saved. Please try again.",
        timestamp,
      );
  }
}

/** Builds the success body for an add, re-reading the entry with its detail. */
async function addResponse(
  action: "inserted" | "reused",
  entryId: string,
  client: import("@supabase/supabase-js").SupabaseClient,
  timestamp: string,
): Promise<Response> {
  const entry = await findEntryById(client, entryId);
  if (entry === null) {
    // The row existed a moment ago; this is a transient read failure, not a
    // missing entry, so the client is told to reload rather than re-save.
    console.error("[watchlist] could not re-read entry after save:", entryId);
    return watchlistJsonError(
      500,
      "PERSISTENCE_FAILED",
      "The entry was saved but could not be read back. Please reload the watchlist.",
      timestamp,
    );
  }

  const detail = await buildEntryDetail(client, entry);
  const response: WatchlistAddSuccessResponse = {
    status: "ok",
    action,
    entry: detail,
    timestamp,
  };
  return NextResponse.json(response, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
