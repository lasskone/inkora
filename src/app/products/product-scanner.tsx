"use client";

import Image from "next/image";
import { useState, type FormEvent } from "react";

import type { MarketplaceProduct } from "@/lib/marketplace/types";
import type { MatchCandidate } from "@/lib/matcher/types";
import type {
  EbayEnvironmentLabel,
  MarketplaceSearchErrorCode,
  MarketplaceSearchSuccessResponse,
} from "@/types/marketplace-search";
import type {
  ProductMatchErrorCode,
  ProductMatchErrorResponse,
  ProductMatchSuccessResponse,
} from "@/types/product-match";

/**
 * Product Scanner — marketplace-side discovery.
 *
 * The UI never talks to eBay directly. Every search goes through the Inkora
 * server route, which owns credentials and normalization; this component only
 * renders the already-normalized, provider-independent model.
 */

const SEARCH_ENDPOINT = "/api/marketplaces/ebay/search";
const MATCH_ENDPOINT = "/api/products/matches";
const SUGGESTED_QUERY = "wireless earbuds";

type SearchStatus = "idle" | "loading" | "error" | "empty" | "results";

interface ErrorPayload {
  status?: string;
  code?: MarketplaceSearchErrorCode | ProductMatchErrorCode;
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

const MATCH_ERROR_COPY: Record<ProductMatchErrorCode, string> = {
  INVALID_ITEM_ID: "That listing could not be identified.",
  INVALID_QUERY: "The search term used to find this listing is not valid.",
  INVALID_LIMIT: "The requested candidate limit is not valid.",
  EBAY_NOT_CONFIGURED:
    "eBay search is not configured on this server, so the listing cannot be re-resolved.",
  EBAY_AUTH_FAILED:
    "The server could not authenticate with eBay while re-resolving this listing.",
  EBAY_UPSTREAM_ERROR: "eBay could not re-resolve this listing just now.",
  EBAY_RATE_LIMITED:
    "eBay is rate-limiting this application. Try again shortly.",
  ITEM_NOT_RESOLVED:
    "This listing is no longer in the current search results. Re-run the search, then try again.",
  CJ_NOT_CONFIGURED:
    "CJdropshipping is not configured on this server, so no supplier candidates can be found.",
  CJ_AUTH_FAILED:
    "The server could not authenticate with CJdropshipping while searching for candidates.",
  CJ_UPSTREAM_ERROR:
    "CJdropshipping could not complete the search just now. Try again.",
  CJ_RATE_LIMITED:
    "CJdropshipping is rate-limiting this application. Wait a moment, then retry.",
  INTERNAL_ERROR:
    "Something went wrong while looking for supplier candidates. Please try again.",
};

const BAND_COPY: Record<MatchCandidate["confidenceBand"], string> = {
  LOW: "Low confidence — likely a related but different product",
  MEDIUM: "Medium confidence — plausible candidate, verify before relying on it",
  HIGH: "High confidence — strong textual correspondence, not a guarantee",
};

const INVENTORY_COPY: Record<
  NonNullable<MatchCandidate["usWarehouseInventory"]>,
  string
> = {
  CONFIRMED_AVAILABLE: "US warehouse: in stock",
  CONFIRMED_NONE: "US warehouse: none confirmed",
  UNKNOWN: "US warehouse: unknown",
};

type MatchStatus = "idle" | "loading" | "error" | "ready";

interface MatchState {
  itemId: string;
  status: MatchStatus;
  result?: ProductMatchSuccessResponse;
  errorCode?: ProductMatchErrorCode;
}

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
  // The term that produced the current results; the matcher needs it to
  // re-resolve the listing server-side.
  const [searchedQuery, setSearchedQuery] = useState("");
  const [match, setMatch] = useState<MatchState | null>(null);

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
        // The eBay search route can only emit marketplace error codes.
        setErrorCode(
          ((payload as ErrorPayload).code ?? "INTERNAL_ERROR") as MarketplaceSearchErrorCode,
        );
        setStatus("error");
        return;
      }

      const success = payload as MarketplaceSearchSuccessResponse;
      setEnvironment(success.environment);
      setTotal(success.total);
      setProducts(success.products);
      setSearchedQuery(searchTerm);
      setMatch(null);
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

  async function runMatch(product: MarketplaceProduct) {
    setMatch({ itemId: product.externalId, status: "loading" });

    const params = new URLSearchParams({
      itemId: product.externalId,
      q: searchedQuery,
    });

    try {
      const response = await fetch(`${MATCH_ENDPOINT}?${params.toString()}`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as
        | ProductMatchSuccessResponse
        | ProductMatchErrorResponse;

      if (!response.ok || payload.status !== "ok") {
        const errorPayload = payload as ProductMatchErrorResponse;
        setMatch({
          itemId: product.externalId,
          status: "error",
          errorCode: errorPayload.code ?? "INTERNAL_ERROR",
        });
        return;
      }

      setMatch({
        itemId: product.externalId,
        status: "ready",
        result: payload as ProductMatchSuccessResponse,
      });
    } catch {
      setMatch({
        itemId: product.externalId,
        status: "error",
        errorCode: "INTERNAL_ERROR",
      });
    }
  }

  function matchStatusFor(itemId: string): MatchStatus {
    return match && match.itemId === itemId ? match.status : "idle";
  }

  function closeMatch() {
    setMatch(null);
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
        <section aria-label="Supplier candidates">
          {match && (
            <SupplierMatchPanel
              state={match}
              onClose={closeMatch}
            />
          )}
        </section>
      )}

      {status === "results" && (
        <section aria-label="Search results">
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((product) => (
              <li key={`${product.marketplace}-${product.externalId}`}>
                <ProductCard
                  product={product}
                  matchStatus={matchStatusFor(product.externalId)}
                  onFindSupplier={() => runMatch(product)}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

interface ProductCardProps {
  product: MarketplaceProduct;
  matchStatus: MatchStatus;
  onFindSupplier: () => void;
}

function ProductCard({ product, matchStatus, onFindSupplier }: ProductCardProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const isMatching = matchStatus === "loading";

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

        <button
          type="button"
          onClick={onFindSupplier}
          disabled={isMatching}
          aria-busy={isMatching}
          className="inline-flex items-center justify-center rounded-md border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-surface disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isMatching ? "Searching suppliers…" : "Find supplier"}
        </button>

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

function SupplierMatchPanel({
  state,
  onClose,
}: {
  state: MatchState;
  onClose: () => void;
}) {
  if (state.status === "loading") {
    return (
      <div
        role="status"
        className="rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted"
      >
        Searching CJdropshipping for supplier candidates…
      </div>
    );
  }

  if (state.status === "error" || !state.result) {
    const code = state.errorCode ?? "INTERNAL_ERROR";
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface px-4 py-4">
        <div role="alert" className="text-sm text-foreground">
          {MATCH_ERROR_COPY[code]}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="self-start text-xs font-medium text-muted underline underline-offset-2 hover:no-underline"
        >
          Dismiss
        </button>
      </div>
    );
  }

  const { result } = state;
  const marketplace = result.marketplaceProduct;

  return (
    <div className="flex flex-col gap-5 rounded-lg border border-border bg-surface px-4 py-5 sm:px-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">
            Supplier candidates
          </h2>
          <p className="text-xs text-muted">
            Ranked by deterministic text matching. Confidence is estimated by
            Inkora — it is not an eBay or CJdropshipping fact.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 text-xs font-medium text-muted underline underline-offset-2 hover:no-underline"
        >
          Close
        </button>
      </div>

      <div className="flex gap-4 border-b border-border pb-4">
        <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-md border border-border bg-background">
          {marketplace.imageUrl ? (
            <Image
              src={marketplace.imageUrl}
              alt={marketplace.title}
              fill
              sizes="96px"
              className="object-contain p-2"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-[10px] text-muted">
              No image
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="text-[11px] uppercase tracking-wide text-muted">
            eBay listing
          </div>
          {marketplace.listingUrl ? (
            <a
              href={marketplace.listingUrl}
              target="_blank"
              rel="nofollow noopener noreferrer"
              className="line-clamp-2 text-sm font-medium hover:underline"
            >
              {marketplace.title}
            </a>
          ) : (
            <div className="line-clamp-2 text-sm font-medium">
              {marketplace.title}
            </div>
          )}
          <div className="text-xs text-muted">
            {marketplace.price !== null
              ? formatMoney(marketplace.price, marketplace.currency)
              : "Price not listed"}{" "}
            · Source: eBay API · {marketplace.provenance}
          </div>
        </div>
      </div>

      <div className="text-xs text-muted">
        Searched CJdropshipping for:{" "}
        {result.queries.map((entry) => entry.query).join(" · ") || "—"}
      </div>

      {result.candidates.length === 0 ? (
        <p className="text-sm text-muted">
          No CJdropshipping candidates surfaced for this listing. This is an
          honest &ldquo;no strong match&rdquo; result, not an error.
          {result.queries.some((entry) => entry.failure !== null) && (
            <> Some supplier queries failed; see below.</>
          )}
        </p>
      ) : (
        <ol className="flex flex-col gap-4">
          {result.candidates.map((candidate, index) => (
            <li key={`${candidate.supplierProduct.externalId}-${index}`}>
              <CandidateCard candidate={candidate} rank={index + 1} />
            </li>
          ))}
        </ol>
      )}

      {result.queries.some((entry) => entry.failure !== null) && (
        <div className="flex flex-col gap-1 text-xs text-muted">
          <span className="font-medium">Supplier query failures</span>
          {result.queries
            .filter((entry) => entry.failure !== null)
            .map((entry) => (
              <span key={entry.query}>
                &ldquo;{entry.query}&rdquo; — {entry.failure}
              </span>
            ))}
        </div>
      )}

      <p className="text-[11px] text-muted">
        Candidate discovery bounded to {result.limits.maxQueries} CJdropshipping
        queries, {result.limits.maxCandidates} scored candidates, and{" "}
        {result.limits.maxInventoryLookups} inventory lookups. Price is never
        used as identity evidence.
      </p>
    </div>
  );
}

function CandidateCard({
  candidate,
  rank,
}: {
  candidate: MatchCandidate;
  rank: number;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const supplier = candidate.supplierProduct;
  const showImage = supplier.imageUrl !== null && !imageFailed;

  return (
    <article className="flex flex-col gap-3 rounded-md border border-border bg-background p-4">
      <div className="flex gap-4">
        <div className="relative h-28 w-28 shrink-0 overflow-hidden rounded-md border border-border bg-surface">
          {showImage ? (
            <Image
              src={supplier.imageUrl as string}
              alt=""
              fill
              sizes="112px"
              className="object-contain p-2"
              onError={() => setImageFailed(true)}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-[10px] text-muted">
              No image
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-baseline gap-2">
            <span className="text-[11px] font-semibold text-muted">#{rank}</span>
            <span className="text-[11px] uppercase tracking-wide text-muted">
              CJdropshipping
            </span>
          </div>
          <h3 className="line-clamp-2 text-sm font-medium leading-snug">
            {supplier.title}
          </h3>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-semibold">{candidate.confidence}/100</span>
            <span
              className={`rounded border px-1.5 py-0.5 font-medium uppercase ${
                candidate.confidenceBand === "HIGH"
                  ? "border-green-600 text-green-700"
                  : candidate.confidenceBand === "MEDIUM"
                    ? "border-amber-600 text-amber-700"
                    : "border-border text-muted"
              }`}
            >
              {candidate.confidenceBand}
            </span>
            {supplier.supplierPrice !== null ? (
              <span className="text-muted">
                Supplier cost{" "}
                {formatMoney(supplier.supplierPrice, supplier.currency)}
              </span>
            ) : (
              <span className="text-muted">Supplier cost not listed</span>
            )}
            {candidate.usWarehouseInventory !== null ? (
              <span className="rounded border border-border px-1.5 py-0.5 text-muted">
                {INVENTORY_COPY[candidate.usWarehouseInventory]}
              </span>
            ) : (
              <span className="text-muted">US warehouse: not queried</span>
            )}
          </div>
        </div>
      </div>

      <p className="text-xs leading-relaxed text-foreground">
        {candidate.explanation}
      </p>

      {candidate.signals.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
            Positive signals
          </div>
          <ul className="flex flex-col gap-0.5">
            {candidate.signals.slice(0, 3).map((signal) => (
              <li key={signal.name} className="text-xs text-muted">
                <span className="font-medium text-foreground">
                  +{signal.contribution}
                </span>{" "}
                {signal.label} — {signal.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

      {candidate.contradictions.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-red-700">
            Contradictions
          </div>
          <ul className="flex flex-col gap-0.5">
            {candidate.contradictions.map((entry) => (
              <li key={entry.name} className="text-xs text-red-700/90">
                <span className="font-medium uppercase">
                  {entry.severity} cap {entry.cap}
                </span>{" "}
                {entry.label} — {entry.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-[11px] text-muted">
        {BAND_COPY[candidate.confidenceBand]} · provenance{" "}
        {candidate.confidenceProvenance}
      </p>
    </article>
  );
}

