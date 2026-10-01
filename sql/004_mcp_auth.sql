-- Authenticated access control and request auditing for the MCP server.
--
-- Before this migration the server authenticated with a shared static bearer
-- token: anyone holding the string could attach the server to their own Claude,
-- and no request could be attributed to a person. This adds the storage behind a
-- real OAuth 2.1 authorization server that delegates login to Google and admits
-- only @amana.id accounts that already exist in the dashboard's User table, so
-- an MCP session carries the same identity — and the same role — as the
-- dashboard session belonging to that person.
--
-- Two things differ from the retrieval migrations. First, the server writes
-- here, so mcp_reader gets table-level DML on these tables specifically, rather
-- than only EXECUTE on functions. Second, identity is read out of the
-- Prisma-owned "User" table, which mcp_reader must not be able to read directly
-- (it holds bcrypt password hashes) — mcp_lookup_user is a SECURITY DEFINER
-- keyhole that returns identity and role and nothing else.
--
-- Every table here is prefixed mcp_ and owned by this repo, so a later
-- `prisma migrate` in amana-ai-operational cannot drop it.

-- ---------------------------------------------------------------------------
-- mcp_oauth_client
-- ---------------------------------------------------------------------------
--
-- Clients registered through RFC 7591 Dynamic Client Registration. Claude
-- registers a fresh client on every new connection, so rows accumulate; the
-- garbage collector below drops ones that never completed a flow.

CREATE TABLE IF NOT EXISTS public.mcp_oauth_client (
  client_id                   text PRIMARY KEY,
  client_secret_hash          text,
  client_name                 text,
  redirect_uris               text[] NOT NULL,
  grant_types                 text[] NOT NULL DEFAULT ARRAY['authorization_code', 'refresh_token'],
  response_types              text[] NOT NULL DEFAULT ARRAY['code'],
  token_endpoint_auth_method  text NOT NULL DEFAULT 'none',
  scope                       text,
  client_uri                  text,
  software_id                 text,
  software_version            text,
  metadata                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  last_used_at                timestamptz
);

-- ---------------------------------------------------------------------------
-- mcp_oauth_flow
-- ---------------------------------------------------------------------------
--
-- One authorization request in flight. The client's /authorize parameters have
-- to survive the round trip to Google and back, and the row id doubles as the
-- `state` we hand Google, which is what ties Google's callback back to the
-- originating client request.
--
-- stage moves awaiting_google -> awaiting_consent -> consumed. It never moves
-- backwards, so a replayed Google callback or a resubmitted consent form cannot
-- mint a second authorization code from one login.

CREATE TABLE IF NOT EXISTS public.mcp_oauth_flow (
  id                    text PRIMARY KEY,
  client_id             text NOT NULL REFERENCES public.mcp_oauth_client(client_id) ON DELETE CASCADE,
  redirect_uri          text NOT NULL,
  client_state          text,
  code_challenge        text NOT NULL,
  code_challenge_method text NOT NULL,
  scope                 text NOT NULL,
  resource              text,
  stage                 text NOT NULL DEFAULT 'awaiting_google',
  google_nonce          text NOT NULL,
  user_id               text,
  user_email            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  CONSTRAINT mcp_oauth_flow_stage_check
    CHECK (stage IN ('awaiting_google', 'awaiting_consent', 'consumed'))
);

CREATE INDEX IF NOT EXISTS mcp_oauth_flow_expires_idx
  ON public.mcp_oauth_flow (expires_at);

-- ---------------------------------------------------------------------------
-- mcp_oauth_code
-- ---------------------------------------------------------------------------
--
-- Authorization codes, stored as SHA-256 hashes so a database read cannot
-- replay one. consumed_at makes the single-use rule enforceable rather than
-- advisory: redemption is an UPDATE ... WHERE consumed_at IS NULL RETURNING,
-- which two concurrent redemptions cannot both win.

CREATE TABLE IF NOT EXISTS public.mcp_oauth_code (
  code_hash      text PRIMARY KEY,
  client_id      text NOT NULL REFERENCES public.mcp_oauth_client(client_id) ON DELETE CASCADE,
  user_id        text NOT NULL,
  user_email     text NOT NULL,
  redirect_uri   text NOT NULL,
  code_challenge text NOT NULL,
  scope          text NOT NULL,
  resource       text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz
);

