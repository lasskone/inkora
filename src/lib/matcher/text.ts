/**
 * Reusable product-text normalization and feature extraction.
 *
 * Marketplace and supplier titles describe the same physical product in wildly
 * different ways ("WH-1000XM5" vs "WH1000XM5", "20 oz" vs "20oz", "earbuds" vs
 * "earbud"). This module turns a raw title into a deterministic set of features
 * the matcher reasons over. It is deliberately conservative:
 *
 * - model numbers, dimensions, capacities and quantities survive normalization
 *   (they are identity signals, not noise);
 * - only clearly promotional boilerplate and pure function words are dropped;
 * - no attribute is ever invented — absent features are absent features.
 *
 * The module is pure and dependency-free so the deterministic matcher unit
 * tests can exercise it without network access or credentials.
 */

/**
 * One extracted measurement: a numeric value with an unambiguous unit.
 */
export interface UnitValue {
  value: number;
  /** Canonical unit, e.g. `ml`, `oz`, `g`, `mah`, `gb`. */
  unit: string;
  /** The token the value was extracted from, for explanations. */
  raw: string;
}

/**
 * Deterministic features extracted from a product title.
 */
export interface ProductTextFeatures {
  /** The cleaned, lowercased, whitespace-normalized title. */
  normalized: string;
  /** Meaningful tokens (deduplicated, order preserved) including compact forms. */
  tokens: string[];
  /** Identifier-like compact tokens, e.g. `wh1000xm5`, `q30`, `hd800`. */
  identifiers: string[];
  /** Measurements with unambiguous units. */
  units: UnitValue[];
  /** Pack / piece / set counts, e.g. `3` for `3 pack`. */
  quantities: number[];
  /** Brand identified with reasonable confidence, or null when not identifiable. */
  brand: string | null;
}

// --- Unit vocabulary -------------------------------------------------------

/**
 * Measurement units with an unambiguous spelling. Used both to split attached
 * forms (`20oz` → `20 oz`) and to pair adjacent tokens (`20 oz`).
 */
const MEASUREMENT_UNITS = new Set([
  "oz",
  "ml",
  "l",
  "g",
  "kg",
  "mg",
  "cm",
  "mm",
  "m",
  "ft",
  "mah",
  "wh",
  "ah",
  "gb",
  "tb",
  "mb",
  "w",
  "v",
  "khz",
  "mhz",
  "ghz",
  "hz",
  "db",
]);

/** Spelling aliases folded onto one canonical unit. */
const UNIT_ALIASES: Record<string, string> = {
  ounce: "oz",
  ounces: "oz",
  floz: "oz",
  milliliter: "ml",
  milliliters: "ml",
  millilitre: "ml",
  millilitres: "ml",
  liter: "l",
  liters: "l",
  litre: "l",
  litres: "l",
  gram: "g",
  grams: "g",
  kilogram: "kg",
  kilograms: "kg",
  milligram: "mg",
  milligrams: "mg",
  centimeter: "cm",
  centimeters: "cm",
  millimeter: "mm",
  millimeters: "mm",
  meter: "m",
  meters: "m",
  foot: "ft",
  feet: "ft",
  watt: "w",
  watts: "w",
  volt: "v",
  volts: "v",
};

/** Count-like units treated as quantities rather than measurements. */
const COUNT_UNITS = new Set([
  "pcs",
  "pc",
  "pack",
  "pk",
  "set",
  "sets",
  "piece",
  "pieces",
  "pair",
  "pairs",
  "pr",
  "doz",
  "dozen",
]);

/** Function words that carry no product-identity signal. */
const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "for",
  "with",
  "of",
  "in",
  "on",
  "to",
  "at",
  "by",
  "from",
  "into",
  "per",
  "as",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "your",
  "you",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "all",
  "any",
  "more",
  "most",
  "very",
  "than",
]);

/**
 * Promotional / listing boilerplate. Multi-word phrases are stripped from the
 * normalized string; single words below are dropped only as standalone tokens.
 * Conservatively scoped: nothing here can be a model number or a dimension.
 */
const BOILERPLATE_PHRASES = [
  "free shipping",
  "fast shipping",
  "fast delivery",
  "free delivery",
  "brand new",
  "high quality",
  "top quality",
  "premium quality",
  "best price",
  "hot sale",
  "on sale",
  "for sale",
  "free returns",
  "money back",
  "100 authentic",
  "100 percent",
  "shop now",
  "buy now",
  "limited time",
  "fast ship",
];

const BOILERPLATE_WORDS = new Set([
  "shipping",
  "shipped",
  "ship",
  "fast",
  "free",
  "authentic",
  "genuine",
]);

/**
 * Brands identifiable with reasonable deterministic confidence: a whole-token
 * match against this curated lexicon. Deliberately short — an unknown brand is
 * reported as `null` rather than guessed, and a title naming two known brands
 * is reported as ambiguous (also `null`) rather than picking one.
 */
