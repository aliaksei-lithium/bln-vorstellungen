// Secrets are not in wrangler.jsonc, so `wrangler types` does not see them. Set with `wrangler secret put`.
interface Env {
  /** Shared secret for /api/admin until owner sign-in lands (phase 2). Unset = admin API disabled. */
  ADMIN_TOKEN?: string;
}
declare namespace Cloudflare {
  interface Env {
    ADMIN_TOKEN?: string;
  }
}
