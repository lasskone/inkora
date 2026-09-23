"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { formatMoney } from "@/app/products/product-scanner";
import type {
  WatchlistArchiveSuccessResponse,
  WatchlistErrorResponse,
  WatchlistHistorySuccessResponse,
  WatchlistListSuccessResponse,
  WatchlistReEvaluateSuccessResponse,
} from "@/types/watchlist";
import type { WatchlistSortKey } from "@/lib/watchlist/sorting";
import type {
  AssessmentComparison,
  NumericDelta,
  ReEvaluationOutcome,
  WatchlistEntryDetail,
  WatchlistHistoryEntry,
} from "@/lib/watchlist/types";

/**
 * Watchlist — the monitored subset of products and opportunities
 * (docs/MVP_SPEC.md §4.3, docs/ARCHITECTURE.md §16).
 *
 * Everything on this page is either a stored observation, explicitly labeled
 * with the moment it was made, or the outcome of one user-triggered
 * re-evaluation. No figure is ever presented as the listing's present state.
 *
 * Monitoring is manual and bounded on purpose: there is no background polling
 * and no "re-evaluate all" — every refresh is a deliberate action with a
 * bounded upstream budget (docs/ARCHITECTURE.md §16.3).
 */

const LIST_ENDPOINT = "/api/watchlist";
/** One read covers the whole active watchlist; the entry cap keeps it bounded. */
const LIST_LIMIT = 50;

const SORT_OPTIONS: { value: WatchlistSortKey; label: string }[] = [
  { value: "recently-evaluated", label: "Last evaluated first" },
  { value: "score", label: "Opportunity score" },
  { value: "profit", label: "Estimated profit" },
  { value: "margin", label: "Margin" },
  { value: "confidence", label: "Confidence" },
  { value: "added", label: "Recently added" },
];

const BAND_OPTIONS = ["LOW", "MEDIUM", "HIGH"] as const;
const SUPPLIER_SCOPE_OPTIONS = ["pair", "marketplace-only"] as const;
const PROFITABILITY_OPTIONS = ["profitable", "unprofitable"] as const;

type ListStatus = "loading" | "ready" | "empty" | "error" | "not-configured";

interface EntryAction {
  /** The latest re-evaluation response, kept on screen until the list reloads. */
  reevaluation?: WatchlistReEvaluateSuccessResponse;
  history?: WatchlistHistoryEntry[];
  historyOpen?: boolean;
  historyLoading?: boolean;
  reevaluating?: boolean;
  archiving?: boolean;
  /** Two-step archive: the first click arms it, the second commits it. */
  archiveConfirming?: boolean;
  error?: string;
}

/**
 * Renders an observation timestamp as a stable, locale-independent label, so a
 * reader can always see that a number is a point-in-time fact.
 */
