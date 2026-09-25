/**
 * Product Detail deep-link tests (docs/ARCHITECTURE.md §18).
 *
 * Pure string handling: the same builder serves the product scanner, the seller
 * scanner, the watchlist rows and the page itself, so these pin the contract
 * every deep link in the UI relies on — the item id and the replay query are
 * always carried, and a crafted href can never smuggle a refused value through.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decodeRouteItemId,
  productDetailHref,
  productDetailPageParams,
} from "./product-detail-links";

test("a marketplace-only link carries the item id and the replay query", () => {
  assert.equal(
    productDetailHref({ itemId: "v1|265983500898|0", query: "wireless earbuds" }),
    "/products/v1%7C265983500898%7C0?q=wireless+earbuds",
  );
});

test("a pair link additionally carries the supplier product id", () => {
  assert.equal(
    productDetailHref({
      itemId: "v1|265983500898|0",
      query: "wireless earbuds",
      supplierProductId: "cj-product-1",
    }),
    "/products/v1%7C265983500898%7C0?q=wireless+earbuds&supplierProductId=cj-product-1",
  );
});

test("a null supplier product id is not added as a scope parameter", () => {
  assert.equal(
    productDetailHref({ itemId: "v1|1", query: "q", supplierProductId: null }),
    "/products/v1%7C1?q=q",
  );
});

test("a query longer than the boundary accepts is truncated, never refused", () => {
  const long = "a".repeat(200);
  const href = productDetailHref({ itemId: "v1|1", query: long });
  assert.ok(href.includes(`q=${"a".repeat(100)}`));
  assert.ok(!href.includes(`q=${"a".repeat(101)}`));
});

test("page params accept the query under either name and validate the scope", () => {
  assert.deepEqual(
    productDetailPageParams({
      itemId: "v1|1",
      searchParams: new URLSearchParams("q=wireless earbuds&supplierProductId=cj-1"),
    }),
    { query: "wireless earbuds", supplierProductId: "cj-1", destinationCountry: null },
  );
  assert.deepEqual(
    productDetailPageParams({
      itemId: "v1|1",
      searchParams: new URLSearchParams("query=legacy+name&destinationCountry=de"),
    }),
    { query: "legacy name", supplierProductId: null, destinationCountry: "DE" },
  );
});

test("page params are refused without a query, because a refresh has no window to replay", () => {
  assert.equal(
    productDetailPageParams({ itemId: "v1|1", searchParams: new URLSearchParams("") }),
    null,
  );
});

test("page params are refused when the item id is not one the boundary accepts", () => {
  assert.equal(
    productDetailPageParams({
      itemId: "not an id",
      searchParams: new URLSearchParams("q=wireless earbuds"),
    }),
    null,
  );
});

test("a route segment is decoded to the id the href was built from", () => {
  // A page receives the segment percent-encoded; the boundary charset has no
  // `%`, so decoding is unambiguous and round-trips through productDetailHref.
  assert.equal(decodeRouteItemId("v1%7C265983500898%7C0"), "v1|265983500898|0");
  assert.equal(decodeRouteItemId("v1|265983500898|0"), "v1|265983500898|0");
});

test("decoding is applied once, so an id is never re-decoded past its own form", () => {
  // `%7C` decodes to `|`, and `|` contains no `%`, so a second pass is a no-op;
  // a segment that is already an id stays exactly that id.
  assert.equal(decodeRouteItemId(decodeRouteItemId("v1%7C265983500898%7C0")), "v1|265983500898|0");
});

test("a malformed escape sequence is reported, not thrown on", () => {
  // A stray `%` that is not an escape cannot be decoded, so it is passed through
  // untouched and the boundary refuses it with a reason.
  assert.equal(decodeRouteItemId("v1%ZZ"), "v1%ZZ");
});

test("a decoded segment validates where its encoded form would not", () => {
  const search = new URLSearchParams("q=wireless earbuds");
  assert.equal(productDetailPageParams({ itemId: "v1%7C265983500898%7C0", searchParams: search }), null);
  assert.deepEqual(productDetailPageParams({ itemId: decodeRouteItemId("v1%7C265983500898%7C0"), searchParams: search }), {
    query: "wireless earbuds",
    supplierProductId: null,
    destinationCountry: null,
  });
});
