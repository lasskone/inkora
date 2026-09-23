/**
 * Deterministic sorting and filtering for the watchlist
 * (docs/ARCHITECTURE.md §16.9).
 *
 * Pure by design — no `server-only`, no I/O — so every rule is pinned by a unit
 * test. Three rules govern it:
 *
 *   1. **No new score.** Entries are ordered by *transparent existing fields*
 *      only — the Opportunity Engine's score, its separately computed
 *      confidence, the economics layer's profit/margin, or timestamps. The
 *      watchlist invents no priority, trend or monitoring score of its own
 *      (docs/MVP_SPEC.md, docs/ARCHITECTURE.md §16.1).
 *   2. **Missing values have explicit semantics.** An entry with no assessment
 *      yet is never interleaved at an arbitrary position: it sorts last under
 *      every score-derived key, and a missing profit excludes an entry from both
 *      the profitable and unprofitable filters rather than counting it as zero.
 *   3. **The order is reproducible.** Every key ends in a stable tiebreak over
 *      the server-assigned entry id, so two identical field values never produce
 *      an arbitrary order.
 */

import { parseDecimalToCents } from "@/lib/economics/money";
import type {
  ConfidenceLevel,
  EconomicsCompleteness,
  OpportunityBand,
} from "@/lib/opportunity/types";

import type { WatchlistEntryDetail } from "./types";

export type WatchlistSortKey =
  /** Last evaluated first (default) — the most recently assessed opportunity on top. */
  | "recently-evaluated"
  | "score"
  | "profit"
  | "margin"
  | "confidence"
  /** Most recently added first. */
  | "added";

/** The keys a client may request; anything else is rejected by the route. */
export const WATCHLIST_SORT_KEYS: readonly WatchlistSortKey[] = [
  "recently-evaluated",
  "score",
  "profit",
  "margin",
  "confidence",
  "added",
] as const;

export interface WatchlistFilters {
  band?: OpportunityBand;
  confidenceLevel?: ConfidenceLevel;
  completeness?: EconomicsCompleteness;
  profitability?: "profitable" | "unprofitable";
  supplierScope?: "pair" | "marketplace-only";
}

/** Profit in integer minor units, or `null` when no assessment recorded one. */
function profitCents(detail: WatchlistEntryDetail): number | null {
  const profit = detail.assessment?.profit ?? null;
  if (profit === null) {
    return null;
  }
  return parseDecimalToCents(profit);
}

/**
 * Sorts entries by the requested key. Missing values always sink to the bottom;
 * the entry id is the final stable tiebreak.
 */
export function sortEntries(
  details: WatchlistEntryDetail[],
  key: WatchlistSortKey,
): WatchlistEntryDetail[] {
  const ranked = [...details];

  ranked.sort((a, b) => {
    const comparison = compareByKey(a, b, key);
    if (comparison !== 0) {
      return comparison;
    }
    return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
  });

  return ranked;
}

function compareByKey(
  a: WatchlistEntryDetail,
  b: WatchlistEntryDetail,
  key: WatchlistSortKey,
): number {
  switch (key) {
    case "added":
      return compareStringsDesc(a.entry.createdAt, b.entry.createdAt);

    case "recently-evaluated": {
      const byTime = compareStringsDesc(
        a.assessment?.calculatedAt ?? null,
        b.assessment?.calculatedAt ?? null,
      );
      if (byTime !== 0) {
        return byTime;
      }
      // Never-evaluated entries keep a deterministic secondary order.
      return compareStringsDesc(a.entry.createdAt, b.entry.createdAt);
    }

    case "score": {
      const byScore = compareNumbersDesc(a.assessment?.score ?? null, b.assessment?.score ?? null);
      if (byScore !== 0) {
        return byScore;
      }
      // Evidence confidence stays visible as the secondary key, never folded in.
      return compareNumbersDesc(a.assessment?.confidence ?? null, b.assessment?.confidence ?? null);
    }

    case "confidence": {
      const byConfidence = compareNumbersDesc(
        a.assessment?.confidence ?? null,
        b.assessment?.confidence ?? null,
      );
      if (byConfidence !== 0) {
        return byConfidence;
      }
      return compareNumbersDesc(a.assessment?.score ?? null, b.assessment?.score ?? null);
    }

    case "profit": {
      const byProfit = compareNumbersDesc(profitCents(a), profitCents(b));
      if (byProfit !== 0) {
        return byProfit;
      }
      return compareNumbersDesc(a.assessment?.score ?? null, b.assessment?.score ?? null);
    }

    case "margin": {
      const byMargin = compareNumbersDesc(
        a.assessment?.marginPercent ?? null,
        b.assessment?.marginPercent ?? null,
      );
      if (byMargin !== 0) {
        return byMargin;
      }
      return compareNumbersDesc(profitCents(a), profitCents(b));
    }
  }
}

/**
 * Descending comparison where `null` always sorts last — a missing value is
 * never treated as zero and never interleaved above a present one.
 */
function compareNumbersDesc(a: number | null, b: number | null): number {
  if (a === null && b === null) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return b - a;
}

/** Descending string comparison (ISO timestamps), `null` last. */
function compareStringsDesc(a: string | null, b: string | null): number {
  if (a === null && b === null) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  if (a === b) {
    return 0;
  }
  return a > b ? -1 : 1;
}


/**
 * Filters entries by real existing fields only (docs/ARCHITECTURE.md §16.9).
 *
 * Missing-value semantics are explicit:
 *   - `profitable` requires a recorded profit strictly greater than zero;
 *   - `unprofitable` requires a recorded profit of zero or less;
 *   - an entry with no profit figure matches neither — it is not pushed into a
 *     bucket by treating `null` as zero.
 */
export function filterEntries(
  details: WatchlistEntryDetail[],
  filters: WatchlistFilters,
): WatchlistEntryDetail[] {
  return details.filter((detail) => {
    const assessment = detail.assessment;

    if (filters.band !== undefined) {
      if (assessment === null || assessment.band !== filters.band) {
        return false;
      }
    }

    if (filters.confidenceLevel !== undefined) {
      if (assessment === null || assessment.confidenceLevel !== filters.confidenceLevel) {
        return false;
      }
    }

    if (filters.completeness !== undefined) {
      if (assessment === null || assessment.economicsCompleteness !== filters.completeness) {
        return false;
      }
    }

    if (filters.profitability !== undefined) {
      const cents = profitCents(detail);
      if (cents === null) {
        return false;
      }
      if (filters.profitability === "profitable" && cents <= 0) {
        return false;
      }
      if (filters.profitability === "unprofitable" && cents > 0) {
        return false;
      }
    }

    if (filters.supplierScope !== undefined) {
      const isPair = detail.entry.supplierExternalId !== null;
      if (filters.supplierScope === "pair" && !isPair) {
        return false;
      }
      if (filters.supplierScope === "marketplace-only" && isPair) {
        return false;
      }
    }

    return true;
  });
}
