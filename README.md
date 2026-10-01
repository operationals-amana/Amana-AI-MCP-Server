# AMANA Knowledge MCP Server

An MCP server that gives Claude read-only search over AMANA's institutional
knowledge: ingested deliverables (reports, proposals, concept notes), the talent
roster, past projects, partner contacts, and internal knowledge entries.

It exposes four tools — `search_corpus`, `search_deliverable_chunks`,
`fetch_document`, and `ingestion_status` — over HTTP, backed by the same Supabase
Postgres database the operational dashboard uses. Access requires an AMANA Google
account: every request is tied to a named person and carries that person's
dashboard permissions.

## Running it

```bash
npm install
cp .env.example .env        # see Authentication below for what to fill in
npm run dev                 # or: npm run build && npm start
```

Requires Node 22+. Deployed on Railway; `Dockerfile` and `railway.toml` are the
deployment config.

## Authentication

The server is its own OAuth 2.1 authorization server, and it delegates the actual
login to Google. Anyone can point Claude at the URL; nobody gets past the sign-in
without an `@amana.id` Google account that already has an AMANA dashboard user.

What happens when somebody connects:

1. Claude calls `/mcp` with no token and gets a `401` whose `WWW-Authenticate`
   header points at `/.well-known/oauth-protected-resource/mcp`.
2. From there it discovers this server's authorization endpoints and registers
   itself with `POST /oauth/register` (RFC 7591 Dynamic Client Registration), so
   nothing has to be configured by hand on either side.
3. The user is sent to Google with `hd=amana.id`, signs in, and comes back.
4. The callback checks three things on the claims Google returned: the address
   ends in `@amana.id`, Google says it is verified, and the hosted-domain claim
   is AMANA's — the last is what a personal Gmail account cannot fake.
5. The address is looked up in the dashboard's `User` table. **No row, no
   access**: an `@amana.id` address that AMANA has never onboarded has no
   permissions to apply, so it is refused with a note to sign in to the dashboard
   once first. Provisioning stays in one place rather than being duplicated here.
6. The user sees a consent screen naming the client and the host their data will
   be sent to, then Claude exchanges the code for a token with PKCE S256.

The token carries scopes derived from the user's dashboard **role**, which is
what keeps an external AI tool from outreaching the person driving it:

| Scope | Who gets it |
|---|---|
| `mcp:read` | every provisioned user |
| `corpus:confidential` | roles listed in `MCP_CONFIDENTIAL_ROLES` (default: `admin`) |

A client is free to *request* `corpus:confidential`; an analyst's token simply
will not carry it, and `search_corpus`, `search_deliverable_chunks` and
`fetch_document` are all called with `include_confidential => false` as a result.
A withheld document is reported as `not_found`, so the response does not confirm
that a record the caller may not read exists.

Role and token checks are re-resolved on every request, not just at sign-in, so
removing a user or demoting them in the dashboard takes effect immediately rather
than when their token expires.

One deliberate boundary: **practice group is recorded but not enforced**. The
dashboard scopes its knowledge *library* by practice group for partners, but
deliverables, past projects, the roster and partner contacts are institution-wide
there too — so partitioning the corpus by practice group here would make MCP
*narrower* than the dashboard rather than equal to it, and would silently break
retrieval for cross-practice questions. The user's practice group is carried on
every log row, so if that policy ever changes the data to act on is already there.

### Google Cloud setup

One OAuth client, separate from the dashboard's because the redirect URI differs:

1. Google Cloud console → **APIs & Services → Credentials → Create credentials →
   OAuth client ID**, application type **Web application**.
2. Add `https://<your-host>/oauth/google/callback` as an authorised redirect URI.
3. Put the client id and secret in `MCP_GOOGLE_CLIENT_ID` and
   `MCP_GOOGLE_CLIENT_SECRET`, and the server's own origin in `MCP_PUBLIC_URL`.

No Google API scopes beyond `openid email profile` are requested: the server
never calls Google on the user's behalf, it only needs the identity assertion.

### The static token, and migrating off it

`MCP_AUTH_MODE` selects how callers authenticate. It defaults to `oauth` once the
Google variables are set.

| Mode | Accepts | Requests attributable to a person |
|---|---|---|
| `oauth` | Google sign-in only | yes |
| `both` | either | only the OAuth ones |
| `token` | `MCP_BEARER_TOKEN` only | no |

A static token carries no identity, so `token` mode cannot enforce the domain
restriction and cannot satisfy the audit requirement — requests made with it are
logged as `service:static` rather than as a person, and the server logs a warning
at startup saying so. It remains for machine callers and local development.

To move an already-deployed connector across without downtime: deploy with
`MCP_AUTH_MODE=both`, have everyone remove and re-add the connector so it runs
the sign-in flow, confirm `mcp_request_log` shows no more `service:` rows, then
set `MCP_AUTH_MODE=oauth` and drop `MCP_BEARER_TOKEN`.

## Request logging

Two tables, both written by the server and neither deletable by it — `mcp_reader`
holds `INSERT` and no `DELETE`, so a compromised server credential cannot erase
its own trail.