const BRAND_LEXICON = new Set([
  "anker",
  "soundcore",
  "sony",
  "apple",
  "samsung",
  "bose",
  "jbl",
  "beats",
  "lg",
  "huawei",
  "xiaomi",
  "lenovo",
  "dell",
  "hp",
  "asus",
  "acer",
  "microsoft",
  "google",
  "nokia",
  "motorola",
  "oneplus",
  "oppo",
  "vivo",
  "tcl",
  "hisense",
  "philips",
  "panasonic",
  "canon",
  "nikon",
  "fujifilm",
  "gopro",
  "garmin",
  "fitbit",
  "jabra",
  "earfun",
  "soundpeats",
  "tozo",
  "mifa",
  "baseus",
  "ugreen",
  "aukey",
]);


// --- Normalization pipeline ------------------------------------------------

/**
 * Unicode-normalizes, lowercases, removes combining marks, strips boilerplate
 * and normalizes whitespace. Does *not* drop function words — that happens at
 * token level, where it is safe — and never removes digits or letters.
 */
export function normalizeTitle(rawTitle: string): string {
  if (typeof rawTitle !== "string") return "";

  // NFKD folds compatibility forms (e.g. `㎡` → `m2`); dropping combining marks
  // makes `crème` and `creme` comparable without losing any letters or digits.
  const decomposed = rawTitle.normalize("NFKD").replace(/\p{Diacritic}/gu, "");

  let lower = decomposed.toLowerCase();

  // Split attached measurements (`20oz` → `20 oz`) so units become comparable
  // with their spaced equivalents, without touching unrelated alphanumerics.
  lower = lower.replace(unitBoundaryRegex(), "$1 $2");

  for (const phrase of BOILERPLATE_PHRASES) {
    lower = lower.split(phrase).join(" ");
  }

  return lower.replace(/\s+/g, " ").trim();
}

let cachedUnitRegex: RegExp | null = null;
function unitBoundaryRegex(): RegExp {
  if (cachedUnitRegex) return cachedUnitRegex;
  const units = [...MEASUREMENT_UNITS, ...COUNT_UNITS].sort(
    (left, right) => right.length - left.length,
  );
  cachedUnitRegex = new RegExp(
    `\\b(\\d+(?:\\.\\d+)?)(${units.join("|")})\\b`,
    "g",
  );
  return cachedUnitRegex;
}

/**
 * Splits a normalized title into meaningful tokens.
 *
 * Returns raw (pre-stopword) tokens; callers needing the identity-signaling set
 * use `extractProductTextFeatures`, which layers stopword removal on top. Input
 * is expected already normalized (see `normalizeTitle`): lowercase and
 * whitespace-collapsed. Model identifiers collapse to their compact form
 * (`wh-1000xm5` → `wh1000xm5`) so separator differences cannot dilute matching.
 */
export function tokenizeTitle(normalizedTitle: string): string[] {
  const tokens: string[] = [];

  for (const chunk of normalizedTitle.split(/\s+/)) {
    // Strip leading/trailing punctuation, keep the interior intact so
    // `wh-1000xm5`, `usb-c` and `hd-800` survive as single tokens.
    const core = chunk.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
    if (!core) continue;

    if (isNumericToken(core)) {
      tokens.push(core);
      continue;
    }

    if (isIdentifierToken(core)) {
      // Canonical compact form so `wh-1000xm5` and `wh1000xm5` compare equal
      // instead of diluting token similarity with two spellings of one model.
      tokens.push(compactToken(core));
      continue;
    }

    // Word tokens are canonicalized to the singular so `earbuds` and `earbud`
    // compare equal. Identifiers are left untouched above.
    tokens.push(singularOf(core) ?? core);
  }

  return tokens;
}

function isNumericToken(token: string): boolean {
  return /^\d+(?:[.,]\d+)?$/.test(token);
}

/**
 * An identifier-like token: at least one digit *and* one letter, long enough
 * (≥ 3 chars) to plausibly be a model number rather than noise. Pure numbers
 * and known measurements are handled elsewhere, so this targets strings like
 * `wh-1000xm5`, `hd800` or `q30` — not `usb-c`, which has no digit.
 */
function isIdentifierToken(token: string): boolean {
  return (
    token.length >= 3 &&
    /\p{Nd}/u.test(token) &&
    /\p{L}/u.test(token) &&
    !isNumericToken(token)
  );
}

