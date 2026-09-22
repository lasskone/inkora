import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { OpportunityAssessment } from "@/lib/opportunity/types";
import { hashOpportunityObservation } from "./content-hash";
import { findLatestObservation } from "./dedup";
import { PersistenceError } from "./identities";
import type {
  ObservationWriteResult,
  OpportunityObservationRow,
} from "./types";

/**
 * Appends an Opportunity Engine assessment as a historical observation
 * (docs/DATABASE.md §6.8).
 *
 * This is NOT a permanent verdict and NOT a prediction. It is "Opportunity
 * Engine <version>, given the evidence available at <calculated_at>, assessed
 * this opportunity thus". A later assessment appends a new row; it never
 * rewrites this one, so an old score stays attributable to the exact logic and
 * evidence that produced it.
 *
 * `supplier_product_id` may be `null` — an assessment with no matcher candidate
 * is a legitimate, fully explainable verdict and must still be recorded.
 */
export async function appendOpportunityObservation(
  client: SupabaseClient,
  params: {
    marketplaceProductId: string;
    marketplaceSnapshotId: string | null;
    supplierProductId: string | null;
    supplierSnapshotId: string | null;
    supplierVariantId: string | null;
    matchObservationId: string | null;
    economicsObservationId: string | null;
    assessment: OpportunityAssessment;
  },
): Promise<ObservationWriteResult<OpportunityObservationRow>> {
  const assessment = params.assessment;
  const contentHash = hashOpportunityObservation(assessment);

  const existing = await findLatestObservation<OpportunityObservationRow>(
    client,
    "opportunity_observations",
    {
      productColumn: "marketplace_product_id",
      productId: params.marketplaceProductId,
      // A NULL supplier is not a filter value: assessments with no candidate are
      // scoped by product alone, which is the honest scope for "this listing".
      supplierProductId: params.supplierProductId ?? undefined,
    },
  );

  if (existing !== null && existing.content_hash === contentHash) {
    return { row: existing, inserted: false };
  }

  const { data, error } = await client
    .from("opportunity_observations")
    .insert({
      marketplace_product_id: params.marketplaceProductId,
      marketplace_snapshot_id: params.marketplaceSnapshotId,
      supplier_product_id: params.supplierProductId,
      supplier_snapshot_id: params.supplierSnapshotId,
      supplier_variant_id: params.supplierVariantId,
      match_observation_id: params.matchObservationId,
      economics_observation_id: params.economicsObservationId,
      engine_version: assessment.engineVersion,
      score: assessment.score,
      score_band: assessment.band,
      confidence: assessment.confidence,
      confidence_level: assessment.confidenceLevel,
      match_confidence: assessment.components.match.confidence,
      economics_completeness: assessment.components.economics.completeness,
      competition_intensity: assessment.components.competition.intensity,
      competition_verdict: assessment.components.competition.verdict,
      demand_verdict: assessment.components.demand.verdict,
      competition_query: assessment.inputs.competitionQuery,
      assessment,
      factors: assessment.factors,
      caps: assessment.caps,
      explanation: assessment.explanation,
      caveats: assessment.caveats,
      content_hash: contentHash,
      calculated_at: assessment.calculatedAt,
    })
    .select()
    .single();

  if (error !== null || data === null) {
    throw new PersistenceError(
      `opportunity_observations insert failed: ${error?.message ?? "no row returned"}`,
    );
  }

  return { row: data as OpportunityObservationRow, inserted: true };
}

/**
 * Reads the most recent persisted assessments for one listing, optionally
 * narrowed to one marketplace × supplier pair. Most recent first, always
 * bounded by `limit`.
 */
export async function readOpportunityObservations(
  client: SupabaseClient,
  params: {
    marketplaceProductId: string;
    supplierProductId: string | null;
    limit: number;
  },
): Promise<OpportunityObservationRow[]> {
  let query = client
    .from("opportunity_observations")
    .select("*")
    .eq("marketplace_product_id", params.marketplaceProductId)
    .order("calculated_at", { ascending: false })
    .limit(params.limit);

  if (params.supplierProductId !== null) {
    query = query.eq("supplier_product_id", params.supplierProductId);
  }

  const { data, error } = await query;

  if (error !== null || data === null) {
    return [];
  }

  return data as OpportunityObservationRow[];
}
