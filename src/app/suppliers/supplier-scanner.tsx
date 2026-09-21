"use client";

import Image from "next/image";
import { useState, type FormEvent } from "react";

import type {
  SupplierProduct,
  SupplierWarehouseInventory,
  UsWarehouseInventoryStatus,
} from "@/lib/supplier/types";
import type {
  SupplierInventorySuccessResponse,
  SupplierLabel,
  SupplierSearchErrorCode,
  SupplierSearchSuccessResponse,
} from "@/types/supplier-search";

/**
 * Supplier Scanner — supplier-side discovery.
 *
 * The UI never talks to CJdropshipping directly. Every search and inventory
 * lookup goes through the Inkora server routes, which own credentials and
 * normalization; this component only renders the already-normalized,
 * provider-independent supplier model.
 *
 * This is a validation surface for the CJ slice, not final product design, and
 * it deliberately performs no eBay↔CJ matching (a separate, reviewed task).
 */

const SEARCH_ENDPOINT = "/api/suppliers/cj/search";
const INVENTORY_ENDPOINT = "/api/suppliers/cj/inventory";
const SUGGESTED_QUERY = "wireless earbuds";
const SUPPLIER_LABEL: SupplierLabel = "cj";

type SearchStatus = "idle" | "loading" | "error" | "empty" | "results";

interface ErrorPayload {
  status?: string;
  code?: SupplierSearchErrorCode;
  error?: string;
}

const ERROR_COPY: Record<SupplierSearchErrorCode, string> = {
  INVALID_QUERY: "Enter a search term of 1–100 characters.",
  INVALID_LIMIT: "The requested result limit is not valid.",
  INVALID_SKU: "The SKU used for the inventory lookup is not valid.",
  CJ_NOT_CONFIGURED:
    "CJdropshipping search is not configured on this server yet. Add CJ_API_KEY and restart.",
  CJ_AUTH_FAILED:
    "The server could not authenticate with CJdropshipping. The CJ API key may be wrong or revoked.",
  CJ_UPSTREAM_ERROR:
    "CJdropshipping could not complete the request just now. Try again.",
  CJ_RATE_LIMITED:
    "CJdropshipping is rate-limiting this application. Wait a moment, then retry.",
  INTERNAL_ERROR: "Something went wrong while searching. Please try again.",
};

interface InventoryState {
  status: "loading" | "ready" | "error";
  warehouses?: SupplierWarehouseInventory[];
  verdict?: UsWarehouseInventoryStatus;
}

