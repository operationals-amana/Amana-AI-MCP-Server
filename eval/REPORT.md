# AMANA MCP — Retrieval Quality Report

**Date:** 30 September 2026
**Scope:** `Amana-AI-MCP-Server` — the MCP server Claude connects to
**Corpus:** 35 ingested documents / 3,270 chunks, 104 experts, 220 partner contacts, 10 past projects, 8 org knowledge entries

---

## Summary

A 100-question evaluation set was built from the AMANA corpus and used to measure
retrieval. The headline result is that **`search_corpus` returned nothing for 100%
of natural-language questions**, giving recall@10 of 0%. The cause is a single line
of SQL, now fixed in the repository and awaiting application to the database.

With the fix, the same 70 document-backed questions reach **83% recall@10** and
**34% recall@1**.

| | zero-hit | recall@1 | recall@3 | recall@10 | MRR |
|---|---|---|---|---|---|
| Before | **100%** | 0% | 0% | **0%** | 0 |
| After | 0% | 34% | 61% | **83%** | 0.50 |

Nine corpus and schema defects were also found along the way; they are listed at the
end with severity.

---

## 1. The retrieval defect

### What was measured

All 85 answerable questions in the golden set were run through
`public.search_corpus(...)` with exactly the arguments [`src/db.ts`](../src/db.ts)
passes. Every single one returned zero rows.

```
current  public.search_corpus  (all positives, n=85, k=10)
  zero-hit queries   85 (100%)
  recall@10          0%
  recall@10 by lang  en 0% / id 0%
```

### Root cause

[`sql/002_deliverable_retrieval.sql`](../sql/002_deliverable_retrieval.sql), in both
`search_corpus` and `search_deliverable_chunks`:

```sql
q := plainto_tsquery('simple', q_norm);
```

`plainto_tsquery` joins every term with **AND**. The query therefore demands that
*all* of its words appear in the same document. Result-set size collapses as the
query grows — measured on one real corpus phrase:

| terms in query | hits |
|---|---|
| 1 | 10 |
| 2 | 6 |
| 3 | **1** |
| 12 | 1 |

A real question carries roughly 20 terms including connectives and paraphrase. At
least one is always absent from the target document, so the match set is empty.

Two things make this worse than it first appears:

- **It is not a long-query problem.** Recall is already suppressed at three terms,
  so it cannot be worked around by having Claude send shorter queries.
- **The fallbacks don't help.** The `LIKE '%' || q_norm || '%'` conditions beside the
  tsquery match the *entire query string* as one literal substring, which a question
  never is.

The tool description in [`src/mcp.ts`](../src/mcp.ts) invites "Natural-language
search", so the broken path was the normal path, not an edge case.

### The fix

A new `public.mcp_search_tsquery(text)` helper replaces `plainto_tsquery`. It:

1. Lowercases, unaccents, and splits the query on non-alphanumerics — which also
   sanitises it, since every surviving token is `[a-z0-9]+` and safe for
   `to_tsquery` without escaping.
2. Drops function words using a conservative bilingual stopword list.
3. **ORs** the remaining terms, leaving precision to `ts_rank_cd` — cover-density
   ranking already rewards documents matching more of the query, closer together.
4. Returns `NULL` when nothing usable remains; the three `q::text <> ''` guards
   became `q IS NOT NULL`.

The stopword list deliberately **excludes** anything that doubles as an entity or
acronym in this corpus — `who` (WHO is a client), `it` (IT), `us` (US), `id`, `ai`,
`ux`. Stopwording one of those would make a whole class of record silently
unfindable, which is a worse failure than some ranking noise. A query made entirely
of function words falls back to its unfiltered terms rather than returning nothing.

### Measured effect

```
proposed mcp_search_tsquery  (document-backed positives, n=70, k=10)
  zero-hit queries   0 (0%)
  recall@1           34%
  recall@3           61%
  recall@10          83%
  MRR                0.4976
  recall@10 by lang  en 72% / id 94%
  cross-lingual      50% (n=20)
```

Two observations worth carrying forward:

