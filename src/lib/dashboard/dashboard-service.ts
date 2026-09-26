/**
 * Dashboard service — the server boundary's domain logic (docs/ARCHITECTURE.md
 * §19.2).
 *
 * One job: run the bounded persisted reads, hand the mapped results to the pure
 * assembly, and return the read model. Everything upstream is already owned:
 *
 *   - **No live calls.** A normal Dashboard load calls eBay, CJ and freight zero
 *     times. The service holds no marketplace, supplier or freight port, and the
 *     reads it issues touch only INKORA's own persisted intelligence
 *     (docs/ARCHITECTURE.md §19.1).
 *   - **No new scoring.** The service never re-scores, re-matches or re-prices; it
 *     is a read-and-aggregate surface over the Opportunity Engine's append-only
 *     assessments (§19.1).
 *   - **Bounded by construction.** Every read carries a named server-owned limit;
 *     a client cannot raise any of them (§19.3).
 *   - **Degrades per section.** A failed read becomes an empty list or a zero
 *     count, the assembly labels that section `unavailable`, and the rest of the
 *     page still renders (§19.7).
 */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createPersistenceClient } from "@/lib/persistence/client";
import {
  countActiveWatchlist,
  countAssessments,
  readActiveWatchlist,
  readAssessmentWindow,
  readMarketplaceSnapshotsForProducts,
  readNewestMarketplaceSnapshots,
  readNewestSellerObservations,
} from "./dashboard-repository";
import {
  DASHBOARD_ACTIVITY_LIMIT,
  DASHBOARD_ASSESSMENT_WINDOW,
  DASHBOARD_READ_TIMEOUT_MS,
  DASHBOARD_SNAPSHOT_READ_CAP,
  DASHBOARD_WATCHLIST_READ,
} from "./limits";
import { assembleDashboard } from "./read-model";
import type {
  DashboardFilters,
  DashboardReadResult,
  DashboardSortKey,
} from "./types";

/**
 * Runs one persisted read inside a wall-clock budget, so a request that neither
 * resolves nor rejects can never wedge the whole Dashboard.
 *
 * Persistence is the Dashboard's only external dependency and the Supabase client
 * carries no request timeout of its own, so without this bound a silent network
 * path or PostgREST's own retry loop would leave the read pending forever:
 * `Promise.all` would never settle, the route would never answer, and the page
 * would stay on its reading state with no error and no crash. Here the timeout is
 * the same outcome as any other failed read — the documented fallback (an empty
 * list, a zero count) and the section labelling itself `unavailable`
 * (docs/ARCHITECTURE.md §19.7). Domain semantics are unchanged: nothing is
 * invented and nothing is recomputed, one source simply reports it could not be
 * read.
 *
 * The log line names the source and the duration only — never a header, a token
 * or a payload — so a degraded section stays diagnosable.
 */