| Table | One row per | Useful for |
|---|---|---|
| `mcp_auth_event` | sign-in, consent, token issue/refresh/revoke, and every rejection | who was turned away and why; a run of `domain_rejected` for one address is somebody outside AMANA trying to attach the server to their own Claude |
| `mcp_request_log` | tool call | who called what, with which arguments, and **which record ids came back** (`source_ids`) — the question neither the HTTP log nor the Postgres log can answer |

Both writes are fire-and-forget: a logging failure is reported to stdout and
never turns a legitimate request into an error. The same information also goes to
stdout as structured JSON, so Railway's log view shows it without a database
query.

Neither table has an admin UI in the dashboard yet, so reading them today means
querying Postgres. That is the obvious next piece of work in
`amana-ai-operational`.

### Verifying it

```bash
npm run build && npm run smoke:auth
```

`scripts/smoke-oauth.mjs` starts the server on a spare port as `mcp_reader`, then
walks a client through registration, `/authorize`, consent, the PKCE exchange, an
authenticated tool call, refresh-token rotation and replay detection, revocation,
and the audit rows that should have landed — 59 checks. It writes to the real
database under ids prefixed `smoke_` and deletes them again. The one step it
cannot perform is the redirect to Google, which needs a real browser; that hop is
simulated, and the domain rules the callback applies are checked directly.

## Database functions

Retrieval lives in Postgres, not in the server. The server is a thin typed wrapper
([`src/db.ts`](src/db.ts)) over these functions.

Apply in order. Each file is idempotent and re-runnable:

```bash
npm run db:apply -- sql/001_mcp_rpc.sql
npm run db:apply -- sql/002_deliverable_retrieval.sql
npm run db:apply -- sql/003_hybrid_retrieval.sql
npm run db:apply -- sql/004_mcp_auth.sql
```

`db:apply` reads `DIRECT_URL` from `.env.production` itself. Do not use
`psql "$DIRECT_URL" -f …` unless you have exported the variable first — psql
silently falls back to a local socket and leaves the migration unapplied.

| File | What it adds |
|---|---|
| `001_mcp_rpc.sql` | Original `search_corpus` / `fetch_document` |
| `002_deliverable_retrieval.sql` | Chunk-level retrieval, provenance columns, confidentiality filtering, and `mcp_search_tsquery` |
| `003_hybrid_retrieval.sql` | `mcp_entity_embeddings` and `search_corpus_hybrid` (vector + lexical) |
| `004_mcp_auth.sql` | OAuth client/token tables, the `mcp_auth_event` and `mcp_request_log` audit trail, and `mcp_lookup_user` |

> **`search_corpus_hybrid` is not wired up yet.** [`src/db.ts`](src/db.ts) still calls
> `search_corpus`. Using the hybrid path requires the server to compute a query
> embedding — see the open decision at the end of [`eval/REPORT.md`](eval/REPORT.md).

## Retrieval quality

Retrieval is measured against a fixed 100-question evaluation set built from the
corpus itself. The probe needs no model calls, so run it on every change to `sql/`:

```bash
npm run eval:probe
```

| Command | Cost | What it does |
|---|---|---|
| `npm run eval:probe` | free | Measures recall and ranking against the evaluation set |
| `npm run eval:plan` | free | Prints the sampling plan without generating anything |
| `npm run eval:generate` | ~$1 | Regenerates the 100-question set (100 model calls) |
| `npm run eval:embed` | free | Embeds the questions so the probe can test the hybrid path |
| `npm run eval:backfill` | free | Refreshes entity embeddings after roster or partner edits |

The two Python commands run against the `proposal-agent` pyenv virtualenv, which
already has the embedding model this corpus was indexed with.

Full method, results and known data-quality issues: [`eval/README.md`](eval/README.md)
and [`eval/REPORT.md`](eval/REPORT.md). A non-technical summary for colleagues is in
`eval/` as a PDF.

## Related repositories

| Repository | Relationship |
|---|---|
| `amana-ai-operational` | The dashboard. Shares this database; owns the `Expert`, `PastProject`, `PartnerContact`, `OrgKnowledgeEntry` and `User` tables via Prisma. Its `User` rows and roles are what this server authorizes against, so a person's MCP access is managed there. |
| `amana-proposal-agent` | Ingests deliverables into `gdrive_knowledge_documents` and `knowledge_chunks`, and produces the embeddings this server searches. See [`DELIVERABLE_INGESTION.md`](DELIVERABLE_INGESTION.md). |

Because the entity tables are Prisma-owned, this repo never adds columns to them —
`mcp_entity_embeddings` and the `mcp_*` auth tables are sidecars keyed by record
id, so a later `prisma migrate` cannot drop them. The one place this server needs
to read a Prisma table is identity, and it does that through
`mcp_lookup_user`, a `SECURITY DEFINER` function returning id, email, name, role
and practice group — `mcp_reader` has no grant on `"User"` itself, which holds
bcrypt password hashes.