function observedAt(iso: string | null): string {
  if (iso === null) {
    return "not observed yet";
  }
  return iso.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

const REEVALUATION_OUTCOME_COPY: Record<ReEvaluationOutcome, string> = {
  evaluated: "Re-evaluated — a fresh assessment was produced and persisted.",
  "no-candidates":
    "No supplier candidate found this time. Still a full, explainable verdict — the engine hard-caps it at LOW.",
  "economics-unavailable":
    "A candidate exists but no shipping quote could be obtained, so economics are UNAVAILABLE.",
  "listing-unavailable": "The listing scrolled out of the replayed search window.",
  "candidate-not-resolved":
    "The saved supplier is no longer a matcher candidate for this listing. It was never substituted; the entry is untouched.",
  "upstream-error":
    "An eBay or CJ failure the re-evaluation could not recover from. The entry and its history are untouched.",
  timeout: "The batch's wall-clock budget elapsed before this entry finished.",
  "entry-not-found": "No watchlist entry exists with this id.",
  archived: "This entry is archived; re-evaluation is refused, not implied.",
  "not-configured":
    "The server has no eBay or CJ configuration, so nothing can be re-evaluated.",
};

/** Turns a boundary error from a read into copy the reader can act on. */
function listErrorCopy(error: WatchlistErrorResponse): string {
  if (error.code === "WATCHLIST_NOT_CONFIGURED") {
    return "Watchlist storage is not configured on this server, so no watched opportunities can be read. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY and restart.";
  }
  return `${error.error} (${error.code})`;
}

export function WatchlistPanel() {
  const [entries, setEntries] = useState<WatchlistEntryDetail[]>([]);
  const [status, setStatus] = useState<ListStatus>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [archivedNote, setArchivedNote] = useState<string | null>(null);
  const [actions, setActions] = useState<Record<string, EntryAction>>({});

  const [sort, setSort] = useState<WatchlistSortKey>("recently-evaluated");
  const [band, setBand] = useState<string>("ALL");
  const [supplierScope, setSupplierScope] = useState<string>("ALL");
  const [profitability, setProfitability] = useState<string>("ALL");

  /**
   * Reads the active watchlist. The browser sends only sort and filter keys the
   * boundary recognizes; anything else is refused server-side rather than
   * silently ignored (docs/ARCHITECTURE.md §16.9).
   */
  const loadEntries = useCallback(async () => {
    setStatus("loading");
    setErrorMessage(null);

    const params = new URLSearchParams();
    params.set("limit", String(LIST_LIMIT));
    params.set("sort", sort);
    if (band !== "ALL") {
      params.set("band", band);
    }
    if (supplierScope !== "ALL") {
      params.set("supplierScope", supplierScope);
    }
    if (profitability !== "ALL") {
      params.set("profitability", profitability);
    }

    try {
      const response = await fetch(`${LIST_ENDPOINT}?${params.toString()}`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as
        | WatchlistListSuccessResponse
        | WatchlistErrorResponse;

      if (!response.ok || payload.status !== "ok") {
        const error = payload as WatchlistErrorResponse;
        setStatus(
          error.code === "WATCHLIST_NOT_CONFIGURED" ? "not-configured" : "error",
        );
        setErrorMessage(listErrorCopy(error));
        return;
      }

      const success = payload as WatchlistListSuccessResponse;
      setEntries(success.entries);
      setStatus(success.entries.length === 0 ? "empty" : "ready");
    } catch {
      setStatus("error");
      setErrorMessage("The watchlist could not be reached. Please retry.");
    }
  }, [sort, band, supplierScope, profitability]);

  /**
   * Initial read of the active watchlist, plus a re-read whenever the sort or
   * filter keys change. This is a one-shot read of an external system, so the
   * reading state has to flip before the first await: the state it sets
   * replaces the rendered entries instead of deriving from them, so there is no
   * cascading render to avoid.
   */
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadEntries();
  }, [loadEntries]);

  /**
   * The only way a watched opportunity gets fresh numbers. The browser posts no
   * supplier or pricing detail — the entry's saved scope is re-proved server-side
   * (docs/ARCHITECTURE.md §16.4).
   */
  async function reevaluateEntry(detail: WatchlistEntryDetail): Promise<void> {
    setActions((previous) => ({
      ...previous,
      [detail.entry.id]: {
        ...previous[detail.entry.id],
        reevaluating: true,
        error: undefined,
      },
    }));

    try {
      const response = await fetch(
        `${LIST_ENDPOINT}/${detail.entry.id}/re-evaluate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
          cache: "no-store",
        },
      );
      const payload = (await response.json()) as
        | WatchlistReEvaluateSuccessResponse
        | WatchlistErrorResponse;

      if (!response.ok || payload.status === "error") {
        const error = payload as WatchlistErrorResponse;
        setActions((previous) => ({
          ...previous,
          [detail.entry.id]: {
            ...previous[detail.entry.id],
            reevaluating: false,
            error: `${error.error} (${error.code})`,
          },
        }));
        return;
      }

      const success = payload as WatchlistReEvaluateSuccessResponse;
      setActions((previous) => ({
        ...previous,
        [detail.entry.id]: {
          ...previous[detail.entry.id],
          reevaluating: false,
          reevaluation: success,
        },
      }));

      // A verdict was persisted, so the stored last-known state changed —
      // refresh the list while keeping this comparison on screen.
      if (
        success.outcome === "evaluated" ||
        success.outcome === "no-candidates" ||
        success.outcome === "economics-unavailable"
      ) {
        void loadEntries();
      }
    } catch {
      setActions((previous) => ({
        ...previous,
        [detail.entry.id]: {
          ...previous[detail.entry.id],
          reevaluating: false,
          error: "The re-evaluation could not be completed. Please retry.",
        },
      }));
    }
  }

  async function toggleHistory(detail: WatchlistEntryDetail): Promise<void> {
    const current = actions[detail.entry.id];
    if (current?.historyOpen) {
      setActions((previous) => ({
        ...previous,
        [detail.entry.id]: { ...previous[detail.entry.id], historyOpen: false },
      }));
      return;
    }

    setActions((previous) => ({
      ...previous,
      [detail.entry.id]: {
        ...previous[detail.entry.id],
        historyOpen: true,
        historyLoading: true,
        error: undefined,
      },
    }));

    try {
      const response = await fetch(
        `${LIST_ENDPOINT}/${detail.entry.id}/history`,
        { cache: "no-store" },
      );
      const payload = (await response.json()) as
        | WatchlistHistorySuccessResponse
        | WatchlistErrorResponse;

      if (!response.ok || payload.status === "error") {
        const error = payload as WatchlistErrorResponse;
        setActions((previous) => ({
          ...previous,
          [detail.entry.id]: {
            ...previous[detail.entry.id],
            historyLoading: false,
            error: `${error.error} (${error.code})`,
          },
        }));
        return;
      }

      setActions((previous) => ({
        ...previous,
        [detail.entry.id]: {
          ...previous[detail.entry.id],
          historyLoading: false,
          history: payload.history,
        },
      }));
    } catch {
      setActions((previous) => ({
        ...previous,
        [detail.entry.id]: {
          ...previous[detail.entry.id],
          historyLoading: false,
          error: "The history could not be read. Please retry.",
        },
      }));
    }
  }

  async function archiveEntry(detail: WatchlistEntryDetail): Promise<void> {
    setActions((previous) => ({
      ...previous,
      [detail.entry.id]: {
        ...previous[detail.entry.id],
        archiving: true,
        error: undefined,
      },
    }));

    try {
      const response = await fetch(
        `${LIST_ENDPOINT}/${detail.entry.id}/archive`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
        },
      );
      const payload = (await response.json()) as
        | WatchlistArchiveSuccessResponse
        | WatchlistErrorResponse;

      if (!response.ok || payload.status === "error") {
        const error = payload as WatchlistErrorResponse;
        setActions((previous) => ({
          ...previous,
          [detail.entry.id]: {
            ...previous[detail.entry.id],
            archiving: false,
            error: `${error.error} (${error.code})`,
          },
        }));
        return;
      }

      const title = detail.marketplace?.title ?? detail.entry.marketplaceExternalId;
      const remaining = entries.filter(
        (item) => item.entry.id !== detail.entry.id,
      );
      setEntries(remaining);
      setStatus(remaining.length === 0 ? "empty" : "ready");
      setActions((previous) => {
        const next = { ...previous };
        delete next[detail.entry.id];
        return next;
      });
      setArchivedNote(
        `Archived “${title}” — its assessment history is kept, and the scope can be watched again.`,
      );
    } catch {
      setActions((previous) => ({
        ...previous,
        [detail.entry.id]: {
          ...previous[detail.entry.id],
          archiving: false,
          error: "The entry could not be archived. Please retry.",
        },
      }));
    }
  }

  /** Arms the two-step archive so a single mis-click can never drop an entry. */
  function armArchive(entryId: string, armed: boolean): void {
    setActions((previous) => ({
      ...previous,
      [entryId]: { ...previous[entryId], archiveConfirming: armed, error: undefined },
    }));
  }

  const noFiltersActive =
    band === "ALL" && supplierScope === "ALL" && profitability === "ALL";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Watchlist</h1>
        <p className="max-w-2xl text-sm text-muted">
          The monitored subset of products and opportunities. Every figure below is a stored
          observation from the moment it was made — never a live claim about the listing. A
          re-evaluation is the only way to get fresh numbers, and it is a deliberate, bounded
          action.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium text-foreground">Sort</span>
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as WatchlistSortKey)}
            className="rounded-md border border-border bg-surface px-3 py-2 text-xs text-foreground"
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium text-foreground">Band</span>
          <select
            value={band}
            onChange={(event) => setBand(event.target.value)}
            className="rounded-md border border-border bg-surface px-3 py-2 text-xs text-foreground"
          >
            <option value="ALL">All bands</option>
            {BAND_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium text-foreground">Scope</span>
          <select
            value={supplierScope}
            onChange={(event) => setSupplierScope(event.target.value)}
            className="rounded-md border border-border bg-surface px-3 py-2 text-xs text-foreground"
          >
            <option value="ALL">All scopes</option>
            {SUPPLIER_SCOPE_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {value === "pair" ? "Listing + supplier" : "Marketplace only"}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium text-foreground">Profitability</span>
          <select
            value={profitability}
            onChange={(event) => setProfitability(event.target.value)}
            className="rounded-md border border-border bg-surface px-3 py-2 text-xs text-foreground"
          >
            <option value="ALL">Any profitability</option>
            {PROFITABILITY_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {value === "profitable" ? "Profitable" : "Unprofitable"}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void loadEntries()}
          disabled={status === "loading"}
          className="inline-flex items-center justify-center rounded-md border border-border bg-surface px-4 py-2 text-xs font-medium text-foreground hover:bg-background disabled:cursor-not-allowed disabled:opacity-60"
        >
          {status === "loading" ? "Reading…" : "Refresh"}
        </button>
      </div>

      {archivedNote !== null && (
        <p
          role="status"
          className="rounded-md border border-border bg-surface px-3 py-2 text-xs text-muted"
        >
          {archivedNote}{" "}
          <button
            type="button"
            onClick={() => setArchivedNote(null)}
            className="font-medium text-foreground underline underline-offset-2 hover:no-underline"
          >
            Dismiss
          </button>
        </p>
      )}

      {status === "loading" && (
        <p role="status" className="text-sm text-muted">
          Reading the active watchlist…
        </p>
      )}

      {(status === "not-configured" || status === "error") && errorMessage !== null && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-md border border-border bg-surface px-4 py-3 text-sm text-foreground"
        >
          <p>{errorMessage}</p>
          <button
            type="button"
            onClick={() => void loadEntries()}
            className="inline-flex items-center justify-center self-start rounded-md border border-border bg-foreground px-4 py-2 text-xs font-medium text-background hover:opacity-90"
          >
            Retry
          </button>
        </div>
      )}

      {status === "empty" && (
        <p className="text-sm text-muted">
          {noFiltersActive
            ? "The watchlist has no active entries yet. Save a scope from the Opportunity Scanner to start monitoring it."
            : "No active entries match these filters. Reset them to see the whole watchlist."}
        </p>
      )}

      {status === "ready" && (
        <ul className="flex flex-col gap-4">
          {entries.map((detail) => (
            <li key={detail.entry.id}>
              <WatchlistEntryCard
                detail={detail}
                action={actions[detail.entry.id]}
                onReevaluate={reevaluateEntry}
                onToggleHistory={toggleHistory}
                onArchive={archiveEntry}
                onArmArchive={armArchive}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const BAND_TONE: Record<string, string> = {
  HIGH: "border-green-600 text-green-700",
  MEDIUM: "border-amber-600 text-amber-700",
  LOW: "border-red-600 text-red-700",
};

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border py-1 last:border-b-0">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-medium text-foreground">{value}</dd>
    </div>
  );
}

function WatchlistEntryCard({
  detail,
  action,
  onReevaluate,
  onToggleHistory,
  onArchive,
  onArmArchive,
}: {
  detail: WatchlistEntryDetail;
  action: EntryAction | undefined;
  onReevaluate: (detail: WatchlistEntryDetail) => Promise<void>;
  onToggleHistory: (detail: WatchlistEntryDetail) => Promise<void>;
  onArchive: (detail: WatchlistEntryDetail) => Promise<void>;
  onArmArchive: (entryId: string, armed: boolean) => void;
}) {
  const { entry, marketplace, supplier, assessment } = detail;
  const isPair = entry.supplierExternalId !== null;
  const title = marketplace?.title ?? "Untitled listing";
  const currency = marketplace?.currency ?? null;

  return (
    <article className="flex flex-col gap-3 rounded-lg border border-border bg-background p-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted">
            {isPair ? "Listing + supplier" : "Marketplace only"}
          </span>
          {assessment !== null && (
            <span
              className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase ${BAND_TONE[assessment.band]}`}
            >
              {assessment.band}
            </span>
          )}
          {assessment !== null && (
            <span className="text-xs text-muted">Score {assessment.score}/100</span>
          )}
        </div>
        <h3 className="line-clamp-2 text-base font-semibold text-foreground">{title}</h3>
        {entry.label !== null && (
          <p className="text-xs text-muted">Note: {entry.label}</p>
        )}
        {marketplace?.listingUrl !== null && marketplace?.listingUrl !== undefined && (
          <Link
            href={marketplace.listingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="w-fit text-xs font-medium text-foreground underline underline-offset-2 hover:no-underline"
          >
            View the listing on the marketplace
          </Link>
        )}
      </header>

      <div className="flex flex-col gap-1 text-xs text-muted">
        <p>
          Marketplace price:{" "}
          {marketplace === null || marketplace.price === null
            ? "not observed yet"
            : formatMoney(marketplace.price, currency)}
          {" · observed "}
          {observedAt(marketplace?.observedAt ?? null)}
        </p>
        {isPair ? (
          <p>
            Supplier: {supplier?.title ?? "unknown"} · reference cost:{" "}
            {supplier === null || supplier.referenceCost === null
              ? "not observed yet"
              : formatMoney(supplier.referenceCost, supplier.currency)}
            {" · observed "}
            {observedAt(supplier?.observedAt ?? null)}
          </p>
        ) : (
          <p>
            No supplier is watched for this listing, so no cost side is monitored.
            Re-evaluation still searches for candidates against the replayed query.
          </p>
        )}
      </div>

      {assessment === null ? (
        <p className="text-xs text-muted">
          No assessment is stored for this scope yet. Re-evaluate to produce one.
        </p>
      ) : (
        <dl className="rounded-md border border-border bg-surface px-3 text-xs">
          <StatRow label="Confidence" value={`${assessment.confidence} (${assessment.confidenceLevel})`} />
          <StatRow
            label="Supplier match confidence"
            value={`${assessment.matchConfidence} (${assessment.matchConfidenceBand})`}
          />
          <StatRow label="Economics" value={assessment.economicsCompleteness} />
          <StatRow
            label="Estimated profit"
            value={assessment.profit === null ? "unavailable" : formatMoney(assessment.profit, currency)}
          />
          <StatRow
            label="Margin"
            value={assessment.marginPercent === null ? "unavailable" : `${assessment.marginPercent}%`}
          />
          <StatRow label="Assessments stored" value={String(detail.assessmentCount)} />
          <StatRow label="Last evaluated" value={observedAt(assessment.calculatedAt)} />
          <StatRow label="Engine version" value={assessment.engineVersion} />
        </dl>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void onReevaluate(detail)}
          disabled={action?.reevaluating === true}
          className="inline-flex items-center justify-center rounded-md border border-border bg-foreground px-4 py-2 text-xs font-medium text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {action?.reevaluating === true
            ? "Evaluating…"
            : "Re-evaluate (replays the saved search)"}
        </button>
        <button
          type="button"
          onClick={() => void onToggleHistory(detail)}
          className="inline-flex items-center justify-center rounded-md border border-border bg-surface px-4 py-2 text-xs font-medium text-foreground hover:bg-background"
        >
          {action?.historyOpen === true
            ? "Hide history"
            : `History${detail.assessmentCount > 0 ? ` (${detail.assessmentCount})` : ""}`}
        </button>
        {action?.archiveConfirming === true ? (
          <>
            <button
              type="button"
              onClick={() => void onArchive(detail)}
              disabled={action?.archiving === true}
              className="inline-flex items-center justify-center rounded-md border border-red-600 bg-red-600 px-4 py-2 text-xs font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {action?.archiving === true ? "Archiving…" : "Confirm archive"}
            </button>
            <button
              type="button"
              onClick={() => onArmArchive(entry.id, false)}
              disabled={action?.archiving === true}
              className="inline-flex items-center justify-center rounded-md border border-border bg-surface px-4 py-2 text-xs font-medium text-foreground hover:bg-background disabled:cursor-not-allowed disabled:opacity-60"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => onArmArchive(entry.id, true)}
            disabled={action?.archiving === true}
            className="inline-flex items-center justify-center rounded-md border border-border bg-surface px-4 py-2 text-xs font-medium text-foreground hover:bg-background disabled:cursor-not-allowed disabled:opacity-60"
          >
            Archive
          </button>
        )}
      </div>

      {action?.error !== undefined && (
        <p role="alert" className="text-[11px] text-red-700">
          {action.error}
        </p>
      )}

      {action?.reevaluation !== undefined && (
        <ReEvaluationPanel response={action.reevaluation} currency={currency} />
      )}

      {action?.historyOpen === true && (
        <HistoryPanel
          loading={action?.historyLoading === true}
          history={action?.history}
          currency={currency}
        />
      )}
    </article>
  );
}

