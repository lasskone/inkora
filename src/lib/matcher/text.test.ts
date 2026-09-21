import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractProductTextFeatures,
  normalizeTitle,
  tokenizeTitle,
} from "@/lib/matcher/text";

test("normalizeTitle lowercases, collapses whitespace and strips boilerplate", () => {
  assert.equal(
    normalizeTitle("  Anker  Soundcore   FREE Shipping  Headphones "),
    "anker soundcore headphones",
  );
  assert.equal(normalizeTitle("Hot SALE 20oz Mug"), "20 oz mug");
});

test("normalizeTitle folds accents without losing letters", () => {
  assert.equal(normalizeTitle("Crème Brûlée Mug"), "creme brulee mug");
});

test("unit boundary splitting makes 20oz and 20 oz comparable", () => {
  const attached = extractProductTextFeatures("Insulated Tumbler 20oz");
  const spaced = extractProductTextFeatures("Insulated Tumbler 20 oz");

  assert.deepEqual(attached.units, [{ value: 20, unit: "oz", raw: "20 oz" }]);
  assert.deepEqual(attached.units, spaced.units);
  assert.deepEqual(attached.tokens, spaced.tokens);
});

test("model identifiers survive normalization in both spellings", () => {
  const hyphenated = extractProductTextFeatures("Sony WH-1000XM5 Headphones");
  const compact = extractProductTextFeatures("Sony WH1000XM5 Headphones");

  assert.ok(hyphenated.tokens.includes("wh1000xm5"));
  assert.deepEqual(hyphenated.identifiers, ["wh1000xm5"]);
  assert.deepEqual(hyphenated.identifiers, compact.identifiers);
  assert.deepEqual(hyphenated.tokens, compact.tokens);
});

test("tokenizeTitle keeps interior structure of hyphenated words", () => {
  const tokens = tokenizeTitle(normalizeTitle("USB-C Cable HD-800"));
  assert.ok(tokens.includes("usb-c"));
  assert.ok(tokens.includes("hd800"));
});

test("extractUnitValues handles attached, spaced and aliased units", () => {
  assert.deepEqual(extractProductTextFeatures("Bottle 500ml").units, [
    { value: 500, unit: "ml", raw: "500 ml" },
  ]);
  assert.deepEqual(extractProductTextFeatures("Battery 5000 mAh").units, [
    { value: 5000, unit: "mah", raw: "5000 mah" },
  ]);
  assert.deepEqual(extractProductTextFeatures("Bag 2 liters").units, [
    { value: 2, unit: "l", raw: "2 liter" },
  ]);
});

test("extractQuantities reads counts in both orders", () => {
  assert.deepEqual(extractProductTextFeatures("USB Cable 3 pack").quantities, [3]);
  assert.deepEqual(extractProductTextFeatures("USB Cable pack of 12").quantities, [12]);
  assert.deepEqual(extractProductTextFeatures("Resistors 100pcs").quantities, [100]);
});

test("detectBrand identifies a single lexicon brand and refuses to guess", () => {
  assert.equal(extractProductTextFeatures("Sony WH-1000XM5").brand, "sony");
  assert.equal(extractProductTextFeatures("Generic Wireless Earbuds").brand, null);
  // Two known brands is ambiguous, not a guess.
  assert.equal(extractProductTextFeatures("Apple USB-C to Sony adapter").brand, null);
  // Whole-token matching: "pineapple" must not register as "apple".
  assert.equal(extractProductTextFeatures("Pineapple Slicer").brand, null);
});

test("stopwords are dropped but numbers and units are not", () => {
  const features = extractProductTextFeatures("The 20oz Mug with a Lid");
  assert.ok(features.tokens.includes("20"));
  assert.ok(features.tokens.includes("oz"));
  assert.ok(features.tokens.includes("mug"));
  assert.ok(!features.tokens.includes("the"));
  assert.ok(!features.tokens.includes("with"));
});

test("light plural handling makes earbuds and earbud comparable", () => {
  const plural = extractProductTextFeatures("Wireless Earbuds");
  const singular = extractProductTextFeatures("Wireless Earbud");
  assert.deepEqual(plural.tokens, singular.tokens);
});

test("identifiers exclude pure numbers and measurement tokens", () => {
  const features = extractProductTextFeatures("Mug 500ml 3 pack");
  assert.deepEqual(features.identifiers, []);
});

test("a title with no usable text yields empty features", () => {
  const features = extractProductTextFeatures("   ");
  assert.equal(features.normalized, "");
  assert.deepEqual(features.tokens, []);
  assert.deepEqual(features.identifiers, []);
  assert.deepEqual(features.units, []);
  assert.equal(features.brand, null);
});
