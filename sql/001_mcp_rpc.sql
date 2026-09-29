-- Phase 1 read-only retrieval for the AMANA MCP server.
-- Callers should connect as mcp_reader, which has EXECUTE on these
-- functions and no table grants.

CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

DROP FUNCTION IF EXISTS public.search_corpus(text, text[], text, text, integer, integer);

CREATE OR REPLACE FUNCTION public.search_corpus(
  p_query text,
  p_types text[] DEFAULT NULL,
  p_sector text DEFAULT NULL,
  p_donor text DEFAULT NULL,
  p_year_from integer DEFAULT NULL,
  p_result_limit integer DEFAULT 8
)
RETURNS TABLE (
  id text,
  doc_type text,
  title text,
  snippet text,
  score real
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

  RETURN QUERY
  WITH corpus AS (
    SELECT
      'expert:' || e.id AS id,
      'expert'::text AS doc_type,
      e."fullName" AS title,
      NULL::text AS sector,
      NULL::text AS donor,
      EXTRACT(YEAR FROM e."createdAt")::integer AS year,
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
      concat_ws(E'\n', k.title, k.category, k.summary, k.content, k.tags, k."practiceGroup")
    FROM "OrgKnowledgeEntry" k

    UNION ALL

    SELECT
      'gdrive:' || g.id::text,
      'document',
      COALESCE(g.title, g.file_name),
      g.sector,
      g.client_name,
      EXTRACT(YEAR FROM g.created_at)::integer,
      concat_ws(
        E'\n',
        g.title,
        g.file_name,
        g.sector,
        g.client_name,
        g.doc_type,
        g.practice_group,
        g.summary,
        left(COALESCE(g.search_text, ''), 4000)
      )
    FROM gdrive_knowledge_documents g
    WHERE g.status IS NULL OR g.status = 'ready'

    UNION ALL

    SELECT
      'storage:' || d.id::text,
      'document',
      COALESCE(d.title, d.file_name),
      d.sector,
      d.client_name,
      EXTRACT(YEAR FROM d.created_at)::integer,
      concat_ws(
        E'\n',
        d.title,
        d.file_name,
        d.sector,
        d.client_name,
        d.doc_type,
        d.practice_group,
        d.summary,
        left(COALESCE(d.search_text, ''), 4000)
      )
    FROM knowledge_documents d
    WHERE d.status IS NULL OR d.status = 'ready'
  ),
  ranked AS (
    SELECT
      c.id,
      c.doc_type,
      c.title,
      left(c.body, 700) AS snippet,
      (
        COALESCE(ts_rank_cd(to_tsvector('simple', extensions.unaccent(c.body)), q), 0)
        + CASE
            WHEN extensions.unaccent(lower(c.title)) LIKE '%' || lower(q_norm) || '%' THEN 0.45
            ELSE 0
          END
      )::real AS score
    FROM corpus c
    WHERE (types_filter IS NULL OR c.doc_type = ANY (types_filter))
      AND (
        p_sector IS NULL OR btrim(p_sector) = ''
        OR c.sector ILIKE '%' || btrim(p_sector) || '%'
      )
      AND (
        p_donor IS NULL OR btrim(p_donor) = ''
        OR c.donor ILIKE '%' || btrim(p_donor) || '%'
      )
      AND (p_year_from IS NULL OR c.year >= p_year_from)
      AND (
        (q::text <> '' AND to_tsvector('simple', extensions.unaccent(c.body)) @@ q)
        OR extensions.unaccent(lower(c.title)) LIKE '%' || lower(q_norm) || '%'
        OR extensions.unaccent(lower(c.body)) LIKE '%' || lower(q_norm) || '%'
      )
  )
  SELECT r.id, r.doc_type, r.title, r.snippet, r.score
  FROM ranked r
  ORDER BY r.score DESC, r.title ASC
  LIMIT lim;
END;
$$;

DROP FUNCTION IF EXISTS public.fetch_document(text, text);

CREATE OR REPLACE FUNCTION public.fetch_document(
  p_record_id text,
  p_section text DEFAULT NULL
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
BEGIN
  IF p_record_id IS NULL OR btrim(p_record_id) = '' THEN
    RAISE EXCEPTION 'id is required' USING ERRCODE = '22023';
  END IF;

  prefix := split_part(p_record_id, ':', 1);
  raw_id := substr(p_record_id, length(prefix) + 2);

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
      'proposalGdriveUrl', p."proposalGdriveUrl"
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

  ELSIF prefix = 'gdrive' THEN
    SELECT jsonb_build_object(
      'id', 'gdrive:' || g.id::text,
      'type', 'document',
      'title', g.title,
      'fileName', g.file_name,
      'sector', g.sector,
      'clientName', g.client_name,
      'docType', g.doc_type,
      'practiceGroup', g.practice_group,
      'gdriveUrl', g.gdrive_url,
      'summary', g.summary,
      'content', left(COALESCE(g.search_text, ''), 8000)
    )
    INTO payload
    FROM gdrive_knowledge_documents g
    WHERE g.id::text = raw_id;

  ELSIF prefix = 'storage' THEN
    SELECT jsonb_build_object(
      'id', 'storage:' || d.id::text,
      'type', 'document',
      'title', d.title,
      'fileName', d.file_name,
      'sector', d.sector,
      'clientName', d.client_name,
      'docType', d.doc_type,
      'practiceGroup', d.practice_group,
      'summary', d.summary,
      'content', left(COALESCE(d.search_text, ''), 8000)
    )
    INTO payload
    FROM knowledge_documents d
    WHERE d.id::text = raw_id;

  ELSE
    payload := NULL;
  END IF;

  IF payload IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_section IS NOT NULL AND btrim(p_section) <> '' THEN
    body := COALESCE(payload->>'content', payload->>'description', payload->>'summary', '');
    needle := btrim(p_section);
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

REVOKE ALL ON FUNCTION public.search_corpus(text, text[], text, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fetch_document(text, text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_reader') THEN
    GRANT EXECUTE ON FUNCTION public.search_corpus(text, text[], text, text, integer, integer) TO mcp_reader;
    GRANT EXECUTE ON FUNCTION public.fetch_document(text, text) TO mcp_reader;
  END IF;
END
$$;
