/**
 * Environment loading for CLI scripts.
 *
 * Next loads .env.local automatically; tsx does not, and dotenv's default entry
 * point reads .env only. Without this, `npm run seed` silently misses the
 * Firebase credentials and quietly writes to the local JSON store instead --
 * the worst kind of failure, because it looks like success.
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });
