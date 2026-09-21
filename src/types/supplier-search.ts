import type {
  SupplierProduct,
  SupplierWarehouseInventory,
  UsWarehouseInventoryStatus,
} from "@/lib/supplier/types";

/**
 * Response shapes of the supplier search / inventory API boundaries.
 *
 * Responses are deliberately sanitized: they never carry upstream tokens,
 * credentials, or raw provider error payloads.
 */

/** Supplier integrations with a live server route. */
export type SupplierLabel = "cj";

export type SupplierSearchErrorCode =
  | "INVALID_QUERY"
  | "INVALID_LIMIT"
  | "INVALID_SKU"
  | "CJ_NOT_CONFIGURED"
  | "CJ_AUTH_FAILED"
  | "CJ_UPSTREAM_ERROR"
  | "CJ_RATE_LIMITED"
  | "INTERNAL_ERROR";

export interface SupplierSearchSuccessResponse {
  status: "ok";
  supplier: SupplierLabel;
  query: string;
  limit: number;
  offset: number;
  total: number | null;
  count: number;
  products: SupplierProduct[];
  timestamp: string;
}

export interface SupplierInventorySuccessResponse {
  status: "ok";
  supplier: SupplierLabel;
  /** The CJ SKU the inventory verdict was computed for. */
  sku: string;
  warehouses: SupplierWarehouseInventory[];
  usWarehouseInventory: UsWarehouseInventoryStatus;
  timestamp: string;
}

export interface SupplierSearchErrorResponse {
  status: "error";
  supplier: SupplierLabel;
  /** Safe, human-readable reason. Never a raw upstream payload. */
  error: string;
  code: SupplierSearchErrorCode;
  /**
   * Developer-facing hint naming the variable to configure. Variable *names*
   * only (they are public in `.env.example`) — never a value.
   */
  detail?: string;
  timestamp: string;
}
