-- Hybrid (vector + lexical) retrieval for the MCP corpus search.
--
-- Why this exists
-- ---------------
-- 002 fixed query construction: search_corpus went from returning nothing for every
-- natural-language question to 71% recall@10. Measured against eval/golden-set.json,
-- what remained was still well short of usable:
--
--   documents   recall@1 30%  recall@10 79%
--   experts     recall@1  0%  recall@10 33%
--   partners    recall@1  0%  recall@10 25%
--   projects    recall@1  0%  recall@10 67%
--   knowledge   recall@1  0%  recall@10  0%
--   cross-lingual                        40%
--
-- Two separate causes, both inherent to lexical-only matching:
--
--   1. Paraphrase. A question rarely reuses the source's vocabulary, and 'simple'
--      tokenisation does no stemming, so near-misses score zero. Cross-lingual is
--      the extreme case: an Indonesian question against an English report shares
--      almost no tokens.
--   2. Score scale. ts_rank_cd grows with match count, so a 900-character document
--      chunk (observed 4.6-7.8) systematically outranks a 200-character expert row
--      (0.6-1.5) in a shared ordering. Entity records were buried regardless of
--      relevance — and their own lexical ordering put the right record in the top 10
--      only 5 times out of 15, among hundreds of loosely-matching candidates.
--
-- The corpus already carries embeddings from
-- sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2 (384 dims) on
-- knowledge_chunks and gdrive_knowledge_documents, with HNSW cosine indexes, and
-- nothing was using them. Measured with those embeddings:
--
--   documents   recall@1 73%  recall@10 100%  cross-lingual 100%
--   entities    recall@1 47%  recall@10  80%   (expert/project/knowledge all 100%)
--
-- Ranking is fused with Reciprocal Rank Fusion rather than a weighted score blend,
-- because the two signals are not on comparable scales — cosine similarity is
-- bounded in [0,1] while ts_rank_cd is unbounded and length-dependent. RRF consumes
-- only ranks, so no normalisation constant has to be guessed or maintained. Weights
-- were swept on the golden set; vector-dominant fusion won:
--
--   v:l =  1:0   recall@1 73%  recall@3 87%  MRR 0.811
--   v:l =  1:1   recall@1 63%  recall@3 84%  MRR 0.745   <- equal weighting is worse
--   v:l =  5:1   recall@1 71%  recall@3 90%  MRR 0.819   <- chosen
--   v:l = 10:1   recall@1 73%  recall@3 89%  MRR 0.820
--
-- 5:1 and 10:1 are within noise of each other; 5:1 is chosen because it retains more
-- lexical influence for exact-term lookups — document titles, acronyms, record codes
-- — which the golden set deliberately under-represents (its questions are
-- paraphrased on purpose, so it cannot measure that case).
--
-- Apply with:  npm run db:apply -- sql/003_hybrid_retrieval.sql
-- Then:        node scripts/backfill-entity-embeddings.py   (see that file)

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- mcp_entity_embeddings
-- ---------------------------------------------------------------------------
--
-- Embeddings for the structured records (Expert, PastProject, PartnerContact,
-- OrgKnowledgeEntry).
--
-- Deliberately a sidecar table rather than an `embedding` column on each record.
-- Those four tables are owned by the operational dashboard's Prisma schema; adding
-- columns to them here would collide with its migration history and could be
-- dropped by a later `prisma migrate`. Keying by the prefixed record id instead
-- keeps this side additive and independent.
--
-- record_id uses the same prefixed form the MCP returns ('expert:…', 'project:…',
-- 'partner:…', 'knowledge:…'), so it joins directly against search results with no
-- translation step.
--
-- content_hash lets the backfill skip unchanged rows, so re-running it after a
-- roster edit is cheap. There is no trigger: entity rows are edited through the
-- dashboard, which knows nothing about this table, so the backfill must be run on a
-- schedule (or after a bulk edit) to pick changes up. Staleness is visible —
-- compare updated_at against the source row's updatedAt.
CREATE TABLE IF NOT EXISTS public.mcp_entity_embeddings (
  record_id    text PRIMARY KEY,
  record_type  text NOT NULL CHECK (record_type IN ('expert', 'project', 'partner', 'knowledge')),
  content_hash text NOT NULL,
  embedding    extensions.vector(384) NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_entity_embeddings_embedding_idx
  ON public.mcp_entity_embeddings
  USING hnsw (embedding extensions.vector_cosine_ops);

CREATE INDEX IF NOT EXISTS mcp_entity_embeddings_type_idx
  ON public.mcp_entity_embeddings (record_type);

-- ---------------------------------------------------------------------------
-- search_corpus_hybrid
-- ---------------------------------------------------------------------------
--
-- Same inputs, filters and output columns as search_corpus, plus an optional query
-- embedding. With p_query_embedding NULL it degrades to lexical-only ranking, which
-- is what makes it safe to deploy before the MCP server can produce embeddings: the
-- server passes NULL until it can, and gains the vector path without a second
-- migration.
--
-- `score` in the result is the fused RRF score, not a ts_rank_cd value. It is
-- comparable *within* one result set but has no absolute meaning, so do not
-- threshold on it across queries.
DROP FUNCTION IF EXISTS public.search_corpus_hybrid(
  text, extensions.vector, text[], text, text, integer, integer, text, text, integer, boolean
);

CREATE OR REPLACE FUNCTION public.search_corpus_hybrid(
  p_query text,
  p_query_embedding extensions.vector(384) DEFAULT NULL,
  p_types text[] DEFAULT NULL,
  p_sector text DEFAULT NULL,
  p_donor text DEFAULT NULL,
  p_year_from integer DEFAULT NULL,
  p_result_limit integer DEFAULT 8,
  p_practice_group text DEFAULT NULL,
  p_doc_type text DEFAULT NULL,
  p_year_to integer DEFAULT NULL,
  p_include_confidential boolean DEFAULT false
)
RETURNS TABLE (
  id text,
  doc_type text,
  title text,
  snippet text,
  score real,
  source_url text,
  client_name text,
  practice_group text,
  document_year integer,
  heading text,
  page_from integer,
  page_to integer,
  chunk_id bigint,
  confidentiality text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  q tsquery;
  lim integer;
  types_filter text[];
  allowed_conf text[];
  -- Candidate depth per ranked list. Deeper than the output limit so fusion has
  -- something to work with; 30 was enough for recall@10 to saturate on the golden set.
  depth CONSTANT integer := 30;
  rrf_k CONSTANT integer := 60;   -- standard RRF damping constant
  w_vec CONSTANT real := 5.0;     -- swept on eval/golden-set.json; see header
  w_lex CONSTANT real := 1.0;
  -- Slots held for structured records when the caller has not filtered by type.
  -- Swept on the golden set; see the WHERE clause at the end of this function.
  entity_slots CONSTANT integer := 3;
BEGIN
  IF p_query IS NULL OR btrim(p_query) = '' THEN
    RAISE EXCEPTION 'query is required' USING ERRCODE = '22023';
  END IF;

  lim := GREATEST(1, LEAST(COALESCE(p_result_limit, 8), 20));
  types_filter := CASE
    WHEN p_types IS NULL OR cardinality(p_types) = 0 THEN NULL
    ELSE p_types
  END;
  q := public.mcp_search_tsquery(p_query);
  allowed_conf := CASE
    WHEN COALESCE(p_include_confidential, false)
      THEN ARRAY['public', 'internal', 'confidential']
    ELSE ARRAY['public', 'internal']
  END;

  RETURN QUERY
  WITH
  -- Documents surviving the metadata filters. Filtering before ranking keeps the
  -- vector scan off rows the caller has excluded.
  eligible_docs AS (
    SELECT g.id AS document_id,
           'gdrive:' || g.id::text AS rec_id,
           g.title, g.source_url, g.client_name, g.practice_group,
           g.document_year, g.confidentiality
    FROM gdrive_knowledge_documents g
    WHERE g.status = 'ready'
      AND g.archived_at IS NULL
      AND COALESCE(g.confidentiality, 'internal') = ANY (allowed_conf)
      AND (types_filter IS NULL OR 'document' = ANY (types_filter))
      AND (p_doc_type IS NULL OR btrim(p_doc_type) = '' OR g.doc_type = btrim(p_doc_type))
      AND (p_practice_group IS NULL OR btrim(p_practice_group) = ''
           OR g.practice_group ILIKE '%' || btrim(p_practice_group) || '%')
      AND (p_sector IS NULL OR btrim(p_sector) = ''
           OR g.sector ILIKE '%' || btrim(p_sector) || '%')
      AND (p_donor IS NULL OR btrim(p_donor) = ''
           OR g.client_name ILIKE '%' || btrim(p_donor) || '%')
      AND (p_year_from IS NULL OR g.document_year >= p_year_from)
      AND (p_year_to IS NULL OR g.document_year <= p_year_to)
  ),
  -- Structured records surviving the filters. p_doc_type describes deliverable
  -- genres, which these rows do not carry, so supplying it excludes them — same
  -- semantics as search_corpus.
  eligible_ents AS (
    SELECT * FROM (
      SELECT 'expert:' || e.id AS rec_id, 'expert'::text AS rec_type,
             e."fullName" AS title, NULL::text AS source_url, NULL::text AS client_name,
             e."practiceGroup" AS practice_group, NULL::integer AS document_year,
             concat_ws(' ', e."fullName", e."positionTitle", e."practiceGroup",
                       e."topTechnicalSkills", e.education, e.certifications) AS body
      FROM "Expert" e
      UNION ALL
      SELECT 'project:' || p.id, 'project', p.title, p."proposalGdriveUrl", p.client,
             NULL, NULL,
             concat_ws(' ', p.title, p.client, p.sector, p.objectives, p.deliverables,
                       p."keyOutcomes", p."technologyStack", p."lessonsLearned")
      FROM "PastProject" p
      UNION ALL
      SELECT 'partner:' || pt.id, 'partner', pt."organizationName", NULL, NULL,
             NULL, NULL,
             concat_ws(' ', pt."organizationName", pt.description, pt.affiliation,
                       pt.cluster, pt.tags, pt.notes)
      FROM "PartnerContact" pt
      UNION ALL
      SELECT 'knowledge:' || k.id, 'knowledge', k.title, k."sourceUrl", NULL,
             k."practiceGroup", NULL,
             concat_ws(' ', k.title, k.category, k.summary, k.content, k.tags,
                       k."practiceGroup")
      FROM "OrgKnowledgeEntry" k
    ) s
    WHERE (types_filter IS NULL OR s.rec_type = ANY (types_filter))
      AND (p_doc_type IS NULL OR btrim(p_doc_type) = '')
      AND (p_practice_group IS NULL OR btrim(p_practice_group) = ''
           OR s.practice_group ILIKE '%' || btrim(p_practice_group) || '%')
      AND (p_donor IS NULL OR btrim(p_donor) = ''
           OR COALESCE(s.client_name, '') ILIKE '%' || btrim(p_donor) || '%')
  ),

  -- ---- ranked list 1: documents by lexical match, best chunk per document -----
  doc_lex AS (
    SELECT rec_id,
           row_number() OVER (ORDER BY s DESC) AS rnk
    FROM (
      SELECT d.rec_id, max(ts_rank_cd(c.content_tsv, q)) AS s
      FROM eligible_docs d
      JOIN knowledge_chunks c ON c.document_id = d.document_id
      WHERE q IS NOT NULL AND c.content_tsv @@ q
      GROUP BY d.rec_id
      ORDER BY s DESC
      LIMIT depth
    ) x
  ),
  -- ---- ranked list 2: documents by embedding similarity -----------------------
  doc_vec AS (
    SELECT rec_id,
           row_number() OVER (ORDER BY s DESC) AS rnk
    FROM (
      SELECT d.rec_id, max(1 - (c.embedding <=> p_query_embedding)) AS s
      FROM eligible_docs d
      JOIN knowledge_chunks c ON c.document_id = d.document_id
      WHERE p_query_embedding IS NOT NULL AND c.embedding IS NOT NULL
      GROUP BY d.rec_id
      ORDER BY s DESC
      LIMIT depth
    ) x
  ),
  -- ---- ranked list 3: entities by lexical match -------------------------------
  ent_lex AS (
    SELECT rec_id,
           row_number() OVER (ORDER BY s DESC) AS rnk
    FROM (
      SELECT e.rec_id,
             ts_rank_cd(to_tsvector('simple', extensions.unaccent(e.body)), q) AS s
      FROM eligible_ents e
      WHERE q IS NOT NULL
        AND to_tsvector('simple', extensions.unaccent(e.body)) @@ q
      ORDER BY s DESC
      LIMIT depth
    ) x
  ),
  -- ---- ranked list 4: entities by embedding similarity ------------------------
  ent_vec AS (
    SELECT rec_id,
           row_number() OVER (ORDER BY s DESC) AS rnk
    FROM (
      SELECT e.rec_id, 1 - (m.embedding <=> p_query_embedding) AS s
      FROM eligible_ents e
      JOIN mcp_entity_embeddings m ON m.record_id = e.rec_id
      WHERE p_query_embedding IS NOT NULL
      ORDER BY s DESC
      LIMIT depth
    ) x
  ),

  -- Reciprocal Rank Fusion over whatever lists produced rows. Because the score is
  -- a function of rank only, an entity at rank 1 of its list competes on equal
  -- footing with a document at rank 1 of its own — which is what removes the
  -- score-scale bias that buried entity records.
  fused AS (
    SELECT rec_id, sum(contrib)::real AS fused_score
    FROM (
      SELECT rec_id, w_vec / (rrf_k + rnk) AS contrib FROM doc_vec
      UNION ALL
      SELECT rec_id, w_lex / (rrf_k + rnk) FROM doc_lex
      UNION ALL
      SELECT rec_id, w_vec / (rrf_k + rnk) FROM ent_vec
      UNION ALL
      SELECT rec_id, w_lex / (rrf_k + rnk) FROM ent_lex
    ) c
    GROUP BY rec_id
  ),

  -- Representative passage for each surviving document, for provenance. Chosen by
  -- the same signal that ranked it: embedding similarity when available, lexical
  -- otherwise, so the cited heading and page match why the document was returned.
  best_chunk AS (
    SELECT DISTINCT ON (d.rec_id)
           d.rec_id, c.id AS chunk_id, c.heading, c.page_from, c.page_to,
           left(c.content, 900) AS snippet
    FROM fused f
    JOIN eligible_docs d ON d.rec_id = f.rec_id
    JOIN knowledge_chunks c ON c.document_id = d.document_id
    ORDER BY d.rec_id,
             CASE
               WHEN p_query_embedding IS NOT NULL AND c.embedding IS NOT NULL
                 THEN 1 - (c.embedding <=> p_query_embedding)
               ELSE COALESCE(ts_rank_cd(c.content_tsv, q), 0)
             END DESC,
             c.chunk_index ASC
  ),

  -- Assembled rows, with a rank within their own family (document vs structured
  -- record) alongside the global fused rank.
  assembled AS (
    SELECT
      f.rec_id,
      CASE WHEN d.rec_id IS NOT NULL THEN 'document' ELSE e.rec_type END AS rec_kind,
      COALESCE(d.title, e.title) AS out_title,
      COALESCE(bc.snippet, left(e.body, 700)) AS out_snippet,
      f.fused_score,
      COALESCE(d.source_url, e.source_url) AS out_source_url,
      COALESCE(d.client_name, e.client_name) AS out_client,
      COALESCE(d.practice_group, e.practice_group) AS out_pg,
      d.document_year AS out_year,
      bc.heading AS out_heading,
      bc.page_from AS out_pf,
      bc.page_to AS out_pt,
      bc.chunk_id AS out_chunk,
      d.confidentiality AS out_conf,
      row_number() OVER (
        PARTITION BY (d.rec_id IS NOT NULL) ORDER BY f.fused_score DESC
      ) AS family_rank
    FROM fused f
    LEFT JOIN eligible_docs d ON d.rec_id = f.rec_id
    LEFT JOIN eligible_ents e ON e.rec_id = f.rec_id
    LEFT JOIN best_chunk bc ON bc.rec_id = f.rec_id
    -- A fused id always came from one of the four lists, but the filters are
    -- re-applied by the joins above; drop anything that no longer resolves.
    WHERE d.rec_id IS NOT NULL OR e.rec_id IS NOT NULL
  )

  SELECT
    a.rec_id, a.rec_kind, a.out_title, a.out_snippet, a.fused_score,
    a.out_source_url, a.out_client, a.out_pg, a.out_year,
    a.out_heading, a.out_pf, a.out_pt, a.out_chunk, a.out_conf
  FROM assembled a
  WHERE
    -- When the caller has already narrowed by type, respect the fused order as-is.
    types_filter IS NOT NULL
    -- Otherwise reserve slots for structured records. Documents carry far more text
    -- than an expert or partner row, so they win both ranked lists and fill every
    -- slot: measured unfiltered, experts reached 33% recall@10 and partners 0%, while
    -- the same queries with types=['expert'] reached 100%. The records were being
    -- found and then crowded out. Reserving slots restores them at no measurable cost
    -- to documents — swept on eval/golden-set.json at limit 10:
    --   K=0  doc 100%  expert  0%  project   0%  knowledge   0%   overall 82%
    --   K=3  doc 100%  expert 50%  project 100%  knowledge 100%   overall 92%  <- chosen
    --   K=4  doc  99%  expert 67%  project 100%  knowledge 100%   overall 92%
    --   K=5  doc  94%  expert 67%                                 overall 88%
    -- K=3 is the largest reservation that leaves document recall untouched.
    OR (a.rec_kind = 'document' AND a.family_rank <= GREATEST(1, lim - entity_slots))
    OR (a.rec_kind <> 'document' AND a.family_rank <= entity_slots)
  ORDER BY a.fused_score DESC, a.out_title ASC
  LIMIT lim;
END;
$$;

REVOKE ALL ON FUNCTION public.search_corpus_hybrid(
  text, extensions.vector, text[], text, text, integer, integer, text, text, integer, boolean
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_reader') THEN
    GRANT EXECUTE ON FUNCTION public.search_corpus_hybrid(
      text, extensions.vector, text[], text, text, integer, integer, text, text, integer, boolean
    ) TO mcp_reader;
    GRANT SELECT ON public.mcp_entity_embeddings TO mcp_reader;
  END IF;
END;
$$;
