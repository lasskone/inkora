/**
 * Product Detail boundary validation tests (docs/ARCHITECTURE.md §18.3).
 *
 * The browser never posts intelligence values — only opaque provider ids and
 * the query it searched. These pin the contract: ids are validated structurally
 * and the surface an attacker can reach is exactly the strings validated here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ITEM_ID_PATTERN,
  MAX_QUERY_LENGTH,
  MIN_QUERY_LENGTH,
  validateProductDetailRefreshBody,
  validateProductDetailRequest,
} from "./product-detail-http";

test("a valid request with a pair scope and a destination validates", () => {
  const result = validateProductDetailRequest({
    itemId: "v1|265983500898|0",
    query: "wireless earbuds",
    supplierProductId: "cj-product-1",
    destinationCountry: "de",
  });
  assert.deepEqual(result, {
    status: "valid",
    request: {
      itemId: "v1|265983500898|0",
      query: "wireless earbuds",
      supplierProductId: "cj-product-1",
      destinationCountry: "DE",
    },
  });
});

test("a marketplace-only request has a null supplier scope, not an empty string", () => {
  const result = validateProductDetailRequest({
    itemId: "v1|1",
    query: "q",
    supplierProductId: "   ",
  });
  assert.equal(result.status, "valid");
  if (result.status === "valid") {
    assert.equal(result.request.supplierProductId, null);
    assert.equal(result.request.destinationCountry, null);
  }
});

test("an absent supplier is accepted; an empty one is treated as absent", () => {
  assert.equal(
    validateProductDetailRequest({ itemId: "v1|1", query: "q", supplierProductId: undefined })
      .status,
    "valid",
  );
});

test("an item id outside the accepted charset or length is refused", () => {
  const cases = ["", "   ", "an id with spaces", "x".repeat(61), "id/with/slashes", "id\"quote"];
  for (const itemId of cases) {
    const result = validateProductDetailRequest({ itemId, query: "q" });
    assert.equal(result.status, "invalid");
    if (result.status === "invalid") {
      assert.equal(result.code, "INVALID_ITEM_ID");
    }
  }
});

test("ITEM_ID_PATTERN admits the composite ids eBay actually returns", () => {
  assert.ok(ITEM_ID_PATTERN.test("v1|265983500898|0"));
  assert.ok(ITEM_ID_PATTERN.test("v1|265983500898"));
});

test("a query outside the accepted length is refused with INVALID_QUERY", () => {
  const tooShort = validateProductDetailRequest({ itemId: "v1|1", query: "" });
  assert.equal(tooShort.status, "invalid");
  if (tooShort.status === "invalid") {
    assert.equal(tooShort.code, "INVALID_QUERY");
  }

  const tooLong = validateProductDetailRequest({ itemId: "v1|1", query: "a".repeat(MAX_QUERY_LENGTH + 1) });
  assert.equal(tooLong.status, "invalid");
  if (tooLong.status === "invalid") {
    assert.equal(tooLong.code, "INVALID_QUERY");
  }
});

test("the accepted query bounds are the ones the route documents", () => {
  assert.equal(MIN_QUERY_LENGTH, 1);
  assert.equal(MAX_QUERY_LENGTH, 100);
});

test("a supplier id that is not a supplier product id is refused", () => {
  const result = validateProductDetailRequest({
    itemId: "v1|1",
    query: "q",
    supplierProductId: "not a supplier id",
  });
  assert.equal(result.status, "invalid");
  if (result.status === "invalid") {
    assert.equal(result.code, "INVALID_SUPPLIER_PRODUCT_ID");
  }
});

test("a destination that is not a two-letter code is refused", () => {
  for (const destinationCountry of ["D", "DEU", "Germany", "1A"]) {
    const result = validateProductDetailRequest({
      itemId: "v1|1",
      query: "q",
      destinationCountry,
    });
    assert.equal(result.status, "invalid");
    if (result.status === "invalid") {
      assert.equal(result.code, "INVALID_DESTINATION");
    }
  }
});

test("a refresh body validates the same fields as the read request", () => {
  const result = validateProductDetailRefreshBody({
    itemId: "v1|1",
    query: "q",
    supplierProductId: "cj-1",
    destinationCountry: "US",
  });
  assert.equal(result.status, "valid");
  if (result.status === "valid") {
    assert.equal(result.request.itemId, "v1|1");
    assert.equal(result.request.destinationCountry, "US");
  }
});

test("a refresh body that is not an object is refused as malformed", () => {
  assert.equal(validateProductDetailRefreshBody(null).status, "invalid");
  assert.equal(validateProductDetailRefreshBody([]).status, "invalid");
});

test("a refresh body missing the query is refused, because a refresh has nothing to replay", () => {
  const result = validateProductDetailRefreshBody({ itemId: "v1|1" });
  assert.equal(result.status, "invalid");
  if (result.status === "invalid") {
    assert.equal(result.code, "INVALID_QUERY");
  }
});
