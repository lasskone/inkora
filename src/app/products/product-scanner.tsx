"use client";

import Image from "next/image";
import { useState, type FormEvent } from "react";

import type { MarketplaceProduct } from "@/lib/marketplace/types";
import type {
  EbayEnvironmentLabel,
  MarketplaceSearchErrorCode,
  MarketplaceSearchSuccessResponse,
} from "@/types/marketplace-search";

/**
 * Product Scanner — marketplace-side discovery.
 *
 * The UI never talks to eBay directly. Every search goes through the Inkora
 * server route, which owns credentials and normalization; this component only
 * renders the already-normalized, provider-independent model.
 */

const SEARCH_ENDPOINT = "/api/marketplaces/ebay/search";
const SUGGESTED_QUERY = "wireless earbuds";

type SearchStatus = "idle" | "loading" | "error" | "empty" | "results";

interface ErrorPayload {
  status?: string;
  code?: MarketplaceSearchErrorCode;
  error?: string;
}

const ERROR_COPY: Record<MarketplaceSearchErrorCode, string> = {
  INVALID_QUERY: "Enter a search term of 1–100 characters.",
  INVALID_LIMIT: "The requested result limit is not valid.",
  EBAY_NOT_CONFIGURED:
    "eBay search is not configured on this server yet. Add the eBay environment variables and restart.",
  EBAY_AUTH_FAILED:
    "The server could not authenticate with eBay. The credentials or the environment may be wrong.",
  EBAY_UPSTREAM_ERROR:
    "eBay could not complete the search just now. Try again.",
  EBAY_RATE_LIMITED:
    "eBay is rate-limiting this application. Wait a moment, then retry.",
  INTERNAL_ERROR: "Something went wrong while searching. Please try again.",
};

