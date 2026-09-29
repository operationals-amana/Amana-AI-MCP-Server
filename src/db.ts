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
  // Chunk-level search touches more rows than the previous document-level scan,
  // and the first query after a deploy pays for a cold cache.
  void client.query("SET statement_timeout = '15s'");
});

export type CorpusHit = {
  id: string;
  doc_type: string;
  title: string;
  snippet: string;
  score: number;
  source_url: string | null;
  client_name: string | null;
  practice_group: string | null;
  document_year: number | null;
  heading: string | null;
  page_from: number | null;
  page_to: number | null;
  chunk_id: string | null;
  confidentiality: string | null;
};

export type ChunkHit = {
  chunk_id: string;
  document_id: string;
  title: string;
  heading: string | null;
  content: string;
  page_from: number | null;
  page_to: number | null;
  source_url: string | null;
  score: number;
};

export async function searchCorpus(args: {
  query: string;
  types?: string[];
  sector?: string;
  donor?: string;
  year_from?: number;
  year_to?: number;
  practice_group?: string;
  doc_type?: string;
  limit?: number;
  includeConfidential?: boolean;
}): Promise<CorpusHit[]> {
  const { rows } = await pool.query<CorpusHit>(
    `SELECT id, doc_type, title, snippet, score, source_url, client_name,
            practice_group, document_year, heading, page_from, page_to,
            chunk_id, confidentiality
     FROM public.search_corpus($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      args.query,
      args.types && args.types.length > 0 ? args.types : null,
      args.sector ?? null,
      args.donor ?? null,
      args.year_from ?? null,
      args.limit ?? 8,
      args.practice_group ?? null,
      args.doc_type ?? null,
      args.year_to ?? null,
      args.includeConfidential ?? false,
    ],
  );
  return rows;
}

export async function searchDeliverableChunks(args: {
  query: string;
  documentId?: string;
  limit?: number;
  includeConfidential?: boolean;
}): Promise<ChunkHit[]> {
  const { rows } = await pool.query<ChunkHit>(
    `SELECT chunk_id, document_id, title, heading, content, page_from, page_to,
            source_url, score
     FROM public.search_deliverable_chunks($1, $2, $3, $4)`,
    [
      args.query,
      args.documentId ?? null,
      args.limit ?? 10,
      args.includeConfidential ?? false,
    ],
  );
  return rows;
}

export async function fetchDocument(
  id: string,
  section?: string,
  includeConfidential = false,
): Promise<Record<string, unknown> | null> {
  const { rows } = await pool.query<{ fetch_document: Record<string, unknown> | null }>(
    `SELECT public.fetch_document($1, $2, $3) AS fetch_document`,
    [id, section ?? null, includeConfidential],
  );
  return rows[0]?.fetch_document ?? null;
}

export type IngestionStatus = {
  totals: Record<string, number>;
  lastRun: Record<string, unknown> | null;
  recentRuns: Record<string, unknown>[];
  failures: Record<string, unknown>[];
};

export async function ingestionStatus(recentRuns = 5): Promise<IngestionStatus | null> {
  const { rows } = await pool.query<{ ingestion_status: IngestionStatus | null }>(
    `SELECT public.ingestion_status($1) AS ingestion_status`,
    [recentRuns],
  );
  return rows[0]?.ingestion_status ?? null;
}
