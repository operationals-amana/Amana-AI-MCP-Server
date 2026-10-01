/**
 * Applies a .sql file to the database using the same env loading the eval scripts
 * use, so it works without sourcing .env.production into your shell first.
 *
 * This exists because `psql "$DIRECT_URL" -f ...` silently does the wrong thing when
 * the variable is not exported: psql falls back to a local socket, fails to connect,
 * and the migration is never applied — which looks identical to a no-op if you only
 * skim the output.
 *
 * Connects via DIRECT_URL (Supabase session-mode pooler, port 5432), which handles
 * multi-statement dollar-quoted DDL. DATABASE_URL is the transaction-mode pooler on
 * 6543 and must not be used for DDL.
 *
 * Usage:  node scripts/apply-sql.mjs sql/002_deliverable_retrieval.sql
 *         npm run db:apply -- sql/002_deliverable_retrieval.sql
 */

import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadEnv, repoRoot } from "../eval/lib/env.mjs";

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/apply-sql.mjs <file.sql>");
  process.exit(2);
}

const file = path.resolve(repoRoot, target);
if (!fs.existsSync(file)) {
  console.error(`not found: ${file}`);
  process.exit(2);
}

const env = loadEnv();
const url = env.DIRECT_URL ?? env.DATABASE_URL;
if (!url) {
  console.error("Neither DIRECT_URL nor DATABASE_URL is set (.env.production or environment).");
  process.exit(2);
}
if (!env.DIRECT_URL) {
  console.warn("warning: DIRECT_URL unset, falling back to DATABASE_URL — DDL may fail on a transaction-mode pooler");
}

const sql = fs.readFileSync(file, "utf8");
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
  const { rows } = await client.query("SELECT current_database() AS db, current_user AS usr");
  console.log(`connected: ${rows[0].db} as ${rows[0].usr}`);

  // Sent as one batch so dollar-quoted function bodies are not split mid-literal.
  await client.query(sql);
  console.log(`applied ${path.relative(repoRoot, file)}`);
} catch (error) {
  console.error(`\nFAILED: ${error.message}`);
  if (error.where) console.error(`context: ${error.where}`);
  if (error.position) {
    const at = Number(error.position);
    const upto = sql.slice(0, at);
    const line = upto.split("\n").length;
    console.error(`at character ${at} (line ~${line}):`);
    console.error(sql.slice(Math.max(0, at - 200), at + 200));
  }
  process.exitCode = 1;
} finally {
  await client.end();
}
