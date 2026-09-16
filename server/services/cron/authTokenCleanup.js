// ── Auth token cleanup ────────────────────────────────────────────────────
//
// Access/refresh rotation (docs/ACCESS_REFRESH_TOKEN_AUTH_PLAN.md) means a
// single doctor shift now writes dozens of rows a day — one auth_sessions +
// one refresh_tokens row per ~15-minute access-token renewal, instead of the
// one auth_sessions row a 24h login used to write. Neither table has ever
// had a cleanup job (auth_sessions didn't before this feature either), so
// left alone both grow without bound. This just deletes rows that are
// long past being useful for anything — including audit — since the JWT's
// own exp claim already rejects an expired access token, and a revoked or
// expired refresh token can never be exchanged for anything either.
//
// A week of slack past expiry keeps a short lookback window for "did this
// person's session get revoked, and when" without the table growing forever.

import { cronPool } from "../../config/db.js";
import { createLogger } from "../logger.js";

const { log, error } = createLogger("Auth Token Cleanup");

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export async function runAuthTokenCleanup() {
  try {
    const sessions = await cronPool.query(
      `DELETE FROM auth_sessions WHERE expires_at < NOW() - INTERVAL '7 days'`,
    );
    const refresh = await cronPool.query(
      `DELETE FROM refresh_tokens
        WHERE expires_at < NOW() - INTERVAL '7 days'
           OR (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '7 days')`,
    );
    if (sessions.rowCount || refresh.rowCount) {
      log(
        `removed ${sessions.rowCount} expired auth_sessions, ${refresh.rowCount} expired/revoked refresh_tokens (>${RETENTION_MS / 86400000}d old)`,
      );
    }
    return { sessions: sessions.rowCount, refreshTokens: refresh.rowCount };
  } catch (e) {
    error("cleanup failed:", e.message);
    return { error: e.message };
  }
}
