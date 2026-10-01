import pg from "pg";

/**
 * Read-only pool for the evaluation tooling. Separate from src/db.ts because the
 * eval scripts run as one-shot CLI jobs against the same Supabase database and
 * must never hold connections open after the job ends.
 */
export function createPool(databaseUrl) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 4,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
    ssl: { rejectUnauthorized: false },
  });

  pool.on("connect", (client) => {
    // Corpus-wide scans are heavier than the MCP server's per-request queries.
    void client.query("SET statement_timeout = '60s'");
  });

  return pool;
}