async function readBounded<T>(
  source: string,
  read: () => Promise<T>,
  fallback: T,
): Promise<T> {
  return new Promise<T>((resolve) => {
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      console.warn(
        `[dashboard] persisted read "${source}" exceeded ${DASHBOARD_READ_TIMEOUT_MS} ms and degraded to its fallback; the section reports unavailable.`,
      );
      resolve(fallback);
    }, DASHBOARD_READ_TIMEOUT_MS);

    read().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        console.warn(
          `[dashboard] persisted read "${source}" failed after ${
            Date.now() - startedAt
          } ms and degraded to its fallback: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
        resolve(fallback);
      },
    );
  });
}

/**
 * Runs every persisted read the Dashboard needs, in one round trip.
 *
 * These six reads touch five different tables and hold no data dependency between
 * them, so they are issued together rather than as a serial chain. Each read owns
 * its own failure *and its own wall-clock budget*: the repository resolves a
 * failed query to an empty list or a zero count, `readBounded` adds the same
 * fallback for a read that hangs or throws, and this function records the
 * source's name so the activity feed can label itself partial instead of silently
 * shorter (docs/ARCHITECTURE.md §19.7). The batch therefore settles in bounded
 * time even when a read never returns.
 */
async function readDashboardEvidence(
  client: SupabaseClient,
): Promise<{
  window: Awaited<ReturnType<typeof readAssessmentWindow>>;
  assessmentCount: number;
  watchlist: Awaited<ReturnType<typeof readActiveWatchlist>>;
  watchlistCount: number;
  newestSnapshots: Awaited<ReturnType<typeof readNewestMarketplaceSnapshots>>;
  sellerObservations: Awaited<ReturnType<typeof readNewestSellerObservations>>;
  unavailableSources: string[];
}> {
  const [
    window,
    assessmentCount,
    watchlist,
    watchlistCount,
    newestSnapshots,
    sellerObservations,
  ] = await Promise.all([
    readBounded("opportunity-observations", () =>
      readAssessmentWindow(client, DASHBOARD_ASSESSMENT_WINDOW),
    []),
    readBounded("opportunity-observations-count", () => countAssessments(client), 0),
    readBounded("watchlist-entries", () =>
      readActiveWatchlist(client, DASHBOARD_WATCHLIST_READ),
    []),
    readBounded("watchlist-entries-count", () => countActiveWatchlist(client), 0),
    readBounded("marketplace-product-snapshots", () =>
      readNewestMarketplaceSnapshots(client, DASHBOARD_ACTIVITY_LIMIT),
    []),
    readBounded("marketplace-seller-observations", () =>
      readNewestSellerObservations(client, DASHBOARD_ACTIVITY_LIMIT),
    []),
  ]);

  const unavailableSources: string[] = [];
  if (window.length === 0) {
    unavailableSources.push("opportunity-observations");
  }
  if (watchlist.length === 0) {
    unavailableSources.push("watchlist-entries");
  }
  if (newestSnapshots.length === 0) {
    unavailableSources.push("marketplace-product-snapshots");
  }
  if (sellerObservations.length === 0) {
    unavailableSources.push("marketplace-seller-observations");
  }

  return {
    window,
    assessmentCount,
    watchlist,
    watchlistCount,
    newestSnapshots,
    sellerObservations,
    unavailableSources,
  };
}

/**
 * Loads the Dashboard read model from persisted intelligence alone.
 *
 * Returns `disabled` when persistence is not configured — the honest answer when
 * there is nothing to read, rather than an error a caller must treat as a crash.
 * Returns `degraded` when one or more reads produced nothing; those sections
 * report `unavailable` and the rest still render (docs/ARCHITECTURE.md §19.7).
 *
 * Filters, sort and limit are already validated by the route against the fixed
 * vocabularies in `./types` and `./sorting` — this function trusts them and never
 * interpolates a client string into a query (§19.6).
 * `persistence` is optional so the whole read path can be exercised against an
 * injected fake client, exactly as the Product Detail service accepts its own
 * (`src/lib/product-detail/product-detail-service.ts`); absent, it is built from
 * the server's configuration as usual.
 */
export async function loadDashboard(params: {
  filters: DashboardFilters;
  sort: DashboardSortKey;
  limit: number;
  persistence?: SupabaseClient;
}): Promise<DashboardReadResult> {
  const client = params.persistence ?? createPersistenceClient();
  if (client === null) {
    return { status: "disabled" };
  }

  const evidence = await readDashboardEvidence(client);

  // The displayed products' presentation info is the one read that depends on the
  // window's contents, so it runs after the scopes are known and is bounded by the
  // number of products the page can actually show.
  const displayedProductIds = evidence.window
    .slice(0, params.limit)
    .map((entry) => entry.marketplaceProductId);
  const marketInfoRows = await readBounded(
    "marketplace-product-snapshots-for-products",
    () =>
      readMarketplaceSnapshotsForProducts(
        client,
        displayedProductIds,
        DASHBOARD_SNAPSHOT_READ_CAP,
      ),
    [],
  );
  const marketInfo = new Map<string, (typeof marketInfoRows)[number]>();
  for (const row of marketInfoRows) {
    marketInfo.set(row.marketplaceProductId, row);
  }

  const dashboard = assembleDashboard({
    now: new Date().toISOString(),
    window: evidence.window,
    assessmentCount: evidence.assessmentCount,
    watchlist: evidence.watchlist,
    watchlistCount: evidence.watchlistCount,
    newestSnapshots: evidence.newestSnapshots,
    sellerObservations: evidence.sellerObservations,
    marketInfo,
    unavailableSources: evidence.unavailableSources,
    filters: params.filters,
    sort: params.sort,
    limit: params.limit,
  });

  return {
    status: evidence.unavailableSources.length === 0 ? "ok" : "degraded",
    dashboard,
  };
}