/** Removes separators, keeping letters and digits: `wh-1000xm5` → `wh1000xm5`. */
function compactToken(token: string): string {
  return token.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

/**
 * Deterministic English singular for simple plurals, or null when the token
 * should not be singularized (too short, or a word whose `-s` is not a plural).
 */
function singularOf(token: string): string | null {
  if (!/s$/.test(token)) return null;
  const singular = token.slice(0, -1);
  if (singular.length < 3) return null;
  if (NON_PLURAL_WORDS.has(singular)) return null;
  if (/[sx]$/.test(singular) || /sh$/.test(singular) || /ch$/.test(singular)) {
    // `classes`/`boxes`-style plurals are not produced by a plain `s` strip.
    return null;
  }
  return singular;
}

/** Words whose `-s` form is not a plural we can safely strip. */
const NON_PLURAL_WORDS = new Set([
  "thi",
  "ga",
  "bu",
  "len",
  "bos",
  "clas",
  "glas",
  "dres",
  "new",
  "ha",
  "di",
]);


// --- Feature extraction ----------------------------------------------------

/**
 * The matcher's entry point into text: turns one raw title into every feature
 * the scoring signals need. Pure and deterministic.
 */
export function extractProductTextFeatures(
  rawTitle: string,
): ProductTextFeatures {
  const normalized = normalizeTitle(rawTitle);
  const rawTokens = tokenizeTitle(normalized);

  return {
    normalized,
    tokens: dedupe(rawTokens.filter((token) => !isStopword(token))),
    identifiers: extractIdentifiers(rawTokens),
    units: extractUnitValues(rawTokens),
    quantities: extractQuantities(rawTokens),
    brand: detectBrand(rawTokens),
  };
}

/**
 * Pairs a numeric token with a following known-unit token (`20 oz`), and also
 * accepts attached forms left intact (`500ml`). Canonicalizes unit spellings.
 * Same-unit, different-value pairs are exactly what contradiction detection
 * needs; cross-unit conversion is intentionally *not* performed (that would be
 * an estimate, not an observed fact).
 */
export function extractUnitValues(tokens: string[]): UnitValue[] {
  const values: UnitValue[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    const attached = /^(\d+(?:[.,]\d+)?)([a-z]{1,6})$/.exec(token);
    if (attached && isUnitWord(attached[2])) {
      values.push({
        value: parseNumber(attached[1]),
        unit: canonicalUnit(attached[2]),
        raw: token,
      });
      continue;
    }

    const number = parseNumberOrNull(token);
    if (number === null) continue;
    const next = tokens[index + 1];
    if (next && isUnitWord(next)) {
      values.push({
        value: number,
        unit: canonicalUnit(next),
        raw: `${token} ${next}`,
      });
    }
  }

  return values;
}

/**
 * Extracts pack / set / piece counts in both orders: `3 pack`, `3pcs`, and
 * `pack of 3`. Returns unique values.
 */
export function extractQuantities(tokens: string[]): number[] {
  const values: number[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    // `3pcs`, `3pk`.
    const attached = /^(\d+)(pcs|pc|pack|pk|set|sets|pr)$/i.exec(token);
    if (attached) {
      values.push(parseNumber(attached[1]));
      continue;
    }

    const number = parseNumberOrNull(token);
    if (number === null) continue;

    const next = tokens[index + 1];
    if (next && COUNT_UNITS.has(next)) {
      // `3 pack`, `12 pcs`.
      values.push(number);
    }
  }

  // `pack of 3`, `set of 12`: a count unit, then `of`, then the number.
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (!COUNT_UNITS.has(tokens[index])) continue;
    if (tokens[index + 1] !== "of") continue;
    const number = parseNumberOrNull(tokens[index + 2]);
    if (number !== null) values.push(number);
  }

  return [...new Set(values)];
}

/**
 * Compact identifier-like tokens (`wh1000xm5`), which carry far more identity
 * signal than ordinary words. Pure numbers and measurement units are excluded.
 */
export function extractIdentifiers(tokens: string[]): string[] {
  const identifiers = tokens
    .filter((token) => isIdentifierToken(token))
    .map(compactToken)
    .filter((token) => token.length >= 3);
  return [...new Set(identifiers)];
}

/**
 * Reports a brand only when exactly one lexicon brand appears as a whole token.
 * Zero matches → unknown; two or more → ambiguous. Either way it is `null`,
 * never a guess (see the product-identity principle, docs/ARCHITECTURE.md §8).
 */
export function detectBrand(tokens: string[]): string | null {
  const found: string[] = [];
  for (const token of tokens) {
    const core = token.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
    if (BRAND_LEXICON.has(core) && !found.includes(core)) {
      found.push(core);
    }
  }
  return found.length === 1 ? found[0] : null;
}

function isUnitWord(token: string): boolean {
  return MEASUREMENT_UNITS.has(token) || token in UNIT_ALIASES;
}

function canonicalUnit(token: string): string {
  return UNIT_ALIASES[token] ?? token;
}

function parseNumberOrNull(token: string): number | null {
  if (!/^\d+(?:[.,]\d+)?$/.test(token)) return null;
  return parseNumber(token);
}

function parseNumber(token: string): number {
  return Number(token.replace(",", "."));
}

function isStopword(token: string): boolean {
  return STOPWORDS.has(token) || BOILERPLATE_WORDS.has(token);
}

function dedupe(tokens: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of tokens) {
    if (!seen.has(token)) {
      seen.add(token);
      result.push(token);
    }
  }
  return result;
}
