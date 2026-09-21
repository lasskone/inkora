import "server-only";

import { NextResponse } from "next/server";

import { classifyUsWarehouseInventory } from "@/lib/cj/cj-adapter";
import { requireCjConfig } from "@/lib/cj/config";
import {
  CjApiError,
  CjAuthError,
  CjConfigError,
} from "@/lib/cj/errors";
import { queryCjInventoryBySku } from "@/lib/cj/products-api";
import type {
  SupplierInventorySuccessResponse,
  SupplierSearchErrorCode,
  SupplierSearchErrorResponse,
} from "@/types/supplier-search";

/**
 * Server-side supplier inventory boundary — the narrow, additional official CJ
 * endpoint used to establish warehouse country (including US stock) for one
 * selected product.
 *
 *   GET /api/suppliers/cj/inventory?sku=<cj-sku>
 *
 * Product search alone cannot confirm inventory or warehouse country
 * (docs/API_INTEGRATIONS.md §3.3), so this route exists rather than a guessed
 * value on search results. The response distinguishes explicitly between
 * "inventory information available", "US warehouse inventory confirmed", and
 * "US warehouse inventory unknown". It never contains credentials, access
 * tokens, or raw CJ payloads.
 */

export const dynamic = "force-dynamic";

const MIN_SKU_LENGTH = 1;
const MAX_SKU_LENGTH = 100;

interface MappedError {
  status: number;
  code: SupplierSearchErrorCode;
  message: string;
  detail?: string;
}

export async function GET(request: Request): Promise<Response> {
  const timestamp = new Date().toISOString();
  const url = new URL(request.url);

  const rawSku = url.searchParams.get("sku");
  const sku = rawSku?.trim() ?? "";

  if (sku.length < MIN_SKU_LENGTH || sku.length > MAX_SKU_LENGTH) {
    return jsonError(
      400,
      "INVALID_SKU",
      `A SKU of ${MIN_SKU_LENGTH}–${MAX_SKU_LENGTH} characters is required.`,
      timestamp,
    );
  }

  // --- Configuration gate ---------------------------------------------------
  try {
    requireCjConfig();
  } catch {
    return jsonError(
      503,
      "CJ_NOT_CONFIGURED",
      "CJdropshipping supplier search is not configured on this server.",
      timestamp,
      "Set CJ_API_KEY in .env.local.",
    );
  }

  // --- Inventory call -------------------------------------------------------
  try {
    const rows = await queryCjInventoryBySku(requireCjConfig(), sku);
    const { warehouses, status } = classifyUsWarehouseInventory(rows);

    const body: SupplierInventorySuccessResponse = {
      status: "ok",
      supplier: "cj",
      sku,
      warehouses,
      usWarehouseInventory: status,
      timestamp,
    };

    return NextResponse.json(body, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const mapped = mapError(error);
    return jsonError(
      mapped.status,
      mapped.code,
      mapped.message,
      timestamp,
      mapped.detail,
    );
  }
}

function mapError(error: unknown): MappedError {
  if (error instanceof CjConfigError) {
    return {
      status: 503,
      code: "CJ_NOT_CONFIGURED",
      message:
        "CJdropshipping supplier search is not configured on this server.",
      detail: "Set CJ_API_KEY in .env.local.",
    };
  }

  if (error instanceof CjAuthError) {
    return {
      status: 502,
      code: "CJ_AUTH_FAILED",
      message:
        "The server could not authenticate with CJdropshipping. Check that the CJ API key is valid.",
      detail:
        typeof error.code === "number"
          ? `CJ rejected the API key (upstream code: ${error.code}). Verify CJ_API_KEY in .env.local is a valid API key for an active CJdropshipping account.`
          : "Verify CJ_API_KEY in .env.local is a valid API key for an active CJdropshipping account.",
    };
  }

  if (error instanceof CjApiError) {
    if (error.status === 429) {
      return {
        status: 429,
        code: "CJ_RATE_LIMITED",
        message:
          "CJdropshipping is rate-limiting this application. Wait a moment, then retry.",
      };
    }
    return {
      status: 502,
      code: "CJ_UPSTREAM_ERROR",
      message: error.message,
    };
  }

  console.error(
    "[suppliers/cj/inventory] unexpected failure:",
    error instanceof Error ? error.name : typeof error,
  );
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message:
      "An unexpected error occurred while querying CJdropshipping inventory.",
  };
}

function jsonError(
  status: number,
  code: SupplierSearchErrorCode,
  message: string,
  timestamp: string,
  detail?: string,
): Response {
  const body: SupplierSearchErrorResponse = {
    status: "error",
    supplier: "cj",
    error: message,
    code,
    timestamp,
    ...(detail ? { detail } : {}),
  };
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
