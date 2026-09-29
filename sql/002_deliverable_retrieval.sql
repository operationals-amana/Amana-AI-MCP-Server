-- Chunk-aware retrieval over ingested historical deliverables.
--
-- Depends on migrations/004_deliverable_ingestion.sql in the amana-proposal-agent
-- repo, which creates knowledge_chunks and the deliverable metadata columns.
--
-- What changes for callers:
--   * search_corpus gains practice_group / doc_type / year_to / include_confidential
--     parameters and returns provenance columns (source_url, page range, heading,
--     chunk id) alongside each hit.
--   * document hits are matched at chunk level, so a long report is findable by
--     any passage rather than only its first page.
--   * confidential documents are excluded unless the caller explicitly asks and
--     is allowed to.
--   * search_deliverable_chunks and fetch_chunk are added for passage retrieval.
--
-- Callers connect as mcp_reader, which holds EXECUTE on these functions and no
-- table grants.

CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- search_corpus
-- ---------------------------------------------------------------------------

-- Signature changed, so drop both the old and new shapes before recreating.
DROP FUNCTION IF EXISTS public.search_corpus(text, text[], text, text, integer, integer);
DROP FUNCTION IF EXISTS public.search_corpus(text, text[], text, text, integer, integer, text, text, integer, boolean);

