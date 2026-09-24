/**
 * Deterministic product-family fingerprints and bounded discovery queries.
 *
 * The same physical product is described in wildly different words by different
 * sellers ("Skullcandy SESH ANC" vs "SESH ANC True Wireless Earbuds"), so
 * cross-seller evidence can never rest on exact titles. This module reuses the
 * Product Matcher's own text normalization (`@/lib/matcher/text`) to build a
 * fingerprint that is invariant to word order, boilerplate and casing — the
 * same primitives the matcher trusts, so one notion of "same product family"
 * runs through the whole platform (docs/ARCHITECTURE.md §8).
 *
 * No LLMs, no fuzzy guesswork: the fingerprint is a pure function of the title,
 * and every signal that contributes to a confidence verdict is named so it can
 * be audited and tested.
 *
 * Pure on purpose: unit-testable with no network or credentials.
 */

import { extractProductTextFeatures } from "@/lib/matcher/text";

/** A discovery query is bounded in both tokens and characters. */
const MAX_DISCOVERY_TOKENS = 6;
const MAX_DISCOVERY_LENGTH = 64;
/** Below this many meaningful tokens a query is not worth issuing. */
const MIN_DISCOVERY_TOKENS = 2;

/**
 * The deterministic product-family key of a title, or `null` when the title
 * carries too little signal to identify a family.
 *
 * Composed of the three order-invariant signals the text module extracts:
 *
 * - `brand` — the single lexicon brand, when unambiguous;
 * - `identifiers` — compact model/spec tokens (`wh1000xm5`), the strongest
 *   identity signal a title usually carries;
 * - `tokens` — the de-boilerplated token set, sorted so word order does not
 *   matter.
 *
 * Absent components are `null`-marked rather than dropped, so "no brand" and
 * "unknown brand" stay distinguishable and never collide.
 */
export function familyKeyOf(title: string): string | null {
  const features = extractProductTextFeatures(title);
  if (features.tokens.length === 0) return null;

  const brand = features.brand;
  const identifiers = [...features.identifiers].sort().join(".") || "_";
  const units = features.units.map((unit) => unit.raw.replace(/\s+/g, "")).sort();
  const tokens = [...features.tokens].sort().join(".");

  return `b:${brand ?? "_"}|i:${identifiers}|u:${units.join(".") || "_"}|t:${tokens}`;
}

/**
 * A looser, order-invariant signature used for similarity scoring: the set of
 * meaningful tokens plus identifiers, without the strict equality the family key
 * demands.
 */
export function tokenSignature(title: string): Set<string> {
  const features = extractProductTextFeatures(title);
  return new Set([...features.tokens, ...features.identifiers]);
}

/** The brand the text module identifies, or `null` when ambiguous or absent. */
export function brandOf(title: string): string | null {
  return extractProductTextFeatures(title).brand;
}

/** Compact identifiers/model tokens, deduplicated. */
export function identifiersOf(title: string): string[] {
  return extractProductTextFeatures(title).identifiers;
}

/**
 * The display title to show for a family — the first listing's own title, since
 * that is what the user actually saw, never a synthesized label.
 */
export function familySampleTitle(listing: {
  title: string;
}): string {
  return listing.title;
}

/**
 * Derives one bounded marketplace query from a listing title, for cross-seller
 * discovery.
 *
 * Identifiers and units lead (a model number is a needle-in-haystack query),
 * then the most descriptive surviving tokens in title order. The query is
 * capped in both token count and length, and is refused when the title does not
 * yield enough signal — issuing a one-word query would return the whole
 * marketplace, which is the opposite of bounded discovery.
 *
 * Returns `null` when no usable query can be derived.
 */
export function buildDiscoveryQuery(title: string): string | null {
  const features = extractProductTextFeatures(title);
  const strong = new Set<string>([
    ...features.identifiers,
    ...features.units.map((unit) => unit.raw.replace(/\s+/g, "")),
  ]);

  const head = features.tokens.filter((token) => strong.has(token));
  const tail = features.tokens.filter((token) => !head.includes(token));

  const ordered = [...new Set([...head, ...tail])];

  const kept: string[] = [];
  let length = 0;
  for (const token of ordered) {
    if (kept.length >= MAX_DISCOVERY_TOKENS) break;
    const added = kept.length === 0 ? token.length : token.length + 1;
    if (length + added > MAX_DISCOVERY_LENGTH) break;
    kept.push(token);
    length += added;
  }

  if (kept.length < MIN_DISCOVERY_TOKENS) return null;
  return kept.join(" ");
}

/**
 * Jaccard similarity of two token signatures, in [0, 1]. Deterministic and
 * symmetric; empty sets score 0 because similarity to nothing is meaningless.
 */
export function tokenSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
