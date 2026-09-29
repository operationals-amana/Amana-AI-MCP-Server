# Auto-ingest historical deliverables

Pulls AMANA's past deliverables out of a shared Google Drive folder and makes them
retrievable through the MCP server, passage by passage, with provenance.

```
Drive folder ──walk──▶ detect new/changed ──▶ extract text ──▶ infer metadata
   ──▶ chunk ──▶ embed per chunk ──▶ knowledge_chunks + gdrive_knowledge_documents
   ──▶ search_corpus / search_deliverable_chunks / fetch_document
```

The work spans three repos:

| Repo | Role |
| --- | --- |
| `amana-proposal-agent` | The ingestion worker. Owns the tables, the Drive client, extraction, chunking, embedding, and the cron job. |
| `Amana-AI-MCP-Server` | Retrieval. Chunk-aware `search_corpus`, passage search, provenance, confidentiality gating. |
| `amana-ai-operational` | Admin visibility. Ingestion status, failures, manual re-sync, and the ingested-document inventory on the Knowledge Memory page. |

## One-time setup

### 1. Google Drive access

The pipeline needs the Drive API, which the previous public-URL download could not
provide (it cannot list a folder or see `modifiedTime`). Two auth methods are
supported; pick one.

**Option B is the shortest path today**, because the folder is already shared with
`operationals@amana.id` and the operational app's OAuth client already requests
`drive.readonly` with offline access.

