import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { MarketplaceProduct } from "@/lib/marketplace/types";
import type {
  HistoryEvidenceSummary,
  OpportunityAssessment,
  OpportunityLimits,
} from "@/lib/opportunity/types";
import type { ProductHistory } from "@/types/product-history";
import { parseDecimalToCents } from "@/lib/economics/money";
import { createPersistenceClient } from "./client";
import {
  appendOpportunityObservation,
  readOpportunityObservations,
} from "./opportunity-observations";
import { appendMarketplaceSnapshot } from "./snapshots";
import { upsertMarketplaceProduct } from "./identities";
import { clampLimit } from "./mapping";
import { numericToNumber } from "./mapping";
import { readMarketplaceProductHistory } from "./history-reader";
import type { PersistedRecords } from "./persistence-service";
import type { OpportunityObservationRow } from "./types";

/**
 * Opportunity Engine persistence (docs/ARCHITECTURE.md §13, docs/DATABASE.md
 * §6.8).
 *
 * An assessment is stored as *history*, never as an editable verdict: a
 * re-evaluation appends a new row so an old score stays attributable to the
 * engine version and the evidence that produced it. Like every other write
 * path in the intelligence layer, persistence is **best-effort** — a storage
 * failure is reported and never turns a successful assessment into an error,
 * but it is never reported as success either.
 */

/**
 * The outcome of persisting one opportunity assessment.
 *
 *   ok       — the assessment row was written (or reused by dedup).
 *   disabled — persistence is not configured on this server; nothing was
 *              written, and the caller must not claim otherwise.
 *   failed   — an error prevented writing. The message is secret-free.
 */
export type OpportunityPersistenceResult =
  | {
      status: "ok";
      observation: OpportunityObservationRow;
      /** True when a new row was inserted; false when deduplication reused one. */
      inserted: boolean;
    }
  | { status: "disabled" }
  | { status: "failed"; message: string };

/**
 * Everything needed to persist one assessment.
 *
 * `evaluation` carries the records written by `persistEvaluation` when a
 * candidate was actually economicsed. It is `null` when the matcher surfaced no
 * candidate — in which case only the marketplace observation exists, and the
 * assessment is recorded with a NULL supplier, which is the honest shape.
 */
export interface OpportunityPersistenceInput {
  assessment: OpportunityAssessment;
  /** The listing the assessment is about. */
  marketplaceProduct: MarketplaceProduct;
  evaluation: PersistedRecords | null;
}

/**
 * Persists one Opportunity Engine assessment.
 *
 * The marketplace observation is written when no evaluation already wrote it, so
 * an assessment with no candidate still anchors to a real observed listing. The
 * assessment itself is then appended with its full reasoning.
 */
export async function persistOpportunityAssessment(
  input: OpportunityPersistenceInput,
): Promise<OpportunityPersistenceResult> {
  const client = createPersistenceClient();
  if (client === null) {
    return { status: "disabled" };
  }

  try {
    const evaluation = input.evaluation;
    let marketplaceProductId = evaluation?.marketplaceProduct.id ?? null;
    let marketplaceSnapshotId = evaluation?.marketplaceSnapshot.id ?? null;

    if (marketplaceProductId === null || marketplaceSnapshotId === null) {
      const observedAt = input.marketplaceProduct.fetchedAt;
      const identity = await upsertMarketplaceProduct(
        client,
        input.marketplaceProduct,
        observedAt,
      );
      marketplaceProductId = identity.id;
      const snapshot = await appendMarketplaceSnapshot(
        client,
        marketplaceProductId,
        input.marketplaceProduct,
      );
      marketplaceSnapshotId = snapshot.row.id;
    }

    const observation = await appendOpportunityObservation(client, {
      marketplaceProductId,
      marketplaceSnapshotId,
      supplierProductId: evaluation?.supplierProduct.id ?? null,
      supplierSnapshotId: evaluation?.supplierSnapshot.id ?? null,
      supplierVariantId: evaluation?.supplierVariant?.id ?? null,
      matchObservationId: evaluation?.matchObservation.id ?? null,
      economicsObservationId: evaluation?.economicsObservation.id ?? null,
      assessment: input.assessment,
    });

    return {
      status: "ok",
      observation: observation.row,
      inserted: observation.inserted,
    };
  } catch (error) {
    // The message is either a secret-free PersistenceError or a generic
    // classification; it never includes a connection string, key, or raw
    // upstream payload.
    const message =
      error instanceof Error && error.name === "PersistenceError"
        ? error.message
        : "Persistence failed unexpectedly; the assessment was not guaranteed to be written.";
    return { status: "failed", message };
  }
}