- **Indonesian outperforms English** (94% vs 72%). The stopword list is doing more
  work in Indonesian, where function words are a larger share of a question.
- **Cross-lingual recall is 50%**, against 72–94% same-language. Asking in
  Indonesian against an English report roughly halves the chance of finding it.
  `content_tsv` is built with the `'simple'` configuration, which does no stemming
  and no translation, so this is expected — but it is now quantified, and 20 items
  in the golden set track it.

### ⚠️ Still to apply

The SQL is committed but **not yet applied to the database.** Applying DDL to
production was outside what this session could do. To deploy:

```bash
npm run db:apply -- sql/002_deliverable_retrieval.sql
npm run eval:probe    # confirm `current` now matches `proposed`
```

`db:apply` loads `.env.production` itself. Prefer it over a bare
`psql "$DIRECT_URL" -f …`: that variable is not exported into an interactive shell,
so psql silently falls back to a local socket, fails to connect, and leaves the
migration unapplied — which is easy to mistake for success. If you do use psql,
source the env first (`set -a; . ./.env.production; set +a`).

**Connection naming here is inverted from the usual Supabase convention**, so pick
carefully:

| Variable | Port | Mode | Safe for DDL |
|---|---|---|---|
| `DIRECT_URL` | 5432 | session pooler | **yes** |
| `DATABASE_URL` | 6543 | transaction pooler (`pgbouncer=true`) | no |

The script is idempotent: it recreates the functions and re-grants `mcp_reader`.

The probe is the acceptance test. After applying, the `current` row should converge
on the `proposed` row; any remaining gap is ranking work, not a query-construction
bug.

---

## 2. The evaluation set

### Design

The set is **reference-free**: items carry a question plus the record it was derived
from, and no gold answer. Every metric in the quality design — groundedness,
citation accuracy, source coverage, completeness — judges a response against the
context retrieval returned, not against a reference text. So no answer-authoring or
annotation project was needed; **only questions**, which is why this was buildable
from the database alone.

What each item does carry is retrieval ground truth: the document or record that
*should* come back. That is what makes recall and source coverage measurable.

### Composition — 100 items

| Bucket | n | Ground truth | Purpose |
|---|---|---|---|
| `targeted_document` | 45 | `gdrive:<uuid>` + chunk id | Stratified so **every** document is covered, not just large ones |
| `broad_document` | 25 | `gdrive:<uuid>` + chunk id | Uniform random — natural difficulty distribution |
| `entity` | 15 | `expert:` / `partner:` / `project:` / `knowledge:` | `search_corpus` spans five record types; a document-only set would miss most of the surface |
| `unanswerable` | 15 | none | Checks the system returns nothing rather than weak rows a model then writes up as fact |

Exactly **50 English / 50 Indonesian, balanced within every bucket**. Balancing only
globally let the buckets with no natural source language absorb the corpus skew and
come out 14/15 English — which would have left the negatives untested in Indonesian,
the dominant corpus language.

**20 items are deliberately cross-lingual.** Not a sampling accident: it is a real
failure mode, measured separately, and now quantified at 50%.

### Validation

- 100 items, no duplicate ids, no duplicate questions
- Zero questions referencing "this document" / "dokumen ini" — all self-contained
- Ground truth present on all 85 positives
- 34 of 35 documents covered
- 0 generation failures
- 5 of 100 items reuse distinctive source wording (tracked via `reusesSourceWording`)
- Mean question length 24.5 words

The one uncovered document is *"Master Directory: Associations & Phonebook"* — a phone
directory with no prose to ground a question in. Its content is reachable through the
`partner` entity bucket instead.

### Reproducibility

Sampling is seeded (default `20260930`), so re-running selects the same chunks and
records; only model phrasing varies. `meta` records `generatorModel`,
`generatorEffort`, and `seed`. A different seed yields an independent set — useful
for checking the SQL has not been overfitted to one sample.

### Chunk quality filtering

**65% of chunks (2,128 of 3,270) were rejected as unusable question sources**: table
fragments, running headers, table-of-contents leaders, words broken across line ends.
This matters more than it sounds — a question generated from a table fragment is
unanswerable, so a genuine retrieval failure would be indistinguishable from a bad
question. Filtering is on letter ratio, short-line ratio, sentence count, digit
density and ToC leaders.

