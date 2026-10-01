# AMANA MCP Retrieval Evaluation

Tooling to measure how well this MCP server actually serves Claude: whether a
question that the AMANA corpus can answer causes the right record to come back,
and whether a question it cannot answer correctly returns nothing.

## Why the golden set has no answers in it

The evaluation is **reference-free**. Every metric in the quality design —
groundedness, citation accuracy, source coverage, answer completeness — judges a
response against *the context retrieval returned*, not against a reference answer.
So the golden set needs questions and retrieval ground truth, and nothing else.
There is no annotation project to run first.

What each item does carry is the record its question was derived from. That is what
makes recall and source coverage measurable: we know which document *should* come
back.

`answerSketch` is a reviewer hint for reading the file by eye. **Never score a
response against it** — it is one model's paraphrase of one passage, not ground
truth, and treating it as a reference answer would reintroduce exactly the
reference-based evaluation this design avoids.

## Scripts

| Command | Cost | What it does |
|---|---|---|
| `npm run eval:plan` | free | Prints the sampling plan without calling any model. Use to check coverage and language balance after changing the plan. |
| `npm run eval:generate` | ~$1 | Regenerates `golden-set.json` (100 model calls). |
| `npm run eval:probe` | free | Measures retrieval quality against the golden set. No model calls — run this on every change to `sql/`. |

Both read `DATABASE_URL` (and the generator `ANTHROPIC_API_KEY`) from
`.env.production`, falling back to the real environment so CI can inject them.

Requires Node 22+ (`package.json` engines). The scripts are `.mjs` and sit outside
`tsconfig.json`'s `include`, so they never enter the server build.

## Composition of the golden set

100 items:

| Bucket | n | Ground truth | Purpose |
|---|---|---|---|
| `targeted_document` | 45 | `gdrive:<uuid>` + chunk id | Stratified so **every** ingested document is covered, not just the large ones |
| `broad_document` | 25 | `gdrive:<uuid>` + chunk id | Uniform random over usable chunks — the natural difficulty distribution |
| `entity` | 15 | `expert:` / `partner:` / `project:` / `knowledge:` id | `search_corpus` spans five record types; a document-only set would miss most of the surface |
| `unanswerable` | 15 | none — expects no support | Checks the system returns nothing rather than weak, unrelated rows a model then writes up as fact |

Questions are exactly 50 English / 50 Indonesian, **balanced within each bucket**.
Balancing only globally lets the buckets with no natural source language absorb the
corpus skew and come out almost entirely English — which would leave the negatives
untested in Indonesian, the corpus's dominant language.

20 items are `crossLingual`: the question language deliberately differs from the
source document's. This is not a sampling accident. `search_corpus` tokenises with
the `'simple'` configuration and does no translation, so asking in Indonesian
against an English report is a real failure mode, and the probe reports it
separately.

## Reproducibility

Sampling is seeded (`--seed`, default `20260930`), so re-running selects the same
chunks and records. Only the model's phrasing varies between runs. Changing the
seed produces an independent set — useful for checking you have not overfit the SQL
to one sample.

Three things are recorded in `meta` so a result can be traced later:
`generatorModel`, `generatorEffort`, and `seed`.

## Chunk quality filtering

The corpus is built from PDF extraction, and roughly 65% of chunks (2,128 of 3,270)
are unusable as question sources: table fragments, running headers, table-of-contents
leaders, words broken across line ends. Generating a question from one of those
produces an item nothing can answer, which silently poisons the set — a real failure
would be indistinguishable from a bad question.

`lib/text.mjs` filters on letter ratio, short-line ratio, sentence count, digit
density, and ToC leaders, then keeps chunks scoring ≥ 0.45. One document
("Master Directory: Associations & Phonebook") has no usable chunks at all — it is
a phone directory, pure tabular data. Its content is reachable through the
`partner` entity bucket instead.

## Interpreting the probe

`probe-retrieval.mjs` measures two strategies side by side:

- **current** — `public.search_corpus(...)` exactly as `src/db.ts` calls it.
- **or-terms** — a candidate replacement that ORs the query terms.

The comparison exists because [`sql/002_deliverable_retrieval.sql:79`](../sql/002_deliverable_retrieval.sql)
builds its tsquery with `plainto_tsquery`, which **ANDs every term**. Every word in
the query must appear in the same document, so the result set shrinks monotonically
as terms are added — measured on one corpus phrase, 10 hits at one word, 6 at two,
1 by three. A real question carries ~20 terms including connectives and paraphrase,
at least one of which is absent from the target document, so it matches nothing.

Note this is not a long-query problem to be worked around by having Claude send
shorter queries: the same AND semantics already suppress recall at three words. The
`LIKE '%' || q_norm || '%'` fallbacks alongside it do not help either, since they
match the entire query string as one literal substring.

As of the baseline in `baseline-retrieval.json`:

```
current   zero-hit 100%,  recall@10  0%
or-terms  zero-hit   0%,  recall@10 79%,  recall@1 34%,  MRR 0.49
```

Until that is fixed, two downstream things are meaningless and should not be
reported as results:

1. **Negative verification.** Every negative "confirms" as unanswerable because
   *everything* returns zero rows. Re-run `eval:generate` after the fix to get a
   real verdict.
2. **Any response-level metric.** Groundedness and citation accuracy are measured
   against retrieved context; with no retrieved context there is nothing to ground
   against.

## What is not built yet

This covers the retrieval half. Still to come, in order:

1. Persisted tool-call telemetry (`sql/003_evaluation.sql` + a `log_mcp_call`
   `SECURITY DEFINER` function — `mcp_reader` holds EXECUTE on four functions and
   cannot INSERT).
2. A response harness that attaches this server to the Claude API via the MCP
   connector (`mcp_servers` + a matching `mcp_toolset`), capturing prompt,
   retrieved context, answer, and citations in one trace. Note the connection is
   made from Anthropic's side, so it must target the deployed Railway URL —
   `localhost` cannot work.
3. LLM judges over those traces for groundedness, citation support, relevance, and
   completeness, with the component metrics stored raw and the confidence score
   derived in a view so re-weighting does not invalidate history.
4. Calibration: label ~50 traces by hand and check the judge agrees before
   trusting any dashboard number.
