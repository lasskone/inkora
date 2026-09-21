/**
 * Deterministic candidate-query generation.
 *
 * The matcher never forwards a raw eBay title blindly to the supplier: eBay
 * titles are long, stuffed with boilerplate and search-engine keywords, and a
 * verbatim copy would pollute CJ's keyword search and waste rate limit. Instead
 * a *bounded* set of deterministic queries is derived from the normalized
 * marketplace title, each with a distinct purpose:
 *
 * 1. `cleaned`      — the de-boilerplated title: broadest recall.
 * 2. `distinctive`  — the highest-information tokens (identifiers, units, plus
 *                     the most descriptive surviving words): precision.
 * 3. `identifier`   — identifiers/specs only, when present: needle-in-haystack
 *                     recall for genuinely branded/modelled products.
 *
 * The set is deduplicated and hard-capped at `MAX_QUERIES`, so one marketplace
 * product can never trigger uncontrolled CJ fan-out.
 */

import type { MarketplaceProduct } from "@/lib/marketplace/types";
import { extractProductTextFeatures } from "./text";

/** One generated supplier search query. */
export interface CandidateQuery {
  query: string;
  /** Why this query exists (documented strategy label). */
  rationale: string;
}

/** Hard ceiling on queries per marketplace product (rate-limit discipline). */
export const MAX_QUERIES = 3;

/** CJ's keyword search accepts at most 100 characters; stay under it safely. */
export const MAX_QUERY_LENGTH = 96;

/** Minimum tokens for a broad query to be worth issuing at all. */
export const MIN_QUERY_TOKENS = 2;

/**
 * Generates the bounded, deduplicated query set for one marketplace product.
 */
export function generateCandidateQueries(
  product: MarketplaceProduct,
): CandidateQuery[] {
  const features = extractProductTextFeatures(product.title);
  const tokens = features.tokens;

  if (tokens.length === 0) return [];

  const queries: CandidateQuery[] = [];

  // 1 — cleaned title, broadest recall.
  const cleaned = joinBounded(tokens);
  if (cleaned) {
    queries.push({
      query: cleaned,
      rationale: "Cleaned marketplace title (broadest supplier recall).",
    });
  }

  // 2 — high-information subset for precision.
  const distinctive = joinBounded(rankDistinctive(tokens, features));
  if (distinctive && distinctive !== cleaned) {
    queries.push({
      query: distinctive,
      rationale:
        "High-information token subset (identifiers, units, key words).",
    });
  }

  // 3 — identifiers / specs only, when the product actually has any. A single
  // model number is a legitimate needle-in-haystack query, so this query may be
  // one token long.
  const identifierTokens = [
    ...features.identifiers,
    ...features.units.map((unit) => unit.raw.replace(/\s+/g, "")),
  ];
  const identifierQuery = joinBounded([...new Set(identifierTokens)], 1);
  if (
    identifierQuery &&
    !queries.some((entry) => entry.query === identifierQuery)
  ) {
    queries.push({
      query: identifierQuery,
      rationale:
        "Model / specification tokens only (needle-in-haystack recall).",
    });
  }

  return queries.slice(0, MAX_QUERIES);
}

/**
 * Orders tokens so the most identity-bearing come first, then truncates to the
 * query budget. Identifiers and unit values lead, followed by the remaining
 * tokens in title order (which keeps the leading, usually most descriptive
 * words of the title ahead of trailing search-stuffing).
 */
function rankDistinctive(
  tokens: string[],
  features: ReturnType<typeof extractProductTextFeatures>,
): string[] {
  const strong = new Set<string>([
    ...features.identifiers,
    ...features.units.map((unit) => unit.raw.replace(/\s+/g, "")),
  ]);

  const head = tokens.filter((token) => strong.has(token) || strong.has(compactOf(token)));
  const tail = tokens.filter((token) => !head.includes(token));

  return [...new Set([...head, ...tail])];
}

/** Compact alphanumeric form, matching the text module's identifier spelling. */
function compactOf(token: string): string {
  return token.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

/**
 * Joins tokens into a query, never exceeding `MAX_QUERY_LENGTH`, and never
 * splitting a token mid-way. Returns "" when too few meaningful tokens exist.
 */
function joinBounded(tokens: string[], minTokens = MIN_QUERY_TOKENS): string {
  const kept: string[] = [];
  let length = 0;

  for (const token of tokens) {
    const added = kept.length === 0 ? token.length : token.length + 1;
    if (length + added > MAX_QUERY_LENGTH) break;
    kept.push(token);
    length += added;
  }

  if (kept.length < minTokens) return "";
  return kept.join(" ").trim();
}
