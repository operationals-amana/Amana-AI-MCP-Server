import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is required");
}

export const pool = new pg.Pool({
  connectionString: url,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 8_000,
  ssl: { rejectUnauthorized: false },
});

pool.on("connect", (client) => {
  void client.query("SET statement_timeout = '8s'");
});

export type CorpusHit = {
  id: string;
  doc_type: string;
  title: string;
  snippet: string;
  score: number;
};

export async function searchCorpus(args: {
  query: string;
  types?: string[];
  sector?: string;
  donor?: string;
  year_from?: number;
  limit?: number;
}): Promise<CorpusHit[]> {
  const { rows } = await pool.query<CorpusHit>(
    `SELECT id, doc_type, title, snippet, score
     FROM public.search_corpus($1, $2, $3, $4, $5, $6)`,
    [
      args.query,
      args.types && args.types.length > 0 ? args.types : null,
      args.sector ?? null,
      args.donor ?? null,
      args.year_from ?? null,
      args.limit ?? 8,
    ],
  );
  return rows;
}

export async function fetchDocument(
  id: string,
  section?: string,
): Promise<Record<string, unknown> | null> {
  const { rows } = await pool.query<{ fetch_document: Record<string, unknown> | null }>(
    `SELECT public.fetch_document($1, $2) AS fetch_document`,
    [id, section ?? null],
  );
  return rows[0]?.fetch_document ?? null;
}
