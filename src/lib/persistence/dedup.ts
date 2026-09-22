import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The observation tables that participate in the deduplication policy, and the
 * column each is scoped by. Typed as a literal union so the caller's column
 * name stays in sync with the schema.
 */
export type ObservationTable =
  | "marketplace_product_snapshots"
  | "supplier_product_snapshots"
  | "supplier_variant_snapshots"
  | "match_observations"
  | "economics_observations"
  | "opportunity_observations";

/**
 * Finds the most recent observation row for one product so the deduplication
 * policy can compare content hashes (docs/DATABASE.md §7).
 *
 * Behaviour:
 *   - Narrows to a second key (`supplier_product_id`) for the pair-scoped
 *     match/economics tables, so only *this* product pair's latest calculation
 *     is considered.
 *   - Returns `null` when no observation exists yet, and also when the database
 *     rejects the probe. A read failure must never block a write: the caller
 *     falls back to inserting, which is the safe, history-preserving direction.
 *
 * Ordering uses the observation's own time column (`observed_at`, or
 * `calculated_at` for the calculation tables), never `ingested_at` — dedup
 * compares what was observed, not when the row happened to be written.
 */
export async function findLatestObservation<Row>(
  client: SupabaseClient,
  table: ObservationTable,
  scope: { productColumn: string; productId: string; supplierProductId?: string },
): Promise<Row | null> {
  const orderColumn = table.endsWith("_observations")
    ? "calculated_at"
    : "observed_at";

  let query = client
    .from(table)
    .select("*")
    .eq(scope.productColumn, scope.productId)
    .order(orderColumn, { ascending: false })
    .limit(1);

  if (scope.supplierProductId !== undefined) {
    query = query.eq("supplier_product_id", scope.supplierProductId);
  }

  const { data, error } = await query;

  if (error !== null || data === null || data.length === 0) {
    return null;
  }

  return data[0] as Row;
}
