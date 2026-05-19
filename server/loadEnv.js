import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

// Load .env from the repo root (one level up from server/) regardless of cwd,
// so `npm run dev` inside server/ still picks up DATABASE_URL etc.
dotenv.config({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env"),
});
