export const TEST_DATABASE_URL = "postgres://user:pass@localhost:5435/gini_scribe_test";

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1"]);
const ALLOWED_PORT = "5435";
const ALLOWED_DATABASE = "gini_scribe_test";

export class GuardError extends Error {
  constructor() {
    super("E2E refused: DATABASE_URL is not the local test database");
    this.name = "GuardError";
  }
}

export function isTestDatabaseUrl(url) {
  if (!url) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) return false;
  if (!ALLOWED_HOSTS.has(parsed.hostname)) return false;
  if (parsed.port !== ALLOWED_PORT) return false;
  if (decodeURIComponent(parsed.pathname.replace(/^\//, "")) !== ALLOWED_DATABASE) return false;
  if (parsed.searchParams.has("host")) return false;
  return true;
}

export function assertTestDatabase(url = process.env.DATABASE_URL) {
  if (!isTestDatabaseUrl(url)) throw new GuardError();
  return url;
}
