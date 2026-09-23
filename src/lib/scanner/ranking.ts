/**
 * Deterministic ranking of scan results (docs/ARCHITECTURE.md §15.5).
 *
 * The scanner introduces **no new scoring metric**. Results are ordered by the
 * Opportunity Engine's own score, and every tie is broken by a documented,
 * deterministic rule — because a list whose order changes between two identical
 * inputs is indistinguishable from a broken ranking.
 *
 * The tie-break ladder, in order:
 *
 *   1. `score` DESC                       — the engine's verdict, unmodified.
 *   2. evidence `confidence` DESC         — for equal scores, the assessment
 *                                           resting on stronger evidence comes
 *                                           first. Confidence is a separate
 *                                           number from score
 *                                           (docs/ARCHITECTURE.md §9) and stays
 *                                           visibly prominent here, never folded
 *                                           into a blended metric.
 *   3. economics completeness DESC        — COMPLETE before PARTIAL before
 *                                           UNAVAILABLE: of two otherwise equal
 *                                           opportunities, the one with a
 *                                           computable profit figure is the more
 *                                           actionable.
 *   4. match confidence DESC              — stronger product match first.
 *   5. `marketplaceExternalId` ASC        — the final, stable tie-break. A
 *                                           string comparison over a server-assigned
 *                                           id can never vary between runs, which
 *                                           is what makes the whole order stable.
 *
 * This module is pure: identical inputs ⇒ identical output, no I/O, no clock.
 */

import type { EconomicsCompleteness } from "@/lib/economics/types";
import type { ScanItem } from "./types";

/** Ordinal for economics completeness, higher = more actionable. */
const COMPLETENESS_RANK: Record<EconomicsCompleteness, number> = {
  COMPLETE: 2,
  PARTIAL: 1,
  UNAVAILABLE: 0,
};

/**
 * The comparison function backing `rankResults`, exported for unit tests so the
 * tie-break ladder can be pinned one rule at a time.
 *
 * Returns a negative number when `a` should rank before `b`.
 */
export function compareScanItems(a: ScanItem, b: ScanItem): number {
  const scoreA = a.assessment?.score ?? -1;
  const scoreB = b.assessment?.score ?? -1;
  if (scoreA !== scoreB) {
    return scoreB - scoreA;
  }

  const confA = a.assessment?.confidence ?? -1;
  const confB = b.assessment?.confidence ?? -1;
  if (confA !== confB) {
    return confB - confA;
  }

  const econA = a.economics?.completeness;
  const econB = b.economics?.completeness;
  if (econA !== undefined || econB !== undefined) {
    const rankA = econA === undefined ? -1 : COMPLETENESS_RANK[econA];
    const rankB = econB === undefined ? -1 : COMPLETENESS_RANK[econB];
    if (rankA !== rankB) {
      return rankB - rankA;
    }
  }

  const matchA = a.candidate?.confidence ?? -1;
  const matchB = b.candidate?.confidence ?? -1;
  if (matchA !== matchB) {
    return matchB - matchA;
  }

  // The final tie-break is a stable string comparison over server-assigned ids,
  // which are unique within a scan. An unresolved id (no product object) sorts
  // last by its requested id so it still has a deterministic position.
  const keyA = a.marketplaceProduct?.externalId ?? a.requestedItemId ?? "";
  const keyB = b.marketplaceProduct?.externalId ?? b.requestedItemId ?? "";
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}

/**
 * Orders verdict items best-first. The input is treated as already filtered to
 * items carrying an assessment; sorting is stable enough in practice because the
 * final tie-break is total over `externalId`, which is unique within a scan.
 */
export function rankResults(items: readonly ScanItem[]): ScanItem[] {
  return [...items].sort(compareScanItems);
}
