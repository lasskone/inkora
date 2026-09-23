/**
 * Server-side assembly of the watchlist's injected ports and its repository
 * facade (docs/ARCHITECTURE.md §16.2).
 *
 * This is the one place where the watchlist's ports meet concrete adapters, for
 * the same reasons the scanner assembles its own (`docs/ARCHITECTURE.md §15.2`):
 * the orchestrator stays unit-testable with fakes and no network, and the
 * upstream budget of one re-evaluation stays visible in one place.
 *
 * Every capability here already belongs to an existing, independently tested
 * service. The watchlist owns none of them — it connects a user's intent to
 * monitor to the same trusted pipeline a single assessment uses.
 */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { CjAdapter } from "@/lib/cj/cj-adapter";
import { EbayAdapter } from "@/lib/ebay/ebay-adapter";
import { computeCandidateEconomics } from "@/lib/economics/economics-service";
import { ProductMatcher } from "@/lib/matcher/matcher";
import { persistEvaluation, type PersistedRecords } from "@/lib/persistence/persistence-service";
import {
  persistOpportunityAssessment,
  readOpportunityEvidence,
} from "@/lib/persistence/opportunity-persistence";
import { createPersistenceClient } from "@/lib/persistence/client";
import type { MarketplaceProduct, MarketplaceSearchRequest, MarketplaceSearchResult } from "@/lib/marketplace/types";
import type { MatchCandidate, MatchResult } from "@/lib/matcher/types";
import type { EconomicsResult } from "@/lib/economics/types";
import type { SupplierVariant } from "@/lib/supplier/types";
import type {
  HistoryEvidenceSummary,
  OpportunityAssessment,
  OpportunityLimits,
} from "@/lib/opportunity/types";
import type { EconomicsOutcome, ScanDestination } from "@/lib/scanner/types";
import type { OpportunityPersistenceReport } from "@/types/opportunity";

import {
  addEntry,
  archiveEntry,
  assessmentRowToInfo,
  countActiveEntries,
  countAssessments,
  findActiveEntryIdByScope,
  findEntryById,
  listEntries,
  readAssessmentHistory,
  readLatestAssessment,
  readLatestMarketplaceSnapshot,
  readLatestSupplierSnapshot,
  readPreviousObservation,
} from "./watchlist-repository";
import { WATCHLIST_HISTORY_LIMITS, WATCHLIST_MATCH_MAX_RESULTS } from "./limits";
import type {
  PreviousObservation,
  WatchlistEntry,
  WatchlistEntryDetail,
  WatchlistEntrySnapshot,
  WatchlistHistoryEntry,
  WatchlistPorts,
} from "./types";

/**
 * The whole watchlist service, or `null` when persistence is not configured.
 *
 * Every watchlist state lives in Supabase, so there is no degraded mode here:
 * without a client the boundary reports `WATCHLIST_NOT_CONFIGURED` rather than
 * pretending it saved something it did not (docs/ARCHITECTURE.md §13).
 */
export interface WatchlistService {
  ports: WatchlistPorts;
  client: SupabaseClient;
}