function persistenceCopy(persistence: WatchlistReEvaluateSuccessResponse["result"]["persistence"]): string {
  if (persistence === undefined) {
    return "This server did not report what happened to the assessment.";
  }
  switch (persistence.status) {
    case "ok":
      return persistence.inserted
        ? "Persisted as a new observation for this scope."
        : "Unchanged since the last stored observation — the existing observation was reused.";
    case "disabled":
      return "Persistence is not configured on this server, so this assessment was not stored.";
    case "failed":
      return `The assessment could not be persisted: ${persistence.message}`;
    default:
      return "This server did not report what happened to the assessment.";
  }
}

function signedDelta(delta: NumericDelta): string {
  if (delta.delta === null) {
    return "n/a";
  }
  switch (delta.direction) {
    case "up":
      return `+${delta.delta}`;
    case "down":
      return `-${delta.delta}`;
    case "unchanged":
      return `${delta.delta}`;
    default:
      return "n/a";
  }
}

function ReEvaluationPanel({
  response,
  currency,
}: {
  response: WatchlistReEvaluateSuccessResponse;
  currency: string | null;
}) {
  const { outcome, result, assessment, comparison } = response;

  return (
    <section
      aria-label="Latest re-evaluation"
      className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3"
    >
      <p className="text-xs font-medium text-foreground">
        Latest re-evaluation: {REEVALUATION_OUTCOME_COPY[outcome]}
      </p>
      <p className="text-[11px] text-muted">
        Evaluated {observedAt(result.evaluatedAt)} in {result.durationMs} ms.{" "}
        {persistenceCopy(result.persistence)}
      </p>
      {result.failureMessage !== undefined && (
        <p className="text-[11px] text-red-700">{result.failureMessage}</p>
      )}
      {assessment !== null && assessment !== undefined && (
        <p className="text-[11px] text-muted">
          Fresh assessment: score {assessment.score} ({assessment.band}), confidence{" "}
          {assessment.confidence} ({assessment.confidenceLevel}).
        </p>
      )}
      {comparison === null || comparison === undefined ? (
        <p className="text-[11px] text-muted">
          This outcome produced no comparison against the previous assessment.
        </p>
      ) : (
        <ComparisonView comparison={comparison} currency={currency} />
      )}
    </section>
  );
}