export function ProductScanner() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [errorCode, setErrorCode] = useState<MarketplaceSearchErrorCode | null>(
    null,
  );
  const [products, setProducts] = useState<MarketplaceProduct[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [environment, setEnvironment] = useState<EbayEnvironmentLabel | null>(
    null,
  );

  async function runSearch(searchTerm: string) {
    setStatus("loading");
    setErrorCode(null);

    try {
      const response = await fetch(
        `${SEARCH_ENDPOINT}?q=${encodeURIComponent(searchTerm)}`,
        { cache: "no-store" },
      );
      const payload = (await response.json()) as
        | MarketplaceSearchSuccessResponse
        | ErrorPayload;

      if (!response.ok || payload.status !== "ok") {
        setErrorCode((payload as ErrorPayload).code ?? "INTERNAL_ERROR");
        setStatus("error");
        return;
      }

      const success = payload as MarketplaceSearchSuccessResponse;
      setEnvironment(success.environment);
      setTotal(success.total);
      setProducts(success.products);
      setStatus(success.products.length === 0 ? "empty" : "results");
    } catch {
      setErrorCode("INTERNAL_ERROR");
      setStatus("error");
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setErrorCode("INVALID_QUERY");
      setStatus("error");
      return;
    }
    void runSearch(trimmed);
  }

  function handleSuggestion() {
    setQuery(SUGGESTED_QUERY);
    void runSearch(SUGGESTED_QUERY);
  }

  const isLoading = status === "loading";

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            Product Scanner
          </h1>
          <p className="text-muted max-w-2xl">
            Search live eBay marketplace listings by keyword. Results come
            through the Inkora server, normalized into Inkora&apos;s marketplace
            model.
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-3 sm:flex-row"
        >
          <input
            type="search"
            name="q"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="e.g. wireless earbuds"
            maxLength={100}
            disabled={isLoading}
            aria-label="Search eBay listings"
            className="flex-1 rounded-md border border-border bg-surface px-4 py-2.5 text-sm outline-none placeholder:text-muted focus:border-foreground disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={isLoading}
            className="inline-flex items-center justify-center rounded-md border border-border bg-surface px-5 py-2.5 text-sm font-medium hover:bg-background disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading ? "Searching…" : "Search"}
          </button>
        </form>

        {status === "idle" && (
          <p className="text-sm text-muted">
            No search yet. Try{" "}
            <button
              type="button"
              onClick={handleSuggestion}
              className="font-medium text-foreground underline underline-offset-2 hover:no-underline"
            >
              {SUGGESTED_QUERY}
            </button>
            .
          </p>
        )}

        {status === "loading" && (
          <p className="text-sm text-muted" role="status">
            Searching eBay for &ldquo;{query.trim()}&rdquo;…
          </p>
        )}

        {status === "error" && errorCode !== null && (
          <div
            role="alert"
            className="rounded-md border border-border bg-surface px-4 py-3 text-sm text-foreground"
          >
            {ERROR_COPY[errorCode]}
          </div>
        )}

        {status === "empty" && (
          <p className="text-sm text-muted">
            No eBay listings found for &ldquo;{query.trim()}&rdquo;. Try a
            different or broader keyword.
          </p>
        )}

        {status === "results" && (
          <p className="text-sm text-muted">
            Showing {products.length}
            {total !== null ? ` of ${total}` : ""} eBay listings for &ldquo;
            {query.trim()}&rdquo;
            {environment ? ` · ${environment}` : ""}.
          </p>
        )}
      </section>

      {status === "results" && (
        <section aria-label="Search results">
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((product) => (
              <li key={`${product.marketplace}-${product.externalId}`}>
                <ProductCard product={product} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ProductCard({ product }: { product: MarketplaceProduct }) {
  const [imageFailed, setImageFailed] = useState(false);

  return (
    <article className="flex h-full flex-col overflow-hidden rounded-lg border border-border bg-surface">
      <div className="relative aspect-square w-full border-b border-border bg-background">
        {product.imageUrl && !imageFailed ? (
          <Image
            src={product.imageUrl}
            alt={product.title}
            fill
            sizes="(min-width: 1024px) 320px, (min-width: 640px) 45vw, 90vw"
            className="object-contain p-3"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted">
            No image
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex flex-col gap-1.5">
          {product.listingUrl ? (
            <a
              href={product.listingUrl}
              target="_blank"
              rel="nofollow noopener noreferrer"
              className="line-clamp-2 text-sm font-medium leading-snug hover:underline"
            >
              {product.title}
            </a>
          ) : (
            <h3 className="line-clamp-2 text-sm font-medium leading-snug">
              {product.title}
            </h3>
          )}

          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="rounded border border-border px-1.5 py-0.5 font-medium uppercase">
              eBay
            </span>
            {product.condition && (
              <span className="rounded border border-border px-1.5 py-0.5 uppercase">
                {product.condition}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-1 text-sm">
          <div className="flex items-baseline justify-between gap-2">
            {product.price !== null ? (
              <span className="font-semibold">
                {formatMoney(product.price, product.currency)}
              </span>
            ) : (
              <span className="text-muted">Price not listed</span>
            )}

            {product.shippingCost !== null ? (
              <span className="text-xs text-muted">
                {isZeroAmount(product.shippingCost)
                  ? "Free shipping"
                  : `+ ${formatMoney(
                      product.shippingCost,
                      product.shippingCurrency,
                    )} shipping`}
              </span>
            ) : (
              <span className="text-xs text-muted">Shipping not listed</span>
            )}
          </div>

          <div className="text-xs text-muted">
            {product.sellerName ? (
              <span>
                Seller: {product.sellerName}
                {product.sellerFeedbackPercentage !== null
                  ? ` · ${product.sellerFeedbackPercentage}% feedback`
                  : ""}
              </span>
            ) : (
              <span>Seller not listed</span>
            )}
          </div>

          {product.location && (
            <div className="text-xs text-muted">
              Located in {product.location}
            </div>
          )}
        </div>

        <div className="mt-auto pt-1 text-[11px] uppercase tracking-wide text-muted">
          Source: eBay API · {product.provenance}
        </div>
      </div>
    </article>
  );
}

function formatMoney(value: string, currency: string | null): string {
  if (currency === "USD") {
    return `$${value}`;
  }
  return currency ? `${value} ${currency}` : value;
}

function isZeroAmount(value: string): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed === 0;
}