/** Assembles the watchlist service, or `null` when persistence is off. */
export function createWatchlistService(): WatchlistService | null {
  const client = createPersistenceClient();
  if (client === null) {
    return null;
  }

  const ports: WatchlistPorts = {
    readEntry: async (id: string): Promise<WatchlistEntrySnapshot | null> => {
      const entry = await findEntryById(client, id);
      if (entry === null) {
        return null;
      }
      return {
        id: entry.id,
        marketplaceExternalId: entry.marketplaceExternalId,
        supplierExternalId: entry.supplierExternalId,
        replayQuery: entry.replayQuery,
        archivedAt: entry.archivedAt,
      };
    },

    readPreviousObservation: (scope) => readPreviousObservation(client, scope),

    searchMarketplace: (
      request: MarketplaceSearchRequest,
    ): Promise<MarketplaceSearchResult> => new EbayAdapter().search(request),

    matchCandidates: (product: MarketplaceProduct): Promise<MatchResult> =>
      new ProductMatcher(new CjAdapter(), {
        maxResults: WATCHLIST_MATCH_MAX_RESULTS,
      }).findCandidates(product),

    computeEconomics: (request: {
      candidate: MatchCandidate;
      destination: ScanDestination;
    }): Promise<EconomicsOutcome> =>
      computeCandidateEconomics({
        candidate: request.candidate,
        destination: request.destination,
      }),

    readEvidence: (params: {
      marketplace: MarketplaceProduct["marketplace"];
      marketplaceExternalId: string;
      supplierExternalId: string | null;
      limits: OpportunityLimits;
    }): Promise<HistoryEvidenceSummary | null> =>
      readOpportunityEvidence({ ...params, limits: WATCHLIST_HISTORY_LIMITS }),

    persistEvaluation: async (params: {
      marketplaceProduct: MarketplaceProduct;
      candidate: MatchCandidate;
      economics: EconomicsResult;
      selectedVariant: SupplierVariant | null;
    }): Promise<PersistedRecords | null> => {
      const result = await persistEvaluation({
        marketplaceProduct: params.marketplaceProduct,
        supplierProduct: params.candidate.supplierProduct,
        candidate: params.candidate,
        selectedVariant: params.selectedVariant,
        economics: params.economics,
      });
      return result.status === "ok" ? result.records : null;
    },

    persistAssessment: async (params: {
      assessment: OpportunityAssessment;
      marketplaceProduct: MarketplaceProduct;
      evaluation: PersistedRecords | null;
    }): Promise<OpportunityPersistenceReport | undefined> => {
      const result = await persistOpportunityAssessment(params);
      switch (result.status) {
        case "ok":
          return { status: "ok", inserted: result.inserted };
        case "disabled":
          return { status: "disabled" };
        case "failed":
          return { status: "failed", message: result.message };
      }
    },
  };

  return { ports, client };
}

export {
  addEntry,
  archiveEntry,
  countActiveEntries,
  countAssessments,
  findActiveEntryIdByScope,
  findEntryById,
  listEntries,
  readAssessmentHistory,
};


/**
 * Builds one watchlist card's detail: the entry plus every last-known
 * observation its scope has. Each read is independent and degrades to `null`,
 * so one missing snapshot never hides the assessment beside it
 * (docs/ARCHITECTURE.md §16.8).
 */
export async function buildEntryDetail(
  client: SupabaseClient,
  entry: WatchlistEntry,
): Promise<WatchlistEntryDetail> {
  const scope = {
    marketplaceExternalId: entry.marketplaceExternalId,
    supplierExternalId: entry.supplierExternalId,
  };

  const [marketplace, supplier, latest, count] = await Promise.all([
    readLatestMarketplaceSnapshot(client, entry.marketplaceExternalId),
    entry.supplierExternalId === null
      ? Promise.resolve(null)
      : readLatestSupplierSnapshot(client, entry.supplierExternalId),
    readLatestAssessment(client, scope),
    countAssessments(client, scope),
  ]);

  return {
    entry,
    marketplace,
    supplier,
    assessment: latest === null ? null : assessmentRowToInfo(latest),
    assessmentCount: count,
  };
}

/** Bounded assessment timeline for one entry, newest first. */
export function readEntryHistory(
  client: SupabaseClient,
  entry: WatchlistEntry,
  limit: number,
): Promise<WatchlistHistoryEntry[]> {
  return readAssessmentHistory(
    client,
    {
      marketplaceExternalId: entry.marketplaceExternalId,
      supplierExternalId: entry.supplierExternalId,
    },
    limit,
  );
}

/** The previous observation for an entry's scope, read before any upstream call. */
export function readEntryPreviousObservation(
  client: SupabaseClient,
  entry: WatchlistEntry,
): Promise<PreviousObservation | null> {
  return readPreviousObservation(client, {
    marketplaceExternalId: entry.marketplaceExternalId,
    supplierExternalId: entry.supplierExternalId,
  });
}