function ComparisonView({
  comparison,
  currency,
}: {
  comparison: AssessmentComparison;
  currency: string | null;
}) {
  if (comparison.noPrevious) {
    return (
      <p className="text-[11px] text-muted">
        No previous assessment existed for this scope, so this is the first stored
        observation — there is nothing to compare against.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <p className="text-[11px] font-medium text-foreground">
        Change since the previous assessment ({observedAt(comparison.previousCalculatedAt)}).
        A single comparison is not a trend.
      </p>
      <ul className="flex flex-col gap-1 text-[11px]">
        {comparison.numeric.map((delta) => (
          <li key={delta.field} className="flex items-baseline justify-between gap-3">
            <span className="text-muted">{delta.label}</span>
            <span className="font-medium text-foreground">
              {delta.previous ?? "—"} → {delta.current ?? "—"}
              <span className="text-muted"> ({signedDelta(delta)})</span>
            </span>
          </li>
        ))}
        {comparison.categorical
          .filter((change) => change.changed)
          .map((change) => (
            <li key={change.field} className="flex items-baseline justify-between gap-3">
              <span className="text-muted">{change.label}</span>
              <span className="font-medium text-foreground">
                {change.previous ?? "—"} → {change.current ?? "—"}
              </span>
            </li>
          ))}
      </ul>
      {comparison.numeric.some((delta) => delta.current === null) && (
        <p className="text-[11px] text-muted">
          Figures are shown in {currency ?? "the marketplace currency"} where the assessment
          stored them; “—” means the value was unavailable at that time.
        </p>
      )}
    </div>
  );
}

function HistoryPanel({
  loading,
  history,
  currency,
}: {
  loading: boolean;
  history: WatchlistHistoryEntry[] | undefined;
  currency: string | null;
}) {
  if (loading) {
    return (
      <p role="status" className="text-[11px] text-muted">
        Reading the assessment history…
      </p>
    );
  }

  if (history === undefined) {
    return null;
  }

  if (history.length === 0) {
    return (
      <p className="text-[11px] text-muted">
        No assessments are stored for this scope yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <p className="text-[11px] font-medium text-foreground">
        Assessment history (most recent first) — archived scopes keep their history.
      </p>
      <ol className="flex flex-col gap-2 border-l border-border pl-3">
        {history.map((item) => (
          <li key={item.calculatedAt} className="flex flex-col gap-0.5 text-[11px]">
            <span className="font-medium text-foreground">{observedAt(item.calculatedAt)}</span>
            <span className="text-muted">
              Score {item.score} ({item.band}) · confidence {item.confidence} (
              {item.confidenceLevel}) · profit{" "}
              {item.profit === null ? "unavailable" : formatMoney(item.profit, currency)} ·
              margin {item.marginPercent === null ? "unavailable" : `${item.marginPercent}%`} ·
              economics {item.economicsCompleteness} · match confidence{" "}
              {item.matchConfidence}
            </span>
            <span className="text-muted">Engine {item.engineVersion}</span>
            {item.caveats.length > 0 && (
              <span className="text-amber-700">Caveats: {item.caveats.join(" · ")}</span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