### Two things not yet meaningful

1. **Negative verification.** All 15 negatives "confirm" as unanswerable, but only
   because *everything* returned zero. Re-run `npm run eval:generate` after the SQL
   fix is applied for a real verdict. This caveat is recorded in the file's `meta`.
2. **Any response-level metric.** Groundedness and citation accuracy are measured
   against retrieved context. With no retrieved context there is nothing to ground
   against, so those stages should not be built or reported until the fix is live.

---

## 2b. Iteration 2 — hybrid retrieval (measured, not yet deployed)

After `sql/002` was applied, `search_corpus` reached 71% recall@10 / 25% recall@1.
That is functional but low: roughly 3 in 10 answerable questions have no correct
source anywhere in the top 10, which puts a hard ceiling on groundedness no amount of
prompting can lift. Error analysis found two distinct causes.

**Cause 1 — paraphrase.** `'simple'` tokenisation does no stemming, so a question
that rephrases its source scores zero. Cross-lingual is the extreme: an Indonesian
question against an English report shares almost no tokens (40% recall).

**Cause 2 — score scale.** `ts_rank_cd` grows with match count, so 900-character
document chunks (observed scores 4.6–7.8) systematically outranked 200-character
entity rows (0.6–1.5). Entity records were buried irrespective of relevance. Worse,
their *own* lexical ordering put the correct record in the top 10 only 5 times out of
15, among hundreds of loosely-matching candidates — so this is not fixable by
reweighting. It needs semantic matching.

**The asset that was going unused:** `knowledge_chunks` and
`gdrive_knowledge_documents` already carry 384-dim embeddings from
`sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`, fully populated
(3,270/3,270 and 35/35), with HNSW cosine indexes already built. Nothing referenced
them.

Measured on the golden set:

| strategy | recall@1 | recall@3 | recall@10 | MRR | cross-lingual |
|---|---|---|---|---|---|
| lexical only (deployed) | 36% | 61% | 83% | 0.51 | 50% |
| vector only | 73% | 87% | **100%** | 0.81 | **100%** |
| RRF 1:1 | 63% | 84% | 99% | 0.75 | 95% |
| **RRF 5:1 (chosen)** | 71% | **90%** | **100%** | **0.82** | — |

Equal-weight fusion is *worse* than vector alone — it dilutes a strong signal with a
weak one. Weights of 5:1 and 10:1 are within noise; 5:1 was chosen to retain more
lexical influence for exact-term lookups (titles, acronyms, record codes), which the
golden set deliberately under-tests since its questions are paraphrased on purpose.

Entities, embedded into a sidecar table and measured the same way:

| record type | lexical recall@10 | embedding recall@10 |
|---|---|---|
| expert | 33% | **100%** |
| project | 67% | **100%** |
| knowledge | 0% | **100%** |
| partner | 25% | 25% (no gain) |

Partner contacts do not improve because the records are too thin — often just an
organisation name, affiliation and cluster. That needs richer descriptions, not a
better retrieval strategy.

### A precision problem the fix introduced

Before iteration 1, all 15 negatives "passed" because everything returned nothing.
Now **all 15 return strong matches**, and `ts_rank_cd` cannot separate them at any
threshold — negatives have the *same* median top score as positives (3.0 vs 3.0), so
0/15 are rejected at every cutoff tested. The MCP will confidently hand Claude rows
for questions the corpus cannot answer, which is precisely the hallucination pathway
the quality design is meant to catch.

Cosine similarity separates them meaningfully better, because it is bounded and
length-independent:

| threshold | negatives rejected | positives retained |
|---|---|---|
| 0.55 | 27% | 96% |
| **0.60** | **53%** | **91%** |
| 0.65 | 60% | 83% |
| 0.70 | 87% | 71% |

Still overlapping, so this is not a hard filter — it is the basis for an
**evidence-strength signal** returned in the tool output, so Claude hedges on weak
evidence instead of asserting. That is the one lever on this list that improves
answer reliability rather than just measuring it.

