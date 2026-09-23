"use client";

import Image from "next/image";
import { useState, type FormEvent } from "react";

import type { MarketplaceProduct } from "@/lib/marketplace/types";
import type { MatchCandidate } from "@/lib/matcher/types";
import type { HistoryEvidenceSummary } from "@/lib/opportunity/types";
import {
  SCANNER_DISCOVERY_LIMIT,
  SCANNER_MAX_EVALUATIONS,
} from "@/lib/scanner/limits";
import type {
  ScanItem,
  ScanMode,
  ScanResult,
} from "@/lib/scanner/types";
import type {
  ScannerErrorCode,
  ScannerErrorResponse,
  ScannerSuccessResponse,
} from "@/types/scanner";
import type {
  MarketplaceSearchErrorCode,
  MarketplaceSearchErrorResponse,
  MarketplaceSearchSuccessResponse,
} from "@/types/marketplace-search";
import { EconomicsPanel, formatMoney } from "./product-scanner";

/**
 * Opportunity Scanner — the Product Scanner's opportunity mode
 * (docs/MVP_SPEC.md §4.2, docs/ARCHITECTURE.md §15).
 *
 * One user action turns a search window into a ranked, explainable set of
 * opportunities. Everything here renders server-produced verdicts; the browser
 * never computes a score, a fee, or a profit figure, and it never posts a
 * product object or a candidate — only the ids it selected and the query it
 * searched (docs/ARCHITECTURE.md §15.1).
 */

const SCAN_ENDPOINT = "/api/scanner/scan";
const SEARCH_ENDPOINT = "/api/marketplaces/ebay/search";
const SUGGESTED_QUERY = "wireless earbuds";

type SearchStatus = "idle" | "loading" | "error" | "empty" | "results";
type ScanStatus = "idle" | "loading" | "error" | "partial" | "ready";

const SCAN_ERROR_COPY: Record<ScannerErrorCode, string> = {
  INVALID_QUERY: "Enter a search term of 1–100 characters.",
  INVALID_MODE: "That scan mode is not supported.",
  ITEMS_REQUIRED: "Select at least one listing from the results to scan it.",
  INVALID_ITEM_ID: "One of the selected listings could not be identified.",
  TOO_MANY_ITEMS: `A single scan evaluates at most ${SCANNER_MAX_EVALUATIONS} listings. Select fewer.`,
  ITEM_NOT_RESOLVED:
    "None of the selected listings are still in the current search results. Re-run the search, then try again.",
  INVALID_DESTINATION: "The destination country code must be two letters.",
  DISCOVERY_FAILED: "The marketplace search backing this scan could not be completed. Try again.",
  EBAY_NOT_CONFIGURED:
    "eBay search is not configured on this server yet. Add the eBay environment variables and restart.",
  EBAY_AUTH_FAILED:
    "The server could not authenticate with eBay. The credentials or the environment may be wrong.",
  EBAY_UPSTREAM_ERROR: "eBay could not complete the search just now. Try again.",
  EBAY_RATE_LIMITED: "eBay is rate-limiting this application. Wait a moment, then retry.",
  CJ_NOT_CONFIGURED:
    "CJdropshipping is not configured on this server, so no opportunity can be assessed.",
  CJ_AUTH_FAILED: "The server could not authenticate with CJdropshipping during this scan.",
  CJ_UPSTREAM_ERROR: "CJdropshipping could not complete part of this scan. Results may be partial.",
  CJ_RATE_LIMITED: "CJdropshipping is rate-limiting this application. Wait a moment, then retry.",
  INTERNAL_ERROR: "Something went wrong during this scan. Please try again.",
  MALFORMED_BODY: "The scan request could not be understood. Reload the page and try again.",
};

const SEARCH_ERROR_COPY: Record<MarketplaceSearchErrorCode, string> = {
  INVALID_QUERY: "Enter a search term of 1–100 characters.",
  INVALID_LIMIT: "The requested result limit is not valid.",
  EBAY_NOT_CONFIGURED:
    "eBay search is not configured on this server yet. Add the eBay environment variables and restart.",
  EBAY_AUTH_FAILED:
    "The server could not authenticate with eBay. The credentials or the environment may be wrong.",
  EBAY_UPSTREAM_ERROR: "eBay could not complete the search just now. Try again.",
  EBAY_RATE_LIMITED: "eBay is rate-limiting this application. Wait a moment, then retry.",
  INTERNAL_ERROR: "Something went wrong while searching. Please try again.",
};

