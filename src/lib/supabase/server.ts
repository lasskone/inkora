import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-only Supabase client for privileged server-side work.
 *
 * The service-role key bypasses Row Level Security and MUST NEVER be exposed to
 * the browser. It is read from a non-prefixed environment variable — never from
 * a `NEXT_PUBLIC_*` variable — and the `server-only` import makes any attempt to
 * bundle this module into client JavaScript fail at build time.
 *
 * Returns `null` when the required environment variables are not configured, so
 * the application degrades safely instead of crashing.
 */
export function createSupabaseServerClient(): SupabaseClient | null {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return null;
  }

  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });
}