CREATE OR REPLACE FUNCTION public.search_corpus(
  p_query text,
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
  q_norm text;
  allowed_conf text[];
BEGIN
  IF p_query IS NULL OR btrim(p_query) = '' THEN
    RAISE EXCEPTION 'query is required' USING ERRCODE = '22023';
  END IF;

  lim := GREATEST(1, LEAST(COALESCE(p_result_limit, 8), 20));
  types_filter := CASE
    WHEN p_types IS NULL OR cardinality(p_types) = 0 THEN NULL
    ELSE p_types
  END;
  q_norm := extensions.unaccent(btrim(p_query));
  q := plainto_tsquery('simple', q_norm);

  -- Confidential deliverables stay out of the result set unless the caller
  -- explicitly opts in. The MCP server only passes true when the request carried
  -- the privileged bearer token, so an external client cannot reach them.
  allowed_conf := CASE
    WHEN COALESCE(p_include_confidential, false)
      THEN ARRAY['public', 'internal', 'confidential']
    ELSE ARRAY['public', 'internal']
  END;

  RETURN QUERY
  WITH
  -- Structured records: still matched over a concatenated body, which is the
  -- right granularity for a row that is already short.
  records AS (
    SELECT
      'expert:' || e.id AS id,
      'expert'::text AS doc_type,
      e."fullName" AS title,
      NULL::text AS sector,
      NULL::text AS donor,
      EXTRACT(YEAR FROM e."createdAt")::integer AS year,
      NULL::text AS source_url,
      NULL::text AS client_name,
      e."practiceGroup" AS practice_group,
      NULL::integer AS document_year,
      'internal'::text AS confidentiality,
      concat_ws(
        E'\n',
        e."fullName",
        e."positionTitle",
        e."practiceGroup",
        e.grading,
        e."employmentType",
        e.education,
        e.certifications,
        e."topTechnicalSkills",
        e."selfDevelopmentAreas",
        cap.skills
      ) AS body
    FROM "Expert" e
    LEFT JOIN LATERAL (
      SELECT string_agg(c."skillName", ', ' ORDER BY c."skillName") AS skills
      FROM "ExpertCapability" c
      WHERE c."expertId" = e.id
    ) cap ON true

    UNION ALL

    SELECT
      'project:' || p.id,
      'project',
      p.title,
      p.sector,
      p.client,
      EXTRACT(YEAR FROM p."createdAt")::integer,
      p."proposalGdriveUrl",
      p.client,
      NULL,
      NULL,
      'internal',
      concat_ws(
        E'\n',
        p.title,
        p.client,
        p.sector,
        p.duration,
        p.objectives,
        p."keyOutcomes",
        p.deliverables,
        p."technologyStack",
        p."lessonsLearned"
      )
    FROM "PastProject" p

    UNION ALL

    SELECT
      'partner:' || pt.id,
      'partner',
      pt."organizationName",
      NULL,
      NULL,
      EXTRACT(YEAR FROM pt."createdAt")::integer,
      NULL,
      NULL,
      NULL,
      NULL,
      'internal',
      concat_ws(
        E'\n',
        pt."organizationName",
        pt.cluster,
        pt.affiliation,
        pt.description,
        pt.tags,
        pt.notes,
        pt."contactPerson"
      )
    FROM "PartnerContact" pt

    UNION ALL

    SELECT
      'knowledge:' || k.id,
      'knowledge',
      k.title,
      k.category,
      NULL,
      EXTRACT(YEAR FROM k."createdAt")::integer,
      k."sourceUrl",
      NULL,
      k."practiceGroup",
      NULL,
      'internal',
      concat_ws(E'\n', k.title, k.category, k.summary, k.content, k.tags, k."practiceGroup")
    FROM "OrgKnowledgeEntry" k
  ),
  ranked_records AS (
    SELECT
      r.id,
      r.doc_type,
      r.title,
      left(r.body, 700) AS snippet,
      (
        COALESCE(ts_rank_cd(to_tsvector('simple', extensions.unaccent(r.body)), q), 0)
        + CASE
            WHEN extensions.unaccent(lower(r.title)) LIKE '%' || lower(q_norm) || '%' THEN 0.45
            ELSE 0
          END
      )::real AS score,
      r.source_url,
      r.client_name,
      r.practice_group,
      r.document_year,
      NULL::text AS heading,
      NULL::integer AS page_from,
      NULL::integer AS page_to,
      NULL::bigint AS chunk_id,
      r.confidentiality
    FROM records r
    WHERE (types_filter IS NULL OR r.doc_type = ANY (types_filter))
      -- p_doc_type describes deliverable genres (final_report, proposal, …),
      -- which structured records do not carry; supplying it therefore narrows
      -- the search to ingested documents only.
      AND (p_doc_type IS NULL OR btrim(p_doc_type) = '')
      AND (
        p_sector IS NULL OR btrim(p_sector) = ''
        OR r.sector ILIKE '%' || btrim(p_sector) || '%'
      )
      AND (
        p_donor IS NULL OR btrim(p_donor) = ''
        OR r.donor ILIKE '%' || btrim(p_donor) || '%'
      )
      AND (
        p_practice_group IS NULL OR btrim(p_practice_group) = ''
        OR r.practice_group ILIKE '%' || btrim(p_practice_group) || '%'
      )
      AND (p_year_from IS NULL OR r.year >= p_year_from)
      AND (p_year_to IS NULL OR r.year <= p_year_to)
      AND (
        (q::text <> '' AND to_tsvector('simple', extensions.unaccent(r.body)) @@ q)
        OR extensions.unaccent(lower(r.title)) LIKE '%' || lower(q_norm) || '%'
        OR extensions.unaccent(lower(r.body)) LIKE '%' || lower(q_norm) || '%'
      )
  ),
  -- Ingested deliverables, matched passage by passage. Documents are joined to
  -- their chunks so a hit can name the heading and page it came from.
  documents AS (
    SELECT
      'gdrive:' || g.id::text AS doc_key,
      COALESCE(g.title, g.file_name) AS title,
      g.sector,
      g.client_name,
      g.practice_group,
      g.doc_type,
      COALESCE(g.document_year, EXTRACT(YEAR FROM g.created_at)::integer) AS year,
      COALESCE(g.source_url, g.gdrive_url) AS source_url,
      g.confidentiality,
      g.id AS document_id,
      'gdrive_knowledge_documents'::text AS source_table,
      g.summary,
      g.search_text,
      g.topics
    FROM gdrive_knowledge_documents g
    WHERE g.status = 'ready'
      AND g.archived_at IS NULL

    UNION ALL

    SELECT
      'storage:' || d.id::text,
      COALESCE(d.title, d.file_name),
      d.sector,
      d.client_name,
      d.practice_group,
      d.doc_type,
      COALESCE(d.document_year, EXTRACT(YEAR FROM d.created_at)::integer),
      d.source_url,
      d.confidentiality,
      d.id,
      'knowledge_documents'::text,
      d.summary,
      d.search_text,
      d.topics
    FROM knowledge_documents d
    WHERE d.status = 'ready'
      AND d.archived_at IS NULL
  ),
  eligible_documents AS (
    SELECT *
    FROM documents doc
    WHERE doc.confidentiality = ANY (allowed_conf)
      AND (types_filter IS NULL OR 'document' = ANY (types_filter))
      AND (
        p_sector IS NULL OR btrim(p_sector) = ''
        OR doc.sector ILIKE '%' || btrim(p_sector) || '%'
      )
      AND (
        p_donor IS NULL OR btrim(p_donor) = ''
        OR doc.client_name ILIKE '%' || btrim(p_donor) || '%'
      )
      AND (
        p_practice_group IS NULL OR btrim(p_practice_group) = ''
        OR doc.practice_group ILIKE '%' || btrim(p_practice_group) || '%'
      )
      AND (
        p_doc_type IS NULL OR btrim(p_doc_type) = ''
        OR doc.doc_type = btrim(p_doc_type)
      )
      AND (p_year_from IS NULL OR doc.year >= p_year_from)
      AND (p_year_to IS NULL OR doc.year <= p_year_to)
  ),
  -- Best-scoring passage per document, so one long report cannot fill the whole
  -- result set with near-identical chunks.
  chunk_hits AS (
    SELECT DISTINCT ON (doc.doc_key)
      doc.doc_key,
      doc.title,
      doc.source_url,
      doc.client_name,
      doc.practice_group,
      doc.year,
      doc.confidentiality,
      c.id AS chunk_id,
      c.heading,
      c.page_from,
      c.page_to,
      left(c.content, 900) AS snippet,
      (
        COALESCE(ts_rank_cd(c.content_tsv, q), 0)
        + CASE
            WHEN extensions.unaccent(lower(doc.title)) LIKE '%' || lower(q_norm) || '%'
              THEN 0.45
            ELSE 0
          END
        + CASE
            WHEN c.heading IS NOT NULL
             AND extensions.unaccent(lower(c.heading)) LIKE '%' || lower(q_norm) || '%'
              THEN 0.25
            ELSE 0
          END
        + CASE
            WHEN doc.topics IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM unnest(doc.topics) t
               WHERE lower(t) LIKE '%' || lower(q_norm) || '%'
             )
              THEN 0.15
            ELSE 0
          END
      )::real AS score
    FROM eligible_documents doc
    JOIN knowledge_chunks c
      ON c.source_table = doc.source_table
     AND c.document_id = doc.document_id
    WHERE
      (q::text <> '' AND c.content_tsv @@ q)
      OR extensions.unaccent(lower(doc.title)) LIKE '%' || lower(q_norm) || '%'
      OR extensions.unaccent(lower(c.content)) LIKE '%' || lower(q_norm) || '%'
    ORDER BY doc.doc_key, score DESC, c.chunk_index ASC
  ),
  -- Documents that have no chunks at all — ingested before chunking existed and
  -- not yet re-indexed — are still findable through their document-level text.
  -- Without this they would silently vanish from search after this migration.
  --
  -- Scoped to unchunked documents on purpose: chunk_hits already admits a
  -- title match on any chunked document, so if a chunked document produced no
  -- hit it genuinely does not match, and re-scanning its search_text here would
  -- cost an unindexed tsvector build per row for no additional recall.
  document_fallback AS (
    SELECT
      doc.doc_key,
      doc.title,
      doc.source_url,
      doc.client_name,
      doc.practice_group,
      doc.year,
      doc.confidentiality,
      NULL::bigint AS chunk_id,
      NULL::text AS heading,
      NULL::integer AS page_from,
      NULL::integer AS page_to,
      left(
        concat_ws(E'\n', doc.title, doc.client_name, doc.summary,
                  left(COALESCE(doc.search_text, ''), 4000)),
        700
      ) AS snippet,
      (
        COALESCE(
          ts_rank_cd(
            to_tsvector('simple', extensions.unaccent(COALESCE(doc.search_text, ''))), q
          ), 0
        )
        + CASE
            WHEN extensions.unaccent(lower(doc.title)) LIKE '%' || lower(q_norm) || '%'
              THEN 0.45
            ELSE 0
          END
        -- Ranked below chunk hits: a whole-document match is weaker evidence than
        -- a passage that actually contains the query.
        - 0.05
      )::real AS score
    FROM eligible_documents doc
    WHERE NOT EXISTS (
        SELECT 1 FROM knowledge_chunks c
        WHERE c.source_table = doc.source_table
          AND c.document_id = doc.document_id
      )
      AND (
        (q::text <> ''
          AND to_tsvector('simple', extensions.unaccent(COALESCE(doc.search_text, ''))) @@ q)
        OR extensions.unaccent(lower(doc.title)) LIKE '%' || lower(q_norm) || '%'
      )
  ),
  combined AS (
    SELECT
      rr.id, rr.doc_type, rr.title, rr.snippet, rr.score, rr.source_url,
      rr.client_name, rr.practice_group, rr.document_year, rr.heading,
      rr.page_from, rr.page_to, rr.chunk_id, rr.confidentiality
    FROM ranked_records rr

    UNION ALL

    SELECT
      ch.doc_key, 'document'::text, ch.title, ch.snippet, ch.score, ch.source_url,
      ch.client_name, ch.practice_group, ch.year, ch.heading, ch.page_from,
      ch.page_to, ch.chunk_id, ch.confidentiality
    FROM chunk_hits ch

    UNION ALL

    SELECT
      df.doc_key, 'document'::text, df.title, df.snippet, df.score, df.source_url,
      df.client_name, df.practice_group, df.year, df.heading, df.page_from,
      df.page_to, df.chunk_id, df.confidentiality
    FROM document_fallback df
  )
  SELECT
    c.id, c.doc_type, c.title, c.snippet, c.score, c.source_url, c.client_name,
    c.practice_group, c.document_year, c.heading, c.page_from, c.page_to,
    c.chunk_id, c.confidentiality
  FROM combined c
  ORDER BY c.score DESC, c.title ASC
  LIMIT lim;