### Deployed result (measured live, `search_corpus_hybrid`)

| | before `002` | after `002` | after `003` |
|---|---|---|---|
| zero-hit | 100% | 0% | 0% |
| recall@1 | 0% | 25% | **54%** |
| recall@3 | 0% | 52% | **75%** |
| recall@10 | 0% | 71% | **92%** |
| MRR | 0 | 0.40 | **0.67** |
| cross-lingual | 0% | 40% | **100%** |

By record type: documents **100%** recall@10 (61% recall@1), projects 100%, org
knowledge 100%, experts 50%, partners 0%.

Two follow-ups were needed beyond the vector path itself:

**Slot reservation.** Unfiltered, documents filled all 10 slots and experts scored
33% / partners 0% — yet the *same* queries with `types=['expert']` reached 100%. The
records were being found and then crowded out, because a document chunk carries far
more text than an expert row and so wins both ranked lists. Reserving 3 of 10 slots
for structured records lifted experts to 50% and org knowledge to 100% with document
recall unchanged at 100%.

**Tool description.** The larger half of that fix is free: `search_corpus` already
takes `types`, and filtering takes experts from 50% to 100%. The parameter
description in [`src/mcp.ts`](../src/mcp.ts) now tells Claude to set it for
people, partner and past-work questions rather than leaving it off.

**Embedding pooling was checked and is fine.** `fastembed` 0.8.0 warns that this
model switched from CLS to mean pooling. Freshly computed vectors were compared
against the stored corpus vectors for five chunks: cosine 1.0000 on all five, so the
stored embeddings are already mean-pooled and no re-embedding is needed. Worth pinning
the `fastembed` version regardless — a future pooling change would silently
decorrelate new query vectors from the stored corpus rather than raising an error.

### Remaining gaps, in priority order

1. **Negatives are still 15/15 false positives.** Unaddressed, and now the largest
   risk: the server confidently returns rows for questions the corpus cannot answer.
   Neither `ts_rank_cd` nor the fused RRF score can separate them — RRF is rank-based,
   so it carries no absolute meaning at all. Raw cosine can (53% rejected at 0.60,
   keeping 91% of positives), but `search_corpus_hybrid` does not currently return it.
   **Next step: return an evidence-strength signal** (`strong` / `moderate` / `weak`
   plus the top cosine) in the tool output, so Claude hedges on thin evidence instead
   of asserting. This is the only item on this list that improves answer reliability
   rather than merely measuring it.
2. **Partner contacts: 0% unfiltered, 25% filtered.** Not a retrieval problem —
   the records are too thin (often just organisation name, affiliation, cluster) to
   discriminate among 220. Needs richer descriptions in the dashboard.
3. **Experts 50% unfiltered.** Should improve once Claude acts on the revised `types`
   description; worth re-measuring against real traffic rather than tuning further
   against 6 golden-set items.
4. **Document recall@1 61%.** The right document is almost always retrieved; ranking
   it first is the remaining work.

### Deploying iteration 2

```bash
npm run db:apply -- sql/003_hybrid_retrieval.sql
npm run eval:backfill      # embeds 342 entity records
npm run eval:embed         # embeds the 100 golden-set questions
npm run eval:probe         # adds a `hybrid` row + per-record-type recall
```

`search_corpus_hybrid` degrades to lexical-only when `p_query_embedding` is NULL, so
it is safe to deploy before the server can produce embeddings.

**Outstanding decision — the server needs to embed queries.** `search_corpus_hybrid`
takes a vector, and [`src/db.ts`](../src/db.ts) has no way to make one. Two options:

1. **In-process** via the `fastembed` npm package with the same model. Self-contained,
   no new service dependency; costs ~120 MB of ONNX model at boot and slower cold
   starts on Railway.
2. **Delegate** to the proposal agent, which already loads this exact model. Lighter
   for the MCP server, but couples it to another service being up.

Option 1 is recommended — the MCP server's value is being a dependency-light, always-
available retrieval surface, and a cold-start cost is a better trade than a runtime
dependency on a second service. Either way, pass NULL until it is wired: quality
stays at iteration 1 levels rather than breaking.

