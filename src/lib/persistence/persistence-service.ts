import "server-only";

import type { MarketplaceProduct } from "@/lib/marketplace/types";
import type { SupplierProduct, SupplierVariant } from "@/lib/supplier/types";
import type { MatchCandidate } from "@/lib/matcher/types";
import type { EconomicsResult } from "@/lib/economics/types";
import { createPersistenceClient } from "./client";
import {
  upsertMarketplaceProduct,
  upsertSupplierProduct,
  upsertSupplierVariant,
} from "./identities";
import { appendMarketplaceSnapshot } from "./snapshots";
import {
  appendSupplierSnapshot,
  appendSupplierVariantSnapshot,
} from "./supplier-snapshots";
import { appendMatchObservation } from "./match-observations";
import { appendEconomicsObservation } from "./economics-observations";
import { MATCHER_VERSION } from "@/lib/matcher/types";
import type {
  EconomicsObservationRow,
  MarketplaceProductRow,
  MarketplaceSnapshotRow,
  MatchObservationRow,
  SupplierProductRow,
  SupplierSnapshotRow,
  SupplierVariantRow,
  SupplierVariantSnapshotRow,
} from "./types";

/**
 * The outcome of one persistence attempt (docs/ARCHITECTURE.md §13).
 *
 *   ok       — every record was written (or reused by dedup) consistently.
 *   disabled — persistence is not configured on this server; nothing was
 *              written, and the caller must not claim otherwise.
 *   failed   — an error prevented writing. The message is secret-free.
 */
export type EvaluationPersistenceResult =
  | {
      status: "ok";
      records: PersistedRecords;
    }
  | { status: "disabled" }
  | { status: "failed"; message: string };

/**
 * The records that represent one economics evaluation in storage. The booleans
 * report which observations were newly inserted versus reused by the
 * deduplication policy, so a caller can distinguish "first time we saw this"
 * from "unchanged since last time".
 */
export interface PersistedRecords {
  marketplaceProduct: MarketplaceProductRow;
  marketplaceSnapshot: MarketplaceSnapshotRow;
  marketplaceSnapshotInserted: boolean;
  supplierProduct: SupplierProductRow;
  supplierSnapshot: SupplierSnapshotRow;
  supplierSnapshotInserted: boolean;
  supplierVariant: SupplierVariantRow | null;
  supplierVariantSnapshot: SupplierVariantSnapshotRow | null;
  supplierVariantSnapshotInserted: boolean;
  matchObservation: MatchObservationRow;
  matchObservationInserted: boolean;
  economicsObservation: EconomicsObservationRow;
  economicsObservationInserted: boolean;
}

/**
 * The complete input to `persistEvaluation`. Everything here must already have
 * been produced by the server from authoritative upstream sources — the service
 * never trusts client-supplied prices or costs.
 */
export interface EvaluationPersistenceInput {
  marketplaceProduct: MarketplaceProduct;
  supplierProduct: SupplierProduct;
  /** The matcher candidate that was selected, with its full reasoning. */
  candidate: MatchCandidate;
  /** The variant the economics resolved, or `null` when it could not. */
  selectedVariant: SupplierVariant | null;
  /** The economics result to persist. */
  economics: EconomicsResult;
}

/**
 * Persists one complete economics evaluation: identities, observations, the
 * match observation, and the economics observation.
 *
 * This is the single bounded entry point for writes (§23): it is invoked only
 * after a user explicitly evaluates a candidate, never on every search or
 * keystroke. Persistence is **best-effort** (§22): a database failure is
 * reported through the result and never allowed to turn a successful upstream
 * response into an error, but it is never silently reported as success either.
 */
export async function persistEvaluation(
  input: EvaluationPersistenceInput,
): Promise<EvaluationPersistenceResult> {
  const client = createPersistenceClient();
  if (client === null) {
    return { status: "disabled" };
  }

  try {
    // --- Stable identities ------------------------------------------------
    // Identities are upserted first because every observation references them.
    const marketplaceProduct = await upsertMarketplaceProduct(
      client,
      input.marketplaceProduct,
      input.marketplaceProduct.fetchedAt,
    );

    const supplierProduct = await upsertSupplierProduct(
      client,
      input.supplierProduct,
      input.supplierProduct.fetchedAt,
    );

    let supplierVariant: SupplierVariantRow | null = null;
    if (input.selectedVariant !== null) {
      supplierVariant = await upsertSupplierVariant(
        client,
        supplierProduct.id,
        input.selectedVariant,
        input.economics.calculatedAt,
      );
    }

    // --- Observations (append / dedup) -------------------------------------
    const marketplaceSnapshot = await appendMarketplaceSnapshot(
      client,
      marketplaceProduct.id,
      input.marketplaceProduct,
    );

    const supplierSnapshot = await appendSupplierSnapshot(
      client,
      supplierProduct.id,
      input.supplierProduct,
    );

    let supplierVariantSnapshot: SupplierVariantSnapshotRow | null = null;
    let supplierVariantSnapshotInserted = false;
    if (supplierVariant !== null && input.selectedVariant !== null) {
      const variantSnapshot = await appendSupplierVariantSnapshot(
        client,
        supplierVariant.id,
        input.selectedVariant,
        input.economics.calculatedAt,
      );
      supplierVariantSnapshot = variantSnapshot.row;
      supplierVariantSnapshotInserted = variantSnapshot.inserted;
    }

    // --- Derived calculations ----------------------------------------------
    const matchObservation = await appendMatchObservation(client, {
      marketplaceProductId: marketplaceProduct.id,
      marketplaceSnapshotId: marketplaceSnapshot.row.id,
      supplierProductId: supplierProduct.id,
      supplierSnapshotId: supplierSnapshot.row.id,
      supplierVariantId: supplierVariant?.id ?? null,
      candidate: input.candidate,
      matcherVersion: MATCHER_VERSION,
    });

    const economicsObservation = await appendEconomicsObservation(client, {
      marketplaceProductId: marketplaceProduct.id,
      marketplaceSnapshotId: marketplaceSnapshot.row.id,
      supplierProductId: supplierProduct.id,
      supplierSnapshotId: supplierSnapshot.row.id,
      supplierVariantId: supplierVariant?.id ?? null,
      matchObservationId: matchObservation.row.id,
      economics: input.economics,
    });

    return {
      status: "ok",
      records: {
        marketplaceProduct,
        marketplaceSnapshot: marketplaceSnapshot.row,
        marketplaceSnapshotInserted: marketplaceSnapshot.inserted,
        supplierProduct,
        supplierSnapshot: supplierSnapshot.row,
        supplierSnapshotInserted: supplierSnapshot.inserted,
        supplierVariant,
        supplierVariantSnapshot,
        supplierVariantSnapshotInserted,
        matchObservation: matchObservation.row,
        matchObservationInserted: matchObservation.inserted,
        economicsObservation: economicsObservation.row,
        economicsObservationInserted: economicsObservation.inserted,
      },
    };
  } catch (error) {
    // Persistence failures are isolated from API/provider logic. The message is
    // either a secret-free PersistenceError or a generic classification; it
    // never includes a connection string, key, or raw upstream payload.
    const message =
      error instanceof Error && error.name === "PersistenceError"
        ? error.message
        : "Persistence failed unexpectedly; no records were guaranteed to be written.";
    return { status: "failed", message };
  }
}