const BAND_TONE: Record<string, string> = {
  HIGH: "border-green-600 text-green-700",
  MEDIUM: "border-amber-600 text-amber-700",
  LOW: "border-red-600 text-red-700",
};

const CONFIDENCE_TONE: Record<string, string> = {
  HIGH: "border-green-600 text-green-700",
  MEDIUM: "border-amber-600 text-amber-700",
  LOW: "border-red-600 text-red-700",
  INSUFFICIENT: "border-border text-muted",
};

const OUTCOME_COPY: Record<ScanItem["outcome"], string> = {
  evaluated: "Assessed — matched and costed",
  "no-candidates": "Assessed — no supplier candidate found",
  "economics-unavailable": "Assessed — economics unavailable",
  "item-not-found": "No longer in the current search results",
  "upstream-error": "Could not be evaluated (upstream failure)",
  timeout: "Skipped — the scan's time budget elapsed",
};

const MATCH_BAND_COPY: Record<MatchCandidate["confidenceBand"], string> = {
  LOW: "Low confidence — likely a related but different product",
  MEDIUM: "Medium confidence — plausible candidate, verify before relying on it",
  HIGH: "High confidence — strong textual correspondence, not a guarantee",
};

export function OpportunityScanner() {
  const [query, setQuery] = useState("");
  const [searchStatus, setSearchStatus] = useState<SearchStatus>("idle");
  const [searchErrorCode, setSearchSearchErrorCode] =
    useState<MarketplaceSearchErrorCode | null>(null);
  const [products, setProducts] = useState<MarketplaceProduct[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  /** The term that produced the current results; the scan replays it server-side. */
  const [searchedQuery, setSearchedQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [scanStatus, setScanStatus] = useState<ScanStatus>("idle");
  const [scanErrorCode, setScanErrorCode] = useState<ScannerErrorCode | null>(null);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);

  async function runSearch(searchTerm: string) {
    setSearchStatus("loading");
    setSearchSearchErrorCode(null);
    setScanStatus("idle");
    setScanResult(null);
    setSelectedIds(new Set());

    try {
      const response = await fetch(
        `${SEARCH_ENDPOINT}?q=${encodeURIComponent(searchTerm)}`,
        { cache: "no-store" },
      );
      const payload = (await response.json()) as
        | MarketplaceSearchSuccessResponse
        | MarketplaceSearchErrorResponse;

      if (!response.ok || payload.status !== "ok") {
        const errorPayload = payload as MarketplaceSearchErrorResponse;
        setSearchStatus("error");
        setSearchSearchErrorCode(errorPayload.code ?? "INTERNAL_ERROR");
        return;
      }

      setProducts(payload.products);
      setTotal(payload.total);
      setSearchedQuery(payload.query);
      setSearchStatus(payload.products.length === 0 ? "empty" : "results");
    } catch {
      setSearchStatus("error");
      setSearchSearchErrorCode("INTERNAL_ERROR");
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const term = query.trim();
    if (term.length === 0) {
      return;
    }
    void runSearch(term);
  }

  function handleSuggestion() {
    setQuery(SUGGESTED_QUERY);
    void runSearch(SUGGESTED_QUERY);
  }

  function toggleSelection(externalId: string) {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(externalId)) {
        next.delete(externalId);
      } else if (next.size < SCANNER_MAX_EVALUATIONS) {
        next.add(externalId);
      }
      return next;
    });
  }

  async function runScan(mode: ScanMode) {
    if (mode === "manual" && selectedIds.size === 0) {
      return;
    }

    setScanStatus("loading");
    setScanErrorCode(null);
    setScanResult(null);

    const body: Record<string, unknown> = { query: searchedQuery, mode };
    if (mode === "manual") {
      body.itemIds = Array.from(selectedIds);
    }

    try {
      const response = await fetch(SCAN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      const payload = (await response.json()) as
        | ScannerSuccessResponse
        | ScannerErrorResponse;

      if (!response.ok || payload.status === "error") {
        const errorPayload = payload as ScannerErrorResponse;
        setScanStatus("error");
        setScanErrorCode(errorPayload.code ?? "INTERNAL_ERROR");
        return;
      }

      const success = payload as ScannerSuccessResponse;
      setScanResult(success);
      setScanStatus(success.status === "partial" ? "partial" : "ready");
    } catch {
      setScanStatus("error");
      setScanErrorCode("INTERNAL_ERROR");
    }
  }

  const isSearching = searchStatus === "loading";
  const isScanning = scanStatus === "loading";
  const selectionFull = selectedIds.size >= SCANNER_MAX_EVALUATIONS;


  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h2 className="text-xl font-semibold tracking-tight">
            Opportunity Scanner
          </h2>
          <p className="text-muted max-w-2xl">
            Search eBay, pick the listings worth costing, and the server
            deep-evaluates a bounded batch — matching each against CJdropshipping,
            computing landed-cost economics, and scoring it through the
            Opportunity Engine. Results are ranked by score, with evidence
            confidence shown separately. The browser never posts a price or a
            candidate, only the ids it selected.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row">
          <input
            type="search"
            name="q"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="e.g. wireless earbuds"
            maxLength={100}
            disabled={isSearching}
            aria-label="Search eBay listings"
            className="flex-1 rounded-md border border-border bg-surface px-4 py-2.5 text-sm outline-none placeholder:text-muted focus:border-foreground disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={isSearching}
            className="inline-flex items-center justify-center rounded-md border border-border bg-surface px-5 py-2.5 text-sm font-medium hover:bg-background disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSearching ? "Searching…" : "Search"}
          </button>
        </form>

        {searchStatus === "idle" && (
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

        {searchStatus === "loading" && (
          <p className="text-sm text-muted" role="status">
            Searching eBay for &ldquo;{query.trim()}&rdquo;…
          </p>
        )}

        {searchStatus === "error" && searchErrorCode !== null && (
          <div
            role="alert"
            className="rounded-md border border-border bg-surface px-4 py-3 text-sm text-foreground"
          >
            {SEARCH_ERROR_COPY[searchErrorCode]}
          </div>
        )}

        {searchStatus === "empty" && (
          <p className="text-sm text-muted">
            No eBay listings found for &ldquo;{query.trim()}&rdquo;. Try a
            different or broader keyword.
          </p>
        )}

        {searchStatus === "results" && (
          <p className="text-sm text-muted">
            Showing {products.length}
            {total !== null ? ` of ${total}` : ""} eBay listings. Select up to{" "}
            {SCANNER_MAX_EVALUATIONS} to scan, or scan the top{" "}
            {SCANNER_MAX_EVALUATIONS} of this window.
          </p>
        )}
      </section>

      {searchStatus === "results" && (
        <section aria-label="Scan controls" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void runScan("manual")}
              disabled={isScanning || selectedIds.size === 0}
              className="inline-flex items-center justify-center rounded-md border border-border bg-foreground px-5 py-2.5 text-sm font-medium text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isScanning ? "Scanning…" : `Scan selected (${selectedIds.size})`}
            </button>
            <button
              type="button"
              onClick={() => void runScan("batch")}
              disabled={isScanning}
              className="inline-flex items-center justify-center rounded-md border border-border bg-surface px-5 py-2.5 text-sm font-medium hover:bg-background disabled:cursor-not-allowed disabled:opacity-60"
            >
              Scan top {SCANNER_MAX_EVALUATIONS}
            </button>
            {selectionFull && (
              <span className="text-xs text-muted">
                Selection limit reached — deselect a listing to pick another.
              </span>
            )}
          </div>

          {scanStatus === "loading" && (
            <p className="text-sm text-muted" role="status">
              Deep-evaluating a bounded batch (up to {SCANNER_MAX_EVALUATIONS}{" "}
              listings, {SCANNER_DISCOVERY_LIMIT} results searched). This can
              take a while…
            </p>
          )}

          {scanStatus === "error" && scanErrorCode !== null && (
            <div
              role="alert"
              className="rounded-md border border-border bg-surface px-4 py-3 text-sm text-foreground"
            >
              {SCAN_ERROR_COPY[scanErrorCode]}
            </div>
          )}

          {scanResult !== null && (
            <ScanSummary result={scanResult} partial={scanStatus === "partial"} />
          )}
        </section>
      )}


      {searchStatus === "results" && (
        <section aria-label="Discovery results">
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((product) => (
              <li key={`${product.marketplace}-${product.externalId}`}>
                <PickerCard
                  product={product}
                  selected={selectedIds.has(product.externalId)}
                  selectionFull={selectionFull}
                  onToggle={() => toggleSelection(product.externalId)}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {scanResult !== null && (
        <section aria-label="Ranked opportunities" className="flex flex-col gap-4">
          <h3 className="text-lg font-semibold tracking-tight">
            Ranked opportunities
          </h3>
          {scanResult.results.length === 0 ? (
            <p className="text-sm text-muted">
              No listing produced an assessment. See the failures below for why.
            </p>
          ) : (
            <ul className="flex flex-col gap-4">
              {scanResult.results.map((item, index) => (
                <li
                  key={`result-${
                    item.marketplaceProduct?.externalId ?? item.requestedItemId ?? index
                  }`}
                >
                  <OpportunityCard item={item} rank={index + 1} />
                </li>
              ))}
            </ul>
          )}

          {scanResult.failures.length > 0 && (
            <div className="flex flex-col gap-3">
              <h4 className="text-sm font-semibold uppercase tracking-wide text-muted">
                Could not assess ({scanResult.failures.length})
              </h4>
              <ul className="flex flex-col gap-2">
                {scanResult.failures.map((item, index) => (
                  <li
                    key={`failure-${
                      item.marketplaceProduct?.externalId ??
                      item.requestedItemId ??
                      index
                    }`}
                  >
                    <FailureRow item={item} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </div>
  );
}


function ScanSummary({ result, partial }: { result: ScanResult; partial: boolean }) {
  const { meta } = result;
  return (
    <div
      className={`flex flex-col gap-2 rounded-md border px-4 py-3 text-sm ${
        partial
          ? "border-amber-600 bg-surface text-foreground"
          : "border-border bg-surface text-foreground"
      }`}
    >
      <p className="font-medium">
        {partial ? "Scan complete with some failures." : "Scan complete."}{" "}
        <span className="text-muted font-normal">
          {meta.evaluatedCount} assessed · {meta.failedCount} failed ·{" "}
          {meta.selectedCount} selected from {meta.discoveryCount} results ·{" "}
          {(meta.durationMs / 1000).toFixed(1)}s · {meta.destinationLabel}.
        </span>
      </p>
      <p className="text-xs text-muted">
        Mode {meta.mode} · ranked by Opportunity Engine score ({meta.scannerVersion})
        · budget: {meta.limits.maxEvaluations} listings at concurrency{" "}
        {meta.limits.concurrency}, deadline {(meta.limits.deadlineMs / 1000).toFixed(0)}s.
      </p>
    </div>
  );
}

function PickerCard({
  product,
  selected,
  selectionFull,
  onToggle,
}: {
  product: MarketplaceProduct;
  selected: boolean;
  selectionFull: boolean;
  onToggle: () => void;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const disabled = !selected && selectionFull;

  return (
    <article
      className={`flex h-full flex-col overflow-hidden rounded-lg border bg-surface ${
        selected ? "border-foreground" : "border-border"
      }`}
    >
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
        <h3 className="line-clamp-2 text-sm font-medium leading-snug">
          {product.title}
        </h3>

        <div className="flex items-baseline justify-between gap-2 text-sm">
          {product.price !== null ? (
            <span className="font-semibold">
              {formatMoney(product.price, product.currency)}
            </span>
          ) : (
            <span className="italic text-muted">price unavailable</span>
          )}
          {product.shippingCost !== null && (
            <span className="text-xs text-muted">
              + {formatMoney(product.shippingCost, product.shippingCurrency)} shipping
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={onToggle}
          disabled={disabled}
          aria-pressed={selected}
          className="mt-auto inline-flex items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-xs font-medium hover:bg-background disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-sm border ${
              selected
                ? "border-foreground bg-foreground"
                : "border-border bg-background"
            }`}
            aria-hidden
          />
          {selected ? "Selected" : disabled ? "Limit reached" : "Select"}
        </button>
      </div>
    </article>
  );
}

function FailureRow({ item }: { item: ScanItem }) {
  const title = item.marketplaceProduct?.title ?? item.requestedItemId ?? "Unknown listing";
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-surface px-3 py-2.5 text-xs">
      <div className="flex items-baseline justify-between gap-2">
        <span className="line-clamp-1 font-medium text-foreground">{title}</span>
        <span className="shrink-0 rounded border border-red-600 px-1.5 py-0.5 font-medium uppercase text-red-700">
          {item.outcome}
        </span>
      </div>
      <p className="text-muted">
        {item.failureMessage ?? OUTCOME_COPY[item.outcome]}
        {item.marketplaceProduct === null && item.requestedItemId !== undefined && (
          <> · id {item.requestedItemId}</>
        )}
      </p>
    </div>
  );
}


function OpportunityCard({ item, rank }: { item: ScanItem; rank: number }) {
  const [showEconomics, setShowEconomics] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  const assessment = item.assessment;
  if (assessment === null) {
    return <FailureRow item={item} />;
  }

  const product = item.marketplaceProduct;
  const candidate = item.candidate;
  const negativeProfit =
    item.economics?.estimatedProfit !== null &&
    item.economics?.estimatedProfit !== undefined &&
    Number(item.economics.estimatedProfit) < 0;

  return (
    <article className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4">
      {/* --- Verdict: score and confidence, both prominent -------------- */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex h-9 min-w-9 items-center justify-center rounded-md border border-border bg-background px-2 text-sm font-semibold">
          #{rank}
        </span>
        <span
          className={`rounded-md border px-3 py-1.5 text-lg font-semibold ${
            BAND_TONE[assessment.band] ?? "border-border text-foreground"
          }`}
        >
          {assessment.score}/100
        </span>
        <span
          className={`rounded-md border px-2.5 py-1 text-sm font-medium ${
            CONFIDENCE_TONE[assessment.confidenceLevel] ??
            "border-border text-foreground"
          }`}
          title="Confidence is computed independently from the score: it says how much the evidence supports the verdict, not how good the opportunity is."
        >
          confidence {assessment.confidence}/100 · {assessment.confidenceLevel}
        </span>
        <span className="text-xs text-muted">{assessment.headline}</span>
      </div>

      <p className="text-[11px] text-muted">
        Score and confidence are separate numbers. The score is attractiveness
        under the current model; the confidence is how much evidence supports it.
        A high margin over weak evidence never looks equivalent to the same margin
        over strong evidence.
      </p>

      {/* --- The comparison itself ------------------------------------ */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-2 rounded-md border border-border bg-background p-3">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted">
            eBay listing
          </span>
          <div className="flex gap-3">
            <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded border border-border bg-surface">
              {product?.imageUrl && !imageFailed ? (
                <Image
                  src={product.imageUrl}
                  alt={product.title}
                  fill
                  sizes="64px"
                  className="object-contain p-1"
                  onError={() => setImageFailed(true)}
                />
              ) : (
                <span className="flex h-full items-center justify-center text-[9px] text-muted">
                  No image
                </span>
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              {product?.listingUrl ? (
                <a
                  href={product.listingUrl}
                  target="_blank"
                  rel="nofollow noopener noreferrer"
                  className="line-clamp-2 text-sm font-medium leading-snug hover:underline"
                >
                  {product.title}
                </a>
              ) : (
                <span className="line-clamp-2 text-sm font-medium leading-snug">
                  {product?.title ?? "Unknown listing"}
                </span>
              )}
              <span className="text-sm font-semibold">
                {product?.price !== null && product?.price !== undefined
                  ? formatMoney(product.price, product.currency)
                  : "price unavailable"}
              </span>
              {product?.sellerName !== null && product?.sellerName !== undefined && (
                <span className="text-xs text-muted">seller {product.sellerName}</span>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2 rounded-md border border-border bg-background p-3">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted">
            CJdropshipping candidate
          </span>
          {candidate === null ? (
            <p className="text-xs text-muted">
              No supplier candidate was found. The assessment is a verdict about
              the listing, hard-capped at LOW — not an error.
            </p>
          ) : (
            <div className="flex min-w-0 flex-col gap-1">
              <span className="line-clamp-2 text-sm font-medium leading-snug">
                {candidate.supplierProduct.title}
              </span>
              <span className="text-sm font-semibold">
                {candidate.supplierProduct.supplierPrice !== null
                  ? formatMoney(
                      candidate.supplierProduct.supplierPrice,
                      candidate.supplierProduct.currency,
                    )
                  : "cost unavailable"}
              </span>
              <span
                className="text-xs text-muted"
                title={MATCH_BAND_COPY[candidate.confidenceBand]}
              >
                match {candidate.confidence}/100 · {candidate.confidenceBand} —{" "}
                {MATCH_BAND_COPY[candidate.confidenceBand]}
              </span>
            </div>
          )}
        </div>
      </div>


      {/* --- Economics headline + disclosure --------------------------- */}
      {item.economics !== null ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-3 text-sm">
            {item.economics.estimatedProfit !== null ? (
              <span
                className={`text-base font-semibold ${
                  negativeProfit ? "text-red-700" : ""
                }`}
              >
                {negativeProfit ? "Loss" : "Profit"}{" "}
                {formatMoney(
                  item.economics.estimatedProfit.replace("-", ""),
                  item.economics.currency,
                )}
              </span>
            ) : (
              <span className="font-medium italic text-muted">
                profit not computable
              </span>
            )}
            {item.economics.marginPercent !== null && (
              <span className="font-medium">
                {item.economics.marginPercent}% margin
              </span>
            )}
            <span
              className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase ${
                BAND_TONE[
                  item.economics.completeness === "COMPLETE"
                    ? "HIGH"
                    : item.economics.completeness === "PARTIAL"
                      ? "MEDIUM"
                      : "LOW"
                ] ?? "border-border text-muted"
              }`}
            >
              economics {item.economics.completeness}
            </span>
            {item.failureMessage !== undefined && (
              <span className="text-xs text-muted">
                quote issue: {item.failureMessage}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setShowEconomics((previous) => !previous)}
            aria-expanded={showEconomics}
            className="self-start text-xs font-medium text-foreground underline underline-offset-2 hover:no-underline"
          >
            {showEconomics ? "Hide full economics" : "Show full economics"}
          </button>
          {showEconomics && (
            <EconomicsPanel
              economics={item.economics}
              matchConfidenceBand={candidate?.confidenceBand ?? null}
            />
          )}
        </div>
      ) : (
        <p className="text-xs text-muted">
          Economics could not be computed for this candidate, so the assessment
          carries an UNAVAILABLE economics component.
        </p>
      )}

      {item.history !== null && <HistoryBadges history={item.history} />}

      {item.persistence !== undefined && (
        <p className="text-[11px] text-muted">
          {item.persistence.status === "ok"
            ? item.persistence.inserted
              ? "Assessment persisted as a new observation."
              : "Assessment unchanged since last time — existing observation reused."
            : item.persistence.status === "disabled"
              ? "Persistence is not configured on this server, so this assessment was not stored."
              : `Assessment could not be persisted: ${item.persistence.message}. It is still shown here, reported honestly rather than claimed as stored.`}
        </p>
      )}


      {/* --- Reasoning ------------------------------------------------ */}
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => setShowReasoning((previous) => !previous)}
          aria-expanded={showReasoning}
          className="self-start text-xs font-medium text-foreground underline underline-offset-2 hover:no-underline"
        >
          {showReasoning ? "Hide reasoning" : "Why this score?"}
        </button>
        {showReasoning && (
          <div className="flex flex-col gap-3 rounded-md border border-border bg-background p-3">
            <ul className="flex flex-col gap-1.5 text-xs">
              {assessment.factors.map((factor, index) => (
                <li key={`factor-${factor.name}-${index}`} className="flex flex-col">
                  <span className="font-medium text-foreground">
                    {factor.label}{" "}
                    <span className="text-muted">
                      ({factor.contribution > 0 ? "+" : ""}
                      {factor.contribution})
                    </span>
                  </span>
                  <span className="text-muted">{factor.detail}</span>
                </li>
              ))}
            </ul>
            {assessment.caps.length > 0 && (
              <p className="text-xs text-muted">
                Conservative gates applied:{" "}
                {assessment.caps.map((cap) => cap.label).join(", ")}.
              </p>
            )}
            <div className="flex flex-col gap-1 text-xs">
              {assessment.explanation.map((line, index) => (
                <p key={`explanation-${index}`} className="text-muted">
                  {line}
                </p>
              ))}
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted">
                What this assessment does not mean
              </span>
              {assessment.caveats.map((caveat, index) => (
                <p key={`caveat-${index}`} className="text-[11px] italic text-muted">
                  {caveat}
                </p>
              ))}
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

function HistoryBadges({ history }: { history: HistoryEvidenceSummary }) {
  const priors = history.priorAssessments?.length ?? 0;
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
      <span className="rounded border border-border px-1.5 py-0.5">
        {history.snapshotCount} stored price snapshot{history.snapshotCount === 1 ? "" : "s"}
      </span>
      {priors > 0 && (
        <span className="rounded border border-border px-1.5 py-0.5">
          {priors} prior assessment{priors === 1 ? "" : "s"}
        </span>
      )}
      <span>
        History is read as observations from moments in time — nothing here is a
        forecast.
      </span>
    </div>
  );
}

