import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { MatchCandidate } from "@/lib/matcher/types";
import { hashMatchObservation } from "./content-hash";
import { findLatestObservation } from "./dedup";
import { PersistenceError } from "./identities";
import type {
  MatchObservationRow,
  ObservationWriteResult,
} from "./types";

/**
 * Appends a match observation: what one matcher version concluded about one
 * marketplace × supplier pair, including the full reasoning.
 *
 * This is NOT a permanent statement that the two products are identical — it is
 * a historical record attributable to `matcherVersion`, so a future matcher can
 * never retroactively rewrite what an old observation meant
 * (docs/DATABASE.md §6.6). Deduplication reuses the latest observation when the
 * version, confidence and reasoning are unchanged.
 */
export async function appendMatchObservation(
  client: SupabaseClient,
  params: {
    marketplaceProductId: string;
    marketplaceSnapshotId: string;
    supplierProductId: string;
    supplierSnapshotId: string;
    supplierVariantId: string | null;
    candidate: MatchCandidate;
    matcherVersion: string;
  },
): Promise<ObservationWriteResult<MatchObservationRow>> {
  const contentHash = hashMatchObservation({
    matcherVersion: params.matcherVersion,
    confidence: params.candidate.confidence,
    confidenceBand: params.candidate.confidenceBand,
    signals: params.candidate.signals,
    contradictions: params.candidate.contradictions,
  });

  const existing = await findLatestObservation<MatchObservationRow>(
    client,
    "match_observations",
    {
      productColumn: "marketplace_product_id",
      productId: params.marketplaceProductId,
      supplierProductId: params.supplierProductId,
    },
  );

  if (existing !== null && existing.content_hash === contentHash) {
    return { row: existing, inserted: false };
  }

  const { data, error } = await client
    .from("match_observations")
    .insert({
      marketplace_product_id: params.marketplaceProductId,
      marketplace_snapshot_id: params.marketplaceSnapshotId,
      supplier_product_id: params.supplierProductId,
      supplier_snapshot_id: params.supplierSnapshotId,
      supplier_variant_id: params.supplierVariantId,
      matcher_version: params.matcherVersion,
      confidence: params.candidate.confidence,
      confidence_band: params.candidate.confidenceBand,
      signals: params.candidate.signals,
      contradictions: params.candidate.contradictions,
      explanation: params.candidate.explanation,
      content_hash: contentHash,
      calculated_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error !== null || data === null) {
    throw new PersistenceError(
      `match_observations insert failed: ${error?.message ?? "no row returned"}`,
    );
  }

  return { row: data as MatchObservationRow, inserted: true };
}