CREATE INDEX IF NOT EXISTS mcp_oauth_code_expires_idx
  ON public.mcp_oauth_code (expires_at);

-- ---------------------------------------------------------------------------
-- mcp_access_token / mcp_refresh_token
-- ---------------------------------------------------------------------------
--
-- Both are opaque random strings, stored hashed. The access token row is what
-- every MCP request is authenticated against, which is what links a request to
-- a person; scope is frozen at issue time so revoking a role in the dashboard
-- takes effect at the next refresh rather than mid-session.

CREATE TABLE IF NOT EXISTS public.mcp_access_token (
  token_hash   text PRIMARY KEY,
  client_id    text NOT NULL,
  user_id      text NOT NULL,
  user_email   text NOT NULL,
  scope        text NOT NULL,
  resource     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at   timestamptz
);

CREATE INDEX IF NOT EXISTS mcp_access_token_user_idx
  ON public.mcp_access_token (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mcp_access_token_expires_idx
  ON public.mcp_access_token (expires_at);

CREATE TABLE IF NOT EXISTS public.mcp_refresh_token (
  token_hash   text PRIMARY KEY,
  client_id    text NOT NULL,
  user_id      text NOT NULL,
  user_email   text NOT NULL,
  scope        text NOT NULL,
  resource     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  -- Set when this token was exchanged for a successor. Keeping the row lets a
  -- replay of the retired token be recognised as theft rather than as an
  -- unknown token, which is why rotation invalidates the whole family.
  rotated_to   text
);

CREATE INDEX IF NOT EXISTS mcp_refresh_token_user_idx
  ON public.mcp_refresh_token (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mcp_refresh_token_expires_idx
  ON public.mcp_refresh_token (expires_at);

-- ---------------------------------------------------------------------------
-- mcp_auth_event
-- ---------------------------------------------------------------------------
--
-- The authentication audit trail: who signed in, and — more usefully — who was
-- turned away and why. A run of domain_rejected rows for one address is
-- somebody outside AMANA trying to attach the server to their own Claude.

CREATE TABLE IF NOT EXISTS public.mcp_auth_event (
  id         bigserial PRIMARY KEY,
  ts         timestamptz NOT NULL DEFAULT now(),
  event      text NOT NULL,
  email      text,
  user_id    text,
  client_id  text,
  client_name text,
  ip         text,
  user_agent text,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS mcp_auth_event_ts_idx
  ON public.mcp_auth_event (ts DESC);
CREATE INDEX IF NOT EXISTS mcp_auth_event_email_idx
  ON public.mcp_auth_event (email, ts DESC);

-- ---------------------------------------------------------------------------
-- mcp_request_log
-- ---------------------------------------------------------------------------
--
-- One row per tool call, carrying the caller, the arguments, and the ids of the
-- records that were returned. source_ids is the part that matters for an audit:
-- it answers "which documents has this person pulled through Claude", which
-- neither the access log nor the Postgres log can answer.

CREATE TABLE IF NOT EXISTS public.mcp_request_log (
  id                     bigserial PRIMARY KEY,
  ts                     timestamptz NOT NULL DEFAULT now(),
  user_id                text,
  user_email             text,
  user_role              text,
  user_practice_group    text,
  client_id              text,
  client_name            text,
  tool                   text NOT NULL,
  arguments              jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_count              integer,
  source_ids             text[],
  confidential_permitted boolean NOT NULL DEFAULT false,
  outcome                text NOT NULL DEFAULT 'ok',
  error                  text,
  duration_ms            integer,
  ip                     text,
  user_agent             text
);

-- Added after the table shipped; CREATE TABLE IF NOT EXISTS would not have
-- reached an existing deployment, and this file has to stay re-runnable.
ALTER TABLE public.mcp_request_log
  ADD COLUMN IF NOT EXISTS user_practice_group text;

CREATE INDEX IF NOT EXISTS mcp_request_log_ts_idx
  ON public.mcp_request_log (ts DESC);
CREATE INDEX IF NOT EXISTS mcp_request_log_user_idx
  ON public.mcp_request_log (user_id, ts DESC);
CREATE INDEX IF NOT EXISTS mcp_request_log_tool_idx
  ON public.mcp_request_log (tool, ts DESC);

-- ---------------------------------------------------------------------------
-- mcp_lookup_user
-- ---------------------------------------------------------------------------
--
-- Resolves a Google-verified email address to the dashboard user behind it.
--
-- This is the single point where MCP access is decided, and it is deliberately a
-- lookup rather than an upsert: a person gets MCP access only once they exist in
-- the dashboard, which keeps provisioning in one place (an admin in the
-- dashboard, or the dashboard's own first Google sign-in) and means an @amana.id
-- address that AMANA has never onboarded cannot reach the corpus.
--
-- SECURITY DEFINER because mcp_reader has no grant on "User" and must not get
-- one: that table holds bcrypt password hashes. The function returns identity
-- and role only. It is STABLE and takes its argument already normalised.

CREATE OR REPLACE FUNCTION public.mcp_lookup_user(p_email text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
           'id', u.id,
           'email', u.email,
           'name', u.name,
           'role', u.role,
           'practiceGroup', u."practiceGroup"
         )
  FROM public."User" u
  WHERE lower(u.email) = lower(p_email)
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.mcp_lookup_user(text) IS
  'Resolve an email to the dashboard User identity and role for MCP authorization. '
  'Returns NULL when the person has no dashboard account, which denies MCP access.';

-- ---------------------------------------------------------------------------
-- mcp_auth_gc
-- ---------------------------------------------------------------------------
--
-- Housekeeping for the short-lived rows. Claude's Dynamic Client Registration
-- creates a client per connection, so without this the client table grows
-- without bound; a client is only dropped when it never reached a token, so
-- live connections are never cut.
--
-- Audit rows (mcp_auth_event, mcp_request_log) are never touched here — they are
-- the record the acceptance criteria ask for, and retention is a policy
-- decision, not garbage collection.

CREATE OR REPLACE FUNCTION public.mcp_auth_gc(p_client_grace interval DEFAULT '7 days')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_flows    integer;
  v_codes    integer;
  v_access   integer;
  v_refresh  integer;
  v_clients  integer;
BEGIN
  DELETE FROM public.mcp_oauth_flow WHERE expires_at < now() - interval '1 day';
  GET DIAGNOSTICS v_flows = ROW_COUNT;

  DELETE FROM public.mcp_oauth_code WHERE expires_at < now() - interval '1 day';
  GET DIAGNOSTICS v_codes = ROW_COUNT;

  DELETE FROM public.mcp_access_token WHERE expires_at < now() - interval '30 days';
  GET DIAGNOSTICS v_access = ROW_COUNT;

  DELETE FROM public.mcp_refresh_token WHERE expires_at < now() - interval '30 days';
  GET DIAGNOSTICS v_refresh = ROW_COUNT;

  DELETE FROM public.mcp_oauth_client c
  WHERE c.created_at < now() - p_client_grace
    AND NOT EXISTS (SELECT 1 FROM public.mcp_access_token t WHERE t.client_id = c.client_id)
    AND NOT EXISTS (SELECT 1 FROM public.mcp_refresh_token t WHERE t.client_id = c.client_id);
  GET DIAGNOSTICS v_clients = ROW_COUNT;

  RETURN jsonb_build_object(
    'flows', v_flows,
    'codes', v_codes,
    'accessTokens', v_access,
    'refreshTokens', v_refresh,
    'clients', v_clients
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------
--
-- Retrieval stays function-only, as before. The auth and audit tables are the
-- one place the server writes, so mcp_reader gets DML on exactly those tables
-- and nothing else — notably no DELETE on the two audit tables, so a
-- compromised server credential cannot erase its own trail.

REVOKE ALL ON FUNCTION public.mcp_lookup_user(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mcp_auth_gc(interval) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_reader') THEN
    GRANT EXECUTE ON FUNCTION public.mcp_lookup_user(text) TO mcp_reader;
    GRANT EXECUTE ON FUNCTION public.mcp_auth_gc(interval) TO mcp_reader;

    GRANT SELECT, INSERT, UPDATE, DELETE ON
      public.mcp_oauth_client,
      public.mcp_oauth_flow,
      public.mcp_oauth_code,
      public.mcp_access_token,
      public.mcp_refresh_token
      TO mcp_reader;

    GRANT SELECT, INSERT ON
      public.mcp_auth_event,
      public.mcp_request_log
      TO mcp_reader;

    GRANT USAGE, SELECT ON
      public.mcp_auth_event_id_seq,
      public.mcp_request_log_id_seq
      TO mcp_reader;
  END IF;
END
$$;
