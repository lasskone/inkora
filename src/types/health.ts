/**
 * Response shape of the benign health-check endpoint (GET /api/health).
 */
export interface HealthResponse {
  status: "ok";
  service: "inkora";
  environment: string;
  timestamp: string;
}