---

## 3. Corpus and schema defects found

Ordered by severity.

| # | Defect | Impact |
|---|---|---|
| 1 | **`doc_type` enum mismatch.** The database holds `policy_brief` and `training_material`; `DELIVERABLE_TYPES` in [`src/mcp.ts`](../src/mcp.ts) has neither. | 5 documents / 262 chunks cannot be filtered by type. A caller passing `doc_type` silently excludes them. |
| 2 | **`document_year` contains impossible values** — 2045, 2029, 2026 on existing documents. | Year-range filters (`year_from` / `year_to`) return wrong sets. Metadata inference bug upstream. |
| 3 | **`sector` holds practice-group values** — "digital", "strategy_transformation", "health_education" in 17 of 35 rows. | The `sector` filter is conflated with `practice_group` and cannot be trusted. |
| 4 | **`heading` values often unusable for citation** — "AI", "TTDK", and mid-sentence fragments like *"monitoring, and optimising the distribution of medicines and vaccines. The"*. | Citations will look wrong to users even when retrieval is correct — which will depress perceived quality independently of the metrics. |
| 5 | **Client names unnormalised** — "Kemenkes" and "Kementerian Kesehatan" as separate values. | The `donor` filter splits one client across two spellings. |
| 6 | **One document title is a table-of-contents line** — `"1.1.1.   Konteks Perkembangan DKI Jakarta sebagai Kota Global ......... 4"`. | Title-match boosting and any user-visible citation are both wrong for this document. |
| 7 | **`practice_group` NULL on 12 of 35 documents**, and the `operations` group has **zero** documents despite being in the enum. | Practice-group segmentation of quality metrics will be partial, and `operations` will always look empty. |
| 8 | **Seed data mixed with real data** — the 10 proposal documents and all 10 `PastProject` rows carry generic clients ("Regional Banking Consortium", "National Manufacturing Group"). | Questions grounded on these test retrieval mechanics but not real institutional knowledge. |
| 9 | **65% of chunks are extraction noise** (see above). | Retrieval is searching a corpus where most passages are unusable, which caps achievable recall regardless of query construction. |

Defects 1–3 and 5–7 are all metadata-inference or normalisation problems in the
ingestion pipeline (`amana-proposal-agent`), not in this server. Per the standing
requirement that everything the MCP serves be correctable through the dashboard,
note that `gdrive_knowledge_documents` still has **no edit UI** — so none of these
can currently be fixed by hand.

---

## 4. What exists now

| Path | |
|---|---|
[`eval/golden-set.json`](golden-set.json) | 100 validated items |
[`eval/generate-golden-set.mjs`](generate-golden-set.mjs) | Seeded generator |
[`eval/probe-retrieval.mjs`](probe-retrieval.mjs) | Free retrieval measurement; run on every `sql/` change |
[`eval/baseline-retrieval.json`](baseline-retrieval.json) | Machine-readable baseline |
[`eval/README.md`](README.md) | Design and reproducibility notes |
[`eval/lib/`](lib/) | env loading, pool, text heuristics |

`npm run eval:plan` (free) · `eval:generate` (~$1) · `eval:probe` (free)

---

## 5. Recommended order from here

1. **Apply the SQL fix** and confirm with `npm run eval:probe`. Everything else is
   blocked behind this — there is no point measuring answer quality while retrieval
   returns nothing.
2. **Regenerate the golden set** so negative verification becomes meaningful.
3. **Fix defects 1–3.** The `doc_type` enum is a one-line change in `src/mcp.ts`;
   the year and sector problems need an ingestion-side fix plus a backfill.
4. **Improve ranking.** recall@1 of 34% against recall@10 of 83% means the right
   document is usually retrieved but often not ranked first. A term-overlap or
   coverage boost is the obvious next lever, and the probe will score it in seconds.
5. **Address cross-lingual recall** (50%). Options: index a translated field, add
   embedding-based retrieval alongside full-text, or expand queries with bilingual
   term pairs.
6. **Then** build the telemetry table, the response harness, and the judges — in
   that order, as laid out in [`eval/README.md`](README.md).