END;
$$;

-- ---------------------------------------------------------------------------
-- search_deliverable_chunks: several passages from one or many deliverables
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.search_deliverable_chunks(text, text, integer, boolean);

CREATE OR REPLACE FUNCTION public.search_deliverable_chunks(
  p_query text,
  p_document_id text DEFAULT NULL,
  p_result_limit integer DEFAULT 10,
  p_include_confidential boolean DEFAULT false
)
RETURNS TABLE (
  chunk_id bigint,
  document_id text,
  title text,
  heading text,
  content text,
  page_from integer,
  page_to integer,
  source_url text,
  score real
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  q tsquery;
  q_norm text;
  lim integer;
  allowed_conf text[];
  want_prefix text;
  want_id text;
BEGIN
  IF p_query IS NULL OR btrim(p_query) = '' THEN
    RAISE EXCEPTION 'query is required' USING ERRCODE = '22023';
  END IF;

  lim := GREATEST(1, LEAST(COALESCE(p_result_limit, 10), 30));
  q_norm := extensions.unaccent(btrim(p_query));
  q := plainto_tsquery('simple', q_norm);
  allowed_conf := CASE
    WHEN COALESCE(p_include_confidential, false)
      THEN ARRAY['public', 'internal', 'confidential']
    ELSE ARRAY['public', 'internal']
  END;

  IF p_document_id IS NOT NULL AND btrim(p_document_id) <> '' THEN
    want_prefix := split_part(btrim(p_document_id), ':', 1);
    want_id := substr(btrim(p_document_id), length(want_prefix) + 2);
  END IF;

  RETURN QUERY
  WITH documents AS (
    SELECT
      'gdrive:' || g.id::text AS doc_key,
      COALESCE(g.title, g.file_name) AS title,
      COALESCE(g.source_url, g.gdrive_url) AS source_url,
      g.confidentiality,
      g.id AS document_id,
      'gdrive_knowledge_documents'::text AS source_table,
      'gdrive'::text AS prefix
    FROM gdrive_knowledge_documents g
    WHERE g.status = 'ready' AND g.archived_at IS NULL

    UNION ALL

    SELECT
      'storage:' || d.id::text,
      COALESCE(d.title, d.file_name),
      d.source_url,
      d.confidentiality,
      d.id,
      'knowledge_documents'::text,
      'storage'::text
    FROM knowledge_documents d
    WHERE d.status = 'ready' AND d.archived_at IS NULL
  )
  SELECT
    c.id,
    doc.doc_key,
    doc.title,
    c.heading,
    c.content,
    c.page_from,
    c.page_to,
    doc.source_url,
    (
      COALESCE(ts_rank_cd(c.content_tsv, q), 0)
      + CASE
          WHEN c.heading IS NOT NULL
           AND extensions.unaccent(lower(c.heading)) LIKE '%' || lower(q_norm) || '%'
            THEN 0.25
          ELSE 0
        END
    )::real AS score
  FROM documents doc
  JOIN knowledge_chunks c
    ON c.source_table = doc.source_table
   AND c.document_id = doc.document_id
  WHERE doc.confidentiality = ANY (allowed_conf)
    AND (
      want_id IS NULL
      OR (doc.prefix = want_prefix AND doc.document_id::text = want_id)
    )
    AND (
      (q::text <> '' AND c.content_tsv @@ q)
      OR extensions.unaccent(lower(c.content)) LIKE '%' || lower(q_norm) || '%'
    )
  ORDER BY 9 DESC, c.chunk_index ASC
  LIMIT lim;
END;
$$;

-- ---------------------------------------------------------------------------
-- fetch_document: deliverable metadata, provenance, and outline
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.fetch_document(text, text);
DROP FUNCTION IF EXISTS public.fetch_document(text, text, boolean);

CREATE OR REPLACE FUNCTION public.fetch_document(
  p_record_id text,
  p_section text DEFAULT NULL,
  p_include_confidential boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  prefix text;
  raw_id text;
  payload jsonb;
  body text;
  needle text;
  pos integer;
  doc_conf text;
  allowed_conf text[];
  section_payload jsonb;
BEGIN
  IF p_record_id IS NULL OR btrim(p_record_id) = '' THEN
    RAISE EXCEPTION 'id is required' USING ERRCODE = '22023';
  END IF;

  prefix := split_part(p_record_id, ':', 1);
  raw_id := substr(p_record_id, length(prefix) + 2);
  allowed_conf := CASE
    WHEN COALESCE(p_include_confidential, false)
      THEN ARRAY['public', 'internal', 'confidential']
    ELSE ARRAY['public', 'internal']
  END;

  IF prefix = 'expert' THEN
    SELECT jsonb_build_object(
      'id', 'expert:' || e.id,
      'type', 'expert',
      'fullName', e."fullName",
      'positionTitle', e."positionTitle",
      'practiceGroup', e."practiceGroup",
      'grading', e.grading,
      'employmentType', e."employmentType",
      'yearsOfExperience', e."yearsOfExperience",
      'education', e.education,
      'certifications', e.certifications,
      'topTechnicalSkills', e."topTechnicalSkills",
      'selfDevelopmentAreas', e."selfDevelopmentAreas",
      'cvUrl', e."cvUrl",
      'email', e.email,
      'capabilities', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'skillName', c."skillName",
          'domainName', c."domainName",
          'level', c.level
        ) ORDER BY c."skillName")
        FROM "ExpertCapability" c
        WHERE c."expertId" = e.id
      ), '[]'::jsonb)
    )
    INTO payload
    FROM "Expert" e
    WHERE e.id = raw_id;

  ELSIF prefix = 'project' THEN
    SELECT jsonb_build_object(
      'id', 'project:' || p.id,
      'type', 'project',
      'title', p.title,
      'client', p.client,
      'sector', p.sector,
      'duration', p.duration,
      'objectives', p.objectives,
      'keyOutcomes', p."keyOutcomes",
      'deliverables', p.deliverables,
      'technologyStack', p."technologyStack",
      'lessonsLearned', p."lessonsLearned",
      'qcScore', p."qcScore",
      'proposalGdriveUrl', p."proposalGdriveUrl",
      'sourceUrl', p."proposalGdriveUrl"
    )
    INTO payload
    FROM "PastProject" p
    WHERE p.id = raw_id;

  ELSIF prefix = 'partner' THEN
    SELECT jsonb_build_object(
      'id', 'partner:' || pt.id,
      'type', 'partner',
      'organizationName', pt."organizationName",
      'description', left(COALESCE(pt.description, ''), 8000),
      'affiliation', pt.affiliation,
      'cluster', pt.cluster,
      'contactPerson', pt."contactPerson",
      'tags', pt.tags,
      'notes', left(COALESCE(pt.notes, ''), 2000)
    )
    INTO payload
    FROM "PartnerContact" pt
    WHERE pt.id = raw_id;

  ELSIF prefix = 'knowledge' THEN
    SELECT jsonb_build_object(
      'id', 'knowledge:' || k.id,
      'type', 'knowledge',
      'title', k.title,
      'category', k.category,
      'summary', k.summary,
      'content', left(COALESCE(k.content, ''), 8000),
      'tags', k.tags,
      'sourceUrl', k."sourceUrl",
      'practiceGroup', k."practiceGroup"
    )
    INTO payload
    FROM "OrgKnowledgeEntry" k
    WHERE k.id = raw_id;

  ELSIF prefix IN ('gdrive', 'storage') THEN
    -- Both deliverable tables share a shape; build the payload from whichever
    -- one holds the id, including a chunk outline so a caller can ask for a
    -- specific passage next.
    IF prefix = 'gdrive' THEN
      SELECT g.confidentiality INTO doc_conf
      FROM gdrive_knowledge_documents g
      WHERE g.id::text = raw_id;
    ELSE
      SELECT d.confidentiality INTO doc_conf
      FROM knowledge_documents d
      WHERE d.id::text = raw_id;
    END IF;

    IF doc_conf IS NOT NULL AND NOT (doc_conf = ANY (allowed_conf)) THEN
      -- Acknowledge that the record exists and point at the source, but return
      -- no content. Naming the document lets the assistant route a human to it
      -- without the restricted text passing through an MCP client.
      IF prefix = 'gdrive' THEN
        SELECT jsonb_build_object(
          'id', 'gdrive:' || g.id::text,
          'type', 'document',
          'title', COALESCE(g.title, g.file_name),
          'confidentiality', g.confidentiality,
          'sourceUrl', COALESCE(g.source_url, g.gdrive_url),
          'restricted', true,
          'note', 'This deliverable is marked confidential. Content is withheld; '
                  'open the source link with appropriate authorisation.'
        )
        INTO payload
        FROM gdrive_knowledge_documents g
        WHERE g.id::text = raw_id;
      ELSE
        SELECT jsonb_build_object(
          'id', 'storage:' || d.id::text,
          'type', 'document',
          'title', COALESCE(d.title, d.file_name),
          'confidentiality', d.confidentiality,
          'sourceUrl', d.source_url,
          'restricted', true,
          'note', 'This deliverable is marked confidential. Content is withheld; '
                  'open the source link with appropriate authorisation.'
        )
        INTO payload
        FROM knowledge_documents d
        WHERE d.id::text = raw_id;
      END IF;
      RETURN payload;
    END IF;

    IF prefix = 'gdrive' THEN
      SELECT jsonb_build_object(
        'id', 'gdrive:' || g.id::text,
        'type', 'document',
        'title', COALESCE(g.title, g.file_name),
        'fileName', g.file_name,
        'docType', g.doc_type,
        'projectName', g.project_name,
        'clientName', g.client_name,
        'sector', g.sector,
        'practiceGroup', g.practice_group,
        'documentYear', g.document_year,
        'topics', to_jsonb(g.topics),
        'authors', to_jsonb(g.authors),
        'confidentiality', g.confidentiality,
        'sourceUrl', COALESCE(g.source_url, g.gdrive_url),
        'folderPath', g.folder_path,
        'pageCount', g.page_count,
        'chunkCount', g.chunk_count,
        'lastUpdatedAt', to_char(
          COALESCE(g.source_modified_at, g.updated_at), 'YYYY-MM-DD"T"HH24:MI:SSOF'
        ),
        'lastIngestedAt', to_char(g.last_ingested_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
        'summary', g.summary,
        'content', left(COALESCE(g.search_text, ''), 8000),
        'outline', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'chunkId', c.id,
            'chunkIndex', c.chunk_index,
            'heading', c.heading,
            'pageFrom', c.page_from,
            'pageTo', c.page_to
          ) ORDER BY c.chunk_index)
          FROM knowledge_chunks c
          WHERE c.source_table = 'gdrive_knowledge_documents'
            AND c.document_id = g.id
        ), '[]'::jsonb)
      )
      INTO payload
      FROM gdrive_knowledge_documents g
      WHERE g.id::text = raw_id;
    ELSE
      SELECT jsonb_build_object(
        'id', 'storage:' || d.id::text,
        'type', 'document',
        'title', COALESCE(d.title, d.file_name),
        'fileName', d.file_name,
        'docType', d.doc_type,
        'projectName', d.project_name,
        'clientName', d.client_name,
        'sector', d.sector,
        'practiceGroup', d.practice_group,
        'documentYear', d.document_year,
        'topics', to_jsonb(d.topics),
        'authors', to_jsonb(d.authors),
        'confidentiality', d.confidentiality,
        'sourceUrl', d.source_url,
        'pageCount', d.page_count,
        'chunkCount', d.chunk_count,
        'lastUpdatedAt', to_char(
          COALESCE(d.source_modified_at, d.updated_at), 'YYYY-MM-DD"T"HH24:MI:SSOF'
        ),
        'lastIngestedAt', to_char(d.last_ingested_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
        'summary', d.summary,
        'content', left(COALESCE(d.search_text, ''), 8000),
        'outline', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'chunkId', c.id,
            'chunkIndex', c.chunk_index,
            'heading', c.heading,
            'pageFrom', c.page_from,
            'pageTo', c.page_to
          ) ORDER BY c.chunk_index)
          FROM knowledge_chunks c
          WHERE c.source_table = 'knowledge_documents'
            AND c.document_id = d.id
        ), '[]'::jsonb)
      )
      INTO payload
      FROM knowledge_documents d
      WHERE d.id::text = raw_id;
    END IF;

  ELSE
    payload := NULL;
  END IF;

  IF payload IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_section IS NOT NULL AND btrim(p_section) <> '' THEN
    needle := btrim(p_section);

    -- For a chunked deliverable, resolve the section against real chunk headings
    -- rather than a substring of a truncated body, so the extract carries page
    -- provenance.
    IF prefix IN ('gdrive', 'storage') AND (payload->>'chunkCount')::integer > 0 THEN
      SELECT jsonb_build_object(
        'section', needle,
        'sectionChunks', COALESCE(jsonb_agg(jsonb_build_object(
          'chunkId', s.id,
          'heading', s.heading,
          'pageFrom', s.page_from,
          'pageTo', s.page_to,
          'content', s.content
        ) ORDER BY s.chunk_index), '[]'::jsonb)
      )
      INTO section_payload
      FROM (
        SELECT c.*
        FROM knowledge_chunks c
        WHERE c.source_table = CASE
                                 WHEN prefix = 'gdrive' THEN 'gdrive_knowledge_documents'
                                 ELSE 'knowledge_documents'
                               END
          AND c.document_id::text = raw_id
          AND (
            (c.heading IS NOT NULL
              AND extensions.unaccent(lower(c.heading)) LIKE '%' || lower(needle) || '%')
            OR extensions.unaccent(lower(c.content)) LIKE '%' || lower(needle) || '%'
          )
        ORDER BY c.chunk_index
        LIMIT 4
      ) s;

      -- jsonb_agg over no rows yields an empty array, not NULL, so test the
      -- array length; otherwise this branch would always win and the
      -- substring fallback below could never run.
      IF jsonb_array_length(COALESCE(section_payload->'sectionChunks', '[]'::jsonb)) > 0 THEN
        payload := payload || section_payload;
        RETURN payload;
      END IF;
    END IF;

    body := COALESCE(payload->>'content', payload->>'description', payload->>'summary', '');
    pos := position(lower(needle) IN lower(body));
    IF pos > 0 THEN
      payload := payload || jsonb_build_object(
        'section', needle,
        'sectionExtract', substr(body, GREATEST(pos - 80, 1), 1200)
      );
    ELSE
      payload := payload || jsonb_build_object(
        'section', needle,
        'sectionExtract', NULL,
        'sectionNote', 'Section text not found; returning the full record.'
      );
    END IF;
  END IF;

  RETURN payload;
