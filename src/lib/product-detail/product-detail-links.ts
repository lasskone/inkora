/**
 * Deep links into Product Detail (docs/ARCHITECTURE.md §18).
 *
 * Pure string handling only — no I/O, no `server-only` — so the same builder
 * serves the product scanner, the seller scanner, the watchlist rows and the
 * page itself, and is unit-testable from fixtures.
 */

import {
  MAX_QUERY_LENGTH,
  validateProductDetailRequest,
} from "@/lib/product-detail/product-detail-validation";

/**
 * Builds the href for one product's opportunity detail.
 *
 * The item id and the replay query are always carried: without the query the
 * server cannot replay the search window a refresh needs, so a link that omits
 * it would build a page whose refresh can only refuse. The supplier id is
 * optional and narrows the scope to one pairing.
 *
 * Every value is encoded and then re-validated by the boundary, so a crafted
 * href can never smuggle a longer or malformed string past the validators.
 */
export function productDetailHref(params: {
  itemId: string;
  query: string;
  supplierProductId?: string | null;
}): string {
  const search = new URLSearchParams();
  search.set("q", params.query.slice(0, MAX_QUERY_LENGTH));
  if (params.supplierProductId) {
    search.set("supplierProductId", params.supplierProductId);
  }
  return `/products/${encodeURIComponent(params.itemId)}?${search.toString()}`;
}

/**
 * Reads the query parameters the page itself consumes, refusing anything the
 * boundary would refuse. The item id comes from the route path, not the query
 * string; returns `null` when the request is not usable at all, so the page can
 * render its honest invalid state instead of guessing a scope.
 */
export function productDetailPageParams(params: {
  itemId: string;
  /** `useSearchParams()` in a client component, or a plain `URLSearchParams`. */
  searchParams: { get: (name: string) => string | null };
}): {
  query: string;
  supplierProductId: string | null;
  destinationCountry: string | null;
} | null {
  const validation = validateProductDetailRequest({
    itemId: params.itemId,
    query: params.searchParams.get("q") ?? params.searchParams.get("query"),
    supplierProductId: params.searchParams.get("supplierProductId"),
    destinationCountry: params.searchParams.get("destinationCountry"),
  });
  if (validation.status === "invalid") {
    return null;
  }
  return {
    query: validation.request.query,
    supplierProductId: validation.request.supplierProductId,
    destinationCountry: validation.request.destinationCountry,
  };
}

/**
 * Decodes one `[itemId]` route segment into the id the boundary validates.
 *
 * `productDetailHref` percent-encodes the id (eBay's are composite, e.g.
 * `v1|265983500898|0`, and `|` is a reserved character), and Next hands the
 * segment to a *page* still encoded while a *route handler* receives it
 * decoded — so the page would otherwise reject every deep link into Product
 * Detail on a charset technicality. This is decoded once, at the edge, and the
 * result is validated afterwards.
 *
 * The accepted charset contains no `%`, so this is unambiguous: an id that
 * arrives decoded is unchanged, and one that arrives encoded becomes the id the
 * link was built from. A malformed sequence is left alone, so the boundary
 * reports the request instead of throwing on it.
 */
export function decodeRouteItemId(raw: string): string {
  if (!raw.includes("%")) {
    return raw;
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