export function SupplierScanner() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [errorCode, setErrorCode] = useState<SupplierSearchErrorCode | null>(
    null,
  );
  const [products, setProducts] = useState<SupplierProduct[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [inventory, setInventory] = useState<
    Record<string, InventoryState>
  >({});

  async function runSearch(searchTerm: string) {
    setStatus("loading");
    setErrorCode(null);
    setInventory({});

    try {
      const response = await fetch(
        `${SEARCH_ENDPOINT}?q=${encodeURIComponent(searchTerm)}`,
        { cache: "no-store" },
      );
      const payload = (await response.json()) as
        | SupplierSearchSuccessResponse
        | ErrorPayload;

      if (!response.ok || payload.status !== "ok") {
        setErrorCode((payload as ErrorPayload).code ?? "INTERNAL_ERROR");
        setStatus("error");
        return;
      }

      const success = payload as SupplierSearchSuccessResponse;
      setTotal(success.total);
      setProducts(success.products);
      setStatus(success.products.length === 0 ? "empty" : "results");
    } catch {
      setErrorCode("INTERNAL_ERROR");
      setStatus("error");
    }
  }

  async function checkInventory(product: SupplierProduct) {
    if (!product.sku) return;
    const sku = product.sku;

    setInventory((previous) => ({
      ...previous,
      [product.externalId]: { status: "loading" },
    }));

    try {
      const response = await fetch(
        `${INVENTORY_ENDPOINT}?sku=${encodeURIComponent(sku)}`,
        { cache: "no-store" },
      );
      const payload = (await response.json()) as
        | SupplierInventorySuccessResponse
        | ErrorPayload;

      if (!response.ok || payload.status !== "ok") {
        setInventory((previous) => ({
          ...previous,
          [product.externalId]: { status: "error" },
        }));
        return;
      }

      const success = payload as SupplierInventorySuccessResponse;
      setInventory((previous) => ({
        ...previous,
        [product.externalId]: {
          status: "ready",
          warehouses: success.warehouses,
          verdict: success.usWarehouseInventory,
        },
      }));
    } catch {
      setInventory((previous) => ({
        ...previous,
        [product.externalId]: { status: "error" },
      }));
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
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Supplier Scanner</h1>
        <p className="max-w-2xl text-sm text-muted">
          Searches the official CJdropshipping catalogue through Inkora&apos;s
          server boundary. Results are normalized supplier products with honest,
          provenance-tagged fields — inventory and warehouse country are only
          shown once a real inventory lookup confirms them.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="search"
            name="q"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search the CJdropshipping catalogue (e.g. wireless earbuds)"
            aria-label="Supplier search query"
            maxLength={100}
            className="min-w-0 flex-1 rounded border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-foreground"
            disabled={isLoading}
          />
          <button
            type="submit"
            className="rounded bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
            disabled={isLoading}
          >
            {isLoading ? "Searching…" : "Search suppliers"}
          </button>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted">
          <button
            type="button"
            onClick={handleSuggestion}
            className="underline-offset-2 hover:underline"
            disabled={isLoading}
          >
            Try &ldquo;{SUGGESTED_QUERY}&rdquo;
          </button>
          <span aria-hidden="true">·</span>
          <span>Supplier: CJdropshipping (official API 2.0)</span>
        </div>
      </form>

      {status === "error" && errorCode && (
        <div
          role="alert"
          className="rounded border border-border bg-surface px-4 py-3 text-sm text-foreground"
        >
          {ERROR_COPY[errorCode]}
        </div>
      )}

      {status === "empty" && (
        <div className="rounded border border-border bg-surface px-4 py-6 text-center text-sm text-muted">
          No CJdropshipping products matched that query.
        </div>
      )}

      {status === "results" && (
        <div className="flex flex-col gap-4">
          <div className="text-xs text-muted">
            {typeof total === "number"
              ? `${products.length} shown of ${total.toLocaleString()} matching products`
              : `${products.length} products`}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((product) => (
              <SupplierProductCard
                key={`${product.supplier}-${product.externalId}`}
                product={product}
                inventory={inventory[product.externalId]}
                onCheckInventory={checkInventory}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface SupplierProductCardProps {
  product: SupplierProduct;
  inventory: InventoryState | undefined;
  onCheckInventory: (product: SupplierProduct) => void;
}

function SupplierProductCard({
  product,
  inventory,
  onCheckInventory,
}: SupplierProductCardProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = product.imageUrl !== null && !imageFailed;

  return (
    <article className="flex flex-col overflow-hidden rounded border border-border bg-surface">
      <div className="relative aspect-square bg-background">
        {showImage ? (
          <Image
            src={product.imageUrl as string}
            alt=""
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
          <h3 className="line-clamp-2 text-sm font-medium leading-snug">
            {product.title}
          </h3>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className="rounded border border-border px-1.5 py-0.5 font-medium uppercase">
              {SUPPLIER_LABEL}
            </span>
            {product.category && (
              <span className="rounded border border-border px-1.5 py-0.5 uppercase">
                {product.category}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-1 text-sm">
          {product.supplierPrice !== null ? (
            <span className="font-semibold">
              {formatMoney(product.supplierPrice, product.currency)}
            </span>
          ) : (
            <span className="text-muted">Price not listed</span>
          )}
          {product.sku && (
            <span className="text-xs text-muted">SKU: {product.sku}</span>
          )}
        </div>

        <InventoryPanel
          product={product}
          inventory={inventory}
          onCheckInventory={onCheckInventory}
        />

        <div className="mt-auto pt-1 text-[11px] uppercase tracking-wide text-muted">
          Source: CJ API 2.0 · {product.provenance}
        </div>
      </div>
    </article>
  );
}

const VERDICT_COPY: Record<UsWarehouseInventoryStatus, string> = {
  CONFIRMED_AVAILABLE: "US warehouse stock confirmed",
  CONFIRMED_NONE: "No US warehouse stock",
  UNKNOWN: "Warehouse inventory unknown",
};

function InventoryPanel({
  product,
  inventory,
  onCheckInventory,
}: {
  product: SupplierProduct;
  inventory: InventoryState | undefined;
  onCheckInventory: (product: SupplierProduct) => void;
}) {
  // Search cannot establish inventory, and without a SKU there is no handle for
  // the inventory endpoint at all.
  if (!product.sku) {
    return (
      <div className="text-xs text-muted">Inventory unknown — no SKU</div>
    );
  }

  if (inventory === undefined) {
    return (
      <button
        type="button"
        onClick={() => onCheckInventory(product)}
        className="self-start rounded border border-border px-2.5 py-1 text-xs hover:bg-background"
      >
        Check inventory
      </button>
    );
  }

  if (inventory.status === "loading") {
    return <div className="text-xs text-muted">Checking inventory…</div>;
  }

  if (inventory.status === "error") {
    return (
      <div className="flex flex-col gap-1 text-xs text-muted">
        <span>Inventory lookup failed.</span>
        <button
          type="button"
          onClick={() => onCheckInventory(product)}
          className="self-start underline-offset-2 hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }

  const warehouses = inventory.warehouses ?? [];
  const verdict = inventory.verdict ?? "UNKNOWN";

  if (warehouses.length === 0) {
    return (
      <div className="rounded border border-border bg-background px-2.5 py-1.5 text-xs text-muted">
        {VERDICT_COPY.UNKNOWN}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium">{VERDICT_COPY[verdict]}</span>
      <ul className="flex flex-col gap-0.5 text-xs text-muted">
        {warehouses.map((warehouse, index) => (
          <li key={`${warehouse.countryCode ?? "?"}-${index}`}>
            {warehouse.warehouseName ?? warehouse.countryName ?? "Warehouse"}
            {warehouse.countryCode ? ` (${warehouse.countryCode})` : ""}:
            {warehouse.totalQuantity !== null
              ? ` ${warehouse.totalQuantity} units`
              : " quantity unknown"}
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatMoney(value: string, currency: string | null): string {
  if (currency === "USD") {
    return `$${value}`;
  }
  return currency ? `${value} ${currency}` : value;
}