**Option A — service account** (best for unattended runs; no dependency on one
person's account):

1. In Google Cloud, enable the **Google Drive API**.
2. Create a **service account** and a JSON key.
3. Share the "Knowledge Base" folder with the service account's `client_email`,
   **Viewer** access.
4. Set `GOOGLE_DRIVE_SA_JSON` to the key — raw JSON or base64.

For a Shared Drive where per-folder sharing is not an option, grant the service
account domain-wide delegation for `.../auth/drive.readonly` and set
`GOOGLE_DRIVE_IMPERSONATE_SUBJECT=operationals@amana.id`.

**Option B — act as a user who already has access.** Reuses the operational app's
existing OAuth client (`AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`), which already
requests `drive.readonly` with `access_type=offline`:

```bash
cd amana-proposal-agent
set -a && . ../amana-ai-operational/.env && set +a
python3 scripts/get_drive_refresh_token.py \
    --client-id "$AUTH_GOOGLE_ID" \
    --client-secret "$AUTH_GOOGLE_SECRET" \
    --folder-id 1eyGjFWtsl1js9RJ8Qtz7pGu69v37L0WU
```

Sign in as `operationals@amana.id`. The script runs the consent flow on the
loopback interface, exchanges the code, **lists the folder to prove the token
works**, then prints the three variables to set. It defaults to NextAuth's local
callback (`http://localhost:3000/api/auth/callback/google`), which the client
already allows for local development — so no Cloud Console change is normally
needed. If Google rejects the redirect, add that URI to the client, or pass
`--redirect-uri` for one that is registered.

Two trade-offs:

- **If the OAuth consent screen is in "Testing" publishing status, Google expires
  the refresh token after 7 days** and the cron dies quietly. Set the consent
  screen to "Internal" (available because amana.id is a Workspace domain), or use
  Option A.
- The token is tied to one person's account and dies if they revoke access or
  change their password. A dead token is reported as a configuration error in the
  admin panel, not as a transient failure.

> **Target folder.** `1eyGjFWtsl1js9RJ8Qtz7pGu69v37L0WU` is the "Knowledge Base"
> folder, now shared with `operationals@amana.id`. Its subfolders encode the
> practice group in their names — `DG Deliverables` → `digital`,
> `ST Deliverables` → `strategy_transformation`, `HH Deliverables` →
> `health_education` — and metadata inference reads that convention.

### 2. Database

**Both migrations have already been applied to the live Supabase database.** They
are idempotent, so re-running them is safe:

```bash
psql "$DIRECT_URL" -f amana-proposal-agent/migrations/004_deliverable_ingestion.sql
psql "$DIRECT_URL" -f Amana-AI-MCP-Server/sql/002_deliverable_retrieval.sql
```

`004` adds deliverable metadata columns, `knowledge_chunks`, and the
`ingestion_runs` / `ingestion_events` / `ingestion_state` tables. `002` replaces the
MCP retrieval functions. Both are idempotent.

Existing documents keep working after `004`: they have no chunks, so
`search_corpus` falls back to their document-level text until the first sync
re-indexes them.

### 3. Cron service

Add a second Railway service in the proposal-agent project, same repo and
Dockerfile, with its config-as-code path set to `railway.cron.toml`:

```toml
[deploy]
cronSchedule = "*/30 * * * *"
startCommand = "python -m app.jobs.drive_sync"
```

Give it the same `DATABASE_URL` as the API plus `GOOGLE_DRIVE_SA_JSON` and
`DRIVE_ROOT_FOLDER_ID`.

Overlapping ticks are safe: the sync takes a Postgres advisory lock on a dedicated
connection and a second run exits immediately, recorded as `skipped_locked`.

If you would rather schedule from Activepieces or Vercel Cron, point it at
`POST /api/v1/knowledge/sync-drive` instead and leave the cron service off.

### 4. MCP confidentiality (optional)

Documents inferred as confidential are excluded from `search_corpus`,
`search_deliverable_chunks`, and the body of `fetch_document`. `fetch_document`
still returns the title and source link with `restricted: true`, so the assistant
can tell a human the document exists without leaking its text.

To let a trusted internal client read them, set `MCP_BEARER_TOKEN_PRIVILEGED` on
the MCP server to a second, different token. Leave it unset to keep confidential
deliverables unreachable through MCP entirely.

## How the requirements are met

| Requirement | How |
| --- | --- |
| Incremental ingestion | Drive is queried with `modifiedTime > watermark`; the watermark advances only on a run that completed its whole candidate list. |
| Duplicate detection | `gdrive_file_id` is unique, and a SHA-256 of *extracted text* catches the same report stored twice in different formats or folders. |
| Re-index changed files | `md5Checksum` first, `modifiedTime` as fallback; a changed document has its chunks deleted and rewritten. |
| Preserve source links | `source_url` holds Drive's `webViewLink`; every hit and every passage returns it. |
| Deletion / archive state | A full sweep (forced every 24h) archives documents whose Drive file is gone or trashed: `status='archived'` plus chunk deletion, so it stops being retrievable but keeps provenance for anything that already cited it. |
| Access permissions | Confidentiality is inferred, correctable, and enforced in SQL; an admin's manual correction is never overwritten by re-inference. |
| Flag failed ingestion | Per-file failures land in `ingestion_events` and set `status='failed'` + `ingest_error` on the document, surfaced in the dashboard with a "Retry all" action. One bad file never aborts a run. |
| Provenance on every chunk | Each chunk stores its heading, page range, char offsets, and parent document; `search_corpus` returns them inline. |

## Running a sync by hand

From the proposal-agent repo, using its existing environment:

```bash
cd ~/amana/amana-proposal-agent
source ~/.pyenv/versions/proposal-agent/bin/activate

python -m app.jobs.drive_sync              # incremental, same as the cron tick
python -m app.jobs.drive_sync --full       # walk everything; detects deletions
python -m app.jobs.drive_sync --max-files 3   # smoke test
```

Backfill chunks for documents ingested before chunking existed (typically Drive
links added by hand), preserving their curated metadata:

```bash
python -m app.jobs.drive_sync --reindex-unchunked
```

**Use the direct database connection on port 5432, not the pooler on 6543.**
Do not source another service's env file into this shell. The MCP server's
`.env.production` carries a Prisma-style pooler URL
(`…:6543/postgres?pgbouncer=true`); asyncpg rejects the `pgbouncer` parameter
outright, and port 6543 is transaction-mode pooling, under which the session-scoped
advisory lock that stops overlapping syncs silently stops working.
`app/db/session.py` now forces an async driver, strips the parameters asyncpg
cannot accept, and warns when it sees port 6543 — but the right fix is to point the
worker at the direct connection.

## Operating notes

- **First run is a full sweep** and is capped at `DRIVE_SYNC_MAX_FILES_PER_RUN`
  (200) so it cannot run for hours. The remainder is picked up by the next tick;
  the watermark is deliberately not advanced while a run is truncated. A large
  archive therefore takes several ticks to fully land, and the panel shows
  progress as it goes.
- **Scanned PDFs produce no text** and are recorded as failures with
  "no extractable text". They need OCR, which this pipeline does not do.
- **Google Docs and Slides** are exported to PDF; **Sheets** to XLSX and converted
  via LibreOffice. This requires `libreoffice-impress` and `libreoffice-calc` in the
  image — added to the Dockerfile, which previously shipped only
  `libreoffice-writer` and so failed silently on every `.pptx`.
- **Metadata is inferred, not authoritative.** Folder path and file name drive
  project / client / year / type / confidentiality. Treat the dashboard as the
  place to correct anything that looks wrong.
- **The file name outranks the cover page** for both title and document type. A
  deliverable series shares one cover ("Pelatihan Penyusunan Cetak Biru" across
  four `[Hari ke-N]` decks), so titling from the cover made distinct documents
  indistinguishable in search results and typed them from "cetak biru"
  (blueprint) rather than the training material they are. A short or genre-only
  file name still defers to the cover page.
- **Re-indexing after changing inference rules.** The sync skips files whose Drive
  checksum is unchanged, so improved inference does not reach already-ingested
  documents on its own. Force it with
  `UPDATE gdrive_knowledge_documents SET status = 'pending'` followed by a run —
  `_needs_reindex` re-processes anything not in `ready` state.


## Verified against the live database

Run on 2026-09-29 against Supabase with the 10 pre-existing documents:

- Both migrations applied: `knowledge_chunks`, `ingestion_runs`,
  `ingestion_events`, `ingestion_state` created; 18 metadata columns added; the 10
  existing documents backfilled with `source_url`.
- `search_corpus`, `search_deliverable_chunks`, `fetch_document` and
  `ingestion_status` all execute and return expected shapes.
- The unchunked-document fallback works: documents with no chunks are still
  findable, so nothing disappeared from search before the first sync.
- Confidentiality gating confirmed through the running MCP server over HTTP: with
  the standard token a confidential document returns `count: 0` from
  `search_corpus` and a `restricted: true` stub with no content from
  `fetch_document`; with `MCP_BEARER_TOKEN_PRIVILEGED` it returns normally.
  Requests with no token or a wrong token get 401.
- Metadata inference checked against the real file names in the folder
  (20 unit tests, including the repository's bracket-tag, double-extension and
  practice-group-folder conventions).

### First real ingestion

Ran against the live "Knowledge Base" folder using an OAuth credential for
`operationals@amana.id`:

| | |
|---|---|
| Files discovered | 19 (shortcuts resolved to their targets) |
| Ingested / re-indexed | 16 / 3 |
| Failed | 0 |
| Chunks written | 1,595 across 888 pages |
| Document types | research_report 7, training_material 5, technical_document 2, framework 1, concept_note 1, policy_brief 1, other 2 |

A second full sweep reported **19 skipped unchanged, 0 archived, 0 failed**,
confirming change detection and that reconciliation no longer over-reaches.

Chunk retrieval verified through the running MCP server: an Indonesian query
returned passages with their heading ("6 Proses Penganggaran Kesehatan Digital
dalam APBN"), page range (5-6) and Google Slides source link.

### Two bugs the first real run exposed

**Reconciliation archived unrelated documents.** The full sweep treated every row
in `gdrive_knowledge_documents` as belonging to the watched folder, so the 10
documents ingested earlier by the URL-based path and the Knowledge Library UI —
which can never appear in a folder walk — were archived on the first full run.
Migration `005_sync_root_scope.sql` adds `sync_root_folder_id`, reconciliation is
now scoped to it, and the affected documents were restored (they held no chunks,
so nothing was lost).

**Confidentiality was inferred from ordinary prose.** "fitur analitik masih
terbatas" ("features are still limited") marked a legitimate blueprint
confidential and hid it from retrieval; "private" occurs in this corpus only as
"public-private partnership" and "private sector". Bare `terbatas`, `private` and
`sensitive` were removed in favour of explicit markings. This is the failure
direction that matters: a false positive removes a deliverable from retrieval with
no visible signal.


## Admin view

**Knowledge Memory** (`/knowledge-memory`, admin or partner) carries two panels.

**Deliverable ingestion** — corpus totals, the last run with its counts and
duration, per-file failures with a "Retry all" action, and (admin only) "Sync now"
and "Full re-scan" buttons.

**Ingested documents** — every retrievable document, labelled by origin:

| Badge | Meaning |
| --- | --- |
| `Drive · auto` | Walked automatically out of `DRIVE_ROOT_FOLDER_ID` |
| `Drive · link` | A Drive URL added by hand in Knowledge Memory |
| `Upload` | A file uploaded by hand |

Origin is not a stored column — it is derived from which table holds the document
and, for Drive files, whether a watched-folder sync claimed it
(`sync_root_folder_id`). Clicking a title opens the original in a new tab; uploaded
files have no external location, so they render as plain text. Each row shows
document type, client, year, practice group, Drive folder path, page and passage
counts, and a lock badge for anything marked confidential. Filter by origin, search
across title / client / folder path, and page with "Load more".

Statistics are computed over the whole corpus rather than the visible page, so
counts stay stable while filtering.
