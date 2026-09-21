/**
 * Response shape of the database connectivity probe (GET /api/health/db).
 *
 * Deliberately minimal: this endpoint must never expose credentials, connection
 * strings, raw database errors, or stack traces. Only a coarse reachability
 * verdict is returned.
 */
export interface DatabaseHealthResponse {
  status: "ok" | "error";
  service: "inkora-db";
  database: "reachable" | "unreachable";
  timestamp: string;
}
