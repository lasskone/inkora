/**
 * Bounded inventory enrichment.
 *
 * Text ranking happens *first*; only then are the few top-ranked candidates
 * enriched with a live inventory lookup. This deliberately avoids one inventory
 * API call per candidate (which would be unbounded fan-out against CJ's quota)
 * and keeps inventory out of the ranking itself — availability is a sourcing
 * signal, not product-identity evidence (see docs/API_INTEGRATIONS.md §4).
 */

import type { UsWarehouseInventoryStatus } from "@/lib/supplier/types";
import type { MatchCandidate } from "./types";

/**
 * Resolves the US-warehouse verdict for one supplier SKU, or `null` when the
 * verdict cannot be established. Implemented by the route layer against the
 * supplier's real inventory endpoint, so this module stays provider-free.
 */
export type InventoryLookup = (sku: string) => Promise<UsWarehouseInventoryStatus | null>;

/**
 * Enriches at most `limit` of the already-ranked candidates with their
 * US-warehouse inventory verdict.
 *
 * Semantics preserved exactly (see `UsWarehouseInventoryStatus`):
 * - `CONFIRMED_AVAILABLE` — the inventory endpoint returned a US warehouse with
 *   positive stock;
 * - `CONFIRMED_NONE` — usable warehouse rows came back, none with US stock;
 * - `UNKNOWN` — no usable rows. **Never** converted to zero stock here.
 *
 * A candidate without a supplier SKU, or beyond the limit, keeps `null`
 * ("not queried"), which the UI must not render as "out of stock".
 */
export async function enrichWithInventory(
  candidates: MatchCandidate[],
  lookup: InventoryLookup,
  limit: number,
): Promise<MatchCandidate[]> {
  const enriched = [...candidates];
  let remaining = Math.max(0, limit);

  for (let index = 0; index < enriched.length && remaining > 0; index += 1) {
    const candidate = enriched[index];
    const sku = candidate.supplierProduct.sku;
    if (!sku) continue;

    try {
      const status = await lookup(sku);
      enriched[index] = {
        ...candidate,
        usWarehouseInventory: status ?? "UNKNOWN",
      };
    } catch {
      // A failing inventory call must never hide an otherwise good candidate:
      // it degrades to UNKNOWN, not to "no stock".
      enriched[index] = { ...candidate, usWarehouseInventory: "UNKNOWN" };
    }

    remaining -= 1;
  }

  return enriched;
}