END;
$$;

-- ---------------------------------------------------------------------------
-- ingestion_status: admin-facing view of the pipeline
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.ingestion_status(integer);

CREATE OR REPLACE FUNCTION public.ingestion_status(p_recent_runs integer DEFAULT 5)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT jsonb_build_object(
    'totals', (
      SELECT jsonb_build_object(
        'ready', COUNT(*) FILTER (WHERE status = 'ready'),
        'failed', COUNT(*) FILTER (WHERE status = 'failed'),
        'archived', COUNT(*) FILTER (WHERE status = 'archived'),
        'confidential', COUNT(*) FILTER (WHERE confidentiality = 'confidential'),
        'chunks', COALESCE(SUM(chunk_count) FILTER (WHERE status = 'ready'), 0)
      )
      FROM gdrive_knowledge_documents
    ),
    'lastRun', (
      SELECT to_jsonb(r) FROM (
        SELECT id, status, mode, trigger, started_at, finished_at, files_seen,
               files_ingested, files_updated, files_skipped, files_failed,
               files_archived, chunks_written, error
        FROM ingestion_runs
        ORDER BY started_at DESC
        LIMIT 1
      ) r
    ),
    'recentRuns', COALESCE((
      SELECT jsonb_agg(to_jsonb(r) ORDER BY r.started_at DESC) FROM (
        SELECT id, status, mode, trigger, started_at, finished_at, files_seen,
               files_ingested, files_updated, files_failed, chunks_written
        FROM ingestion_runs
        ORDER BY started_at DESC
        LIMIT GREATEST(1, LEAST(COALESCE(p_recent_runs, 5), 50))
      ) r
    ), '[]'::jsonb),
    'failures', COALESCE((
      SELECT jsonb_agg(to_jsonb(f) ORDER BY f.updated_at DESC) FROM (
        SELECT id, file_name, folder_path, source_url, ingest_error,
               ingest_attempts, updated_at
        FROM gdrive_knowledge_documents
        WHERE status = 'failed'
        ORDER BY updated_at DESC
        LIMIT 25
      ) f
    ), '[]'::jsonb)
  );
$$;

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.search_corpus(
  text, text[], text, text, integer, integer, text, text, integer, boolean
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.search_deliverable_chunks(text, text, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fetch_document(text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ingestion_status(integer) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_reader') THEN
    GRANT EXECUTE ON FUNCTION public.search_corpus(
      text, text[], text, text, integer, integer, text, text, integer, boolean
    ) TO mcp_reader;
    GRANT EXECUTE ON FUNCTION public.search_deliverable_chunks(
      text, text, integer, boolean
    ) TO mcp_reader;
    GRANT EXECUTE ON FUNCTION public.fetch_document(text, text, boolean) TO mcp_reader;
    GRANT EXECUTE ON FUNCTION public.ingestion_status(integer) TO mcp_reader;
  END IF;
END
$$;