/**
 * Reads the bounded, distilled evidence the Opportunity Engine is allowed to
 * see for one listing (docs/ARCHITECTURE.md §9.1).
 *
 * The engine itself never touches the database: the route hands it this summary,
 * which is what keeps the model pure and unit-testable with no storage. Returns
 * `null` whenever persistence is unavailable or the listing has never been
 * observed — both of which the engine reports as "no history yet", never as an
 * error.
 *
 * Everything here is an observation from a point in time. Nothing is extrapolated
 * and nothing is presented as current except through the engine's own freshness
 * rules.
 */
export async function readOpportunityEvidence(params: {
  marketplace: MarketplaceProduct["marketplace"];
  marketplaceExternalId: string;
  /** Supplier to narrow prior assessments by, or `null` for the listing alone. */
  supplierExternalId: string | null;
  limits: OpportunityLimits;
}): Promise<HistoryEvidenceSummary | null> {
  const client = createPersistenceClient();
  if (client === null) {
    return null;
  }

  const marketplaceProductId = await findMarketplaceProductId(
    client,
    params.marketplace,
    params.marketplaceExternalId,
  );
  if (marketplaceProductId === null) {
    // Never observed before: this is a first assessment, which is a normal
    // state, not a failure.
    return null;
  }

  const history = await readMarketplaceProductHistory({
    marketplace: params.marketplace,
    externalId: params.marketplaceExternalId,
    limit: clampLimit(params.limits.maxPriceObservations),
  });
  if (history.status !== "ok") {
    return null;
  }

  const supplierProductId =
    params.supplierExternalId === null
      ? null
      : await findSupplierProductId(client, params.supplierExternalId);

  const priors = await readOpportunityObservations(client, {
    marketplaceProductId,
    supplierProductId,
    limit: Math.max(1, params.limits.maxPriorAssessments),
  });

  return summarizeEvidence(history.history, priors);
}

/**
 * Distills a persisted history plus its prior assessments into the bounded
 * summary the engine consumes. Exposed separately so the mapping itself is
 * unit-testable without a database.
 */
export function summarizeEvidence(
  history: ProductHistory,
  priors: OpportunityObservationRow[],
): HistoryEvidenceSummary {
  // Snapshots are stored most-recent-first; the engine's evidence contract
  // expects oldest-first, and the span is measured from the widest available
  // pair, so the order is reversed here exactly once, at the boundary.
  const oldestFirst = [...history.marketplaceSnapshots].reverse();

  return {
    snapshotCount: oldestFirst.length,
    matchObservationCount: history.matchObservations.length,
    economicsObservationCount: history.economicsObservations.length,
    firstSeenAt: history.marketplaceProduct.firstSeenAt,
    lastSeenAt: history.marketplaceProduct.lastSeenAt,
    priceObservations: oldestFirst.map((snapshot) => ({
      observedAt: snapshot.observedAt,
      priceCents: parseDecimalToCents(snapshot.price),
    })),
    priorAssessments: priors.map((row) => ({
      score: numericToNumber(row.score) ?? 0,
      band: row.score_band,
      confidence: numericToNumber(row.confidence) ?? 0,
      engineVersion: row.engine_version,
      calculatedAt: row.calculated_at,
    })),
  };
}

/** Stable marketplace identity lookup by provider + external id. */
async function findMarketplaceProductId(
  client: SupabaseClient,
  marketplace: string,
  externalId: string,
): Promise<string | null> {
  const { data, error } = await client
    .from("marketplace_products")
    .select("id")
    .eq("marketplace", marketplace)
    .eq("external_id", externalId)
    .limit(1);

  if (error !== null || data === null || data.length === 0) {
    return null;
  }
  return (data[0] as { id: string }).id;
}

/** Stable supplier identity lookup by external id, for narrowing prior assessments. */
async function findSupplierProductId(
  client: SupabaseClient,
  externalId: string,
): Promise<string | null> {
  const { data, error } = await client
    .from("supplier_products")
    .select("id")
    .eq("external_id", externalId)
    .limit(1);

  if (error !== null || data === null || data.length === 0) {
    return null;
  }
  return (data[0] as { id: string }).id;
}

