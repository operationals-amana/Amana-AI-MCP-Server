/**
 * Measures retrieval quality for the golden set directly against the database.
 *
 * This is the retrieval-side half of the evaluation: it needs no model calls, so it
 * is cheap enough to run on every change to the SQL in sql/. It answers one
 * question — when we ask the corpus something we know it can answer, does the right
 * record come back, and at what rank?
 *
 * Two strategies are measured side by side:
 *
 *   current   public.search_corpus(...) exactly as the MCP server calls it.
 *   proposed  The semantics of public.mcp_search_tsquery, replicated inline so the
 *             fix can be measured before the migration in sql/002 is applied.
 *
 * The comparison exists because search_corpus originally built its tsquery with
 * plainto_tsquery, which ANDs every term: a natural-language question requires
 * every one of its words to appear in a single document, so it matches nothing.
 * Keeping both strategies in one report shows the size of that effect, and — once
 * the migration is applied and the two converge — whatever ranking work is left.
 *
 * Usage:  node eval/probe-retrieval.mjs [--set eval/golden-set.json] [--k 10]
 */

import fs from "node:fs";
import path from "node:path";
import { loadEnv, requireEnv, repoRoot } from "./lib/env.mjs";
import { createPool } from "./lib/db.mjs";

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const SET_PATH = path.resolve(repoRoot, argValue("--set", "eval/golden-set.json"));
const K = Number(argValue("--k", "10"));
const JSON_OUT = argValue("--json", null);

const env = requireEnv(loadEnv(), ["DATABASE_URL"]);
const pool = createPool(env.DATABASE_URL);

/** search_corpus as the MCP server calls it (see src/db.ts searchCorpus). */
const CURRENT_SQL = `
  SELECT id, score
  FROM public.search_corpus($1, NULL, NULL, NULL, NULL, $2, NULL, NULL, NULL, false)
`;

/**
 * Replicates public.mcp_search_tsquery inline, so the proposed query semantics can
 * be measured *before* the migration in sql/002 is applied. Keep the stopword list
 * and the length floor in step with that function; if the two drift, this strategy
 * stops predicting what the deployed server will do.
 *
 * Once the migration is applied, the `current` strategy converges on this one and
 * the gap between the two rows is the remaining ranking work.
 */
const STOPWORDS = [
  "yang", "dan", "untuk", "dengan", "pada", "dari", "ini", "itu", "tidak",
  "akan", "adalah", "dalam", "atau", "oleh", "sebagai", "juga", "telah",
  "serta", "terhadap", "melalui", "namun", "karena", "saja", "agar", "jika",
  "sudah", "belum", "masih", "antara", "setiap", "para", "kami", "kita",
  "mereka", "anda", "saya", "seperti", "yaitu", "yakni", "bahwa", "tersebut",
  "tentang", "apa", "bagaimana", "siapa", "mana", "kapan", "mengapa", "di",
  "ke", "ada", "bisa", "dapat", "harus", "lebih", "paling", "atas", "bawah",
  "the", "and", "for", "with", "that", "this", "from", "have", "has", "had",
  "are", "was", "were", "which", "their", "these", "those", "would", "should",
  "could", "there", "between", "through", "however", "because", "including",
  "what", "how", "where", "when", "why", "does", "did", "into", "about",
  "been", "being", "other", "than", "then", "they", "them", "its", "our",
  "your", "you", "any", "all", "some", "more", "most", "such", "only", "also",
  "over", "under", "upon", "each", "both", "per", "via", "not", "but", "is",
];

const PROPOSED_SQL = `
  WITH raw AS (
    SELECT array_agg(DISTINCT t) AS ts
    FROM (
      SELECT unnest(regexp_split_to_array(lower(extensions.unaccent($1)), '[^a-z0-9]+')) AS t
    ) s
    WHERE length(t) >= 2
  ), filtered AS (
    SELECT coalesce(
      (SELECT array_agg(t) FROM unnest(ts) AS t WHERE NOT (t = ANY ($3::text[]))),
      ts
    ) AS ts
    FROM raw
  ), q AS (
    SELECT to_tsquery('simple', array_to_string(ts, ' | ')) AS tsq FROM filtered
  )
  SELECT 'gdrive:' || d.id::text AS id,
         max(ts_rank_cd(c.content_tsv, (SELECT tsq FROM q))) AS score
  FROM public.knowledge_chunks c
  JOIN public.gdrive_knowledge_documents d ON d.id = c.document_id
  WHERE c.content_tsv @@ (SELECT tsq FROM q)
  GROUP BY d.id
  ORDER BY score DESC
  LIMIT $2
`;

// to_tsquery rejects raw punctuation, so strip the operators it reserves.
const sanitize = (text) => text.replace(/[?!."'()|&:*<>]/g, " ").replace(/\s+/g, " ").trim();

async function runStrategy(name, sql, items, { documentsOnly, params = [] }) {
  const scope = documentsOnly ? items.filter((i) => i.expected?.recordType === "document") : items;
  const stats = {
    strategy: name,
    scope: documentsOnly ? "document-backed positives" : "all positives",
    n: scope.length,
    zeroHit: 0,
    recallAt1: 0,
    recallAt3: 0,
    [`recallAt${K}`]: 0,
    mrr: 0,
    errors: 0,
    byLanguage: { en: { n: 0, hit: 0 }, id: { n: 0, hit: 0 } },
    crossLingual: { n: 0, hit: 0 },
  };

  for (const item of scope) {
    let rows = [];
    try {
      const extra = typeof params === "function" ? params(item) : params;
      if (extra === null) continue; // no data for this item (e.g. missing embedding)
      const result = await pool.query(sql, [sanitize(item.question), K, ...extra]);
      rows = result.rows;
    } catch {
      stats.errors += 1;
      continue;
    }

    const rank = rows.findIndex((row) => row.id === item.expected.recordId);
    const hit = rank >= 0;
    if (rows.length === 0) stats.zeroHit += 1;
    if (rank === 0) stats.recallAt1 += 1;
    if (hit && rank < 3) stats.recallAt3 += 1;
    if (hit) {
      stats[`recallAt${K}`] += 1;
      stats.mrr += 1 / (rank + 1);
    }

    const lang = stats.byLanguage[item.questionLanguage];
    if (lang) {
      lang.n += 1;
      if (hit) lang.hit += 1;
    }
    if (item.crossLingual) {
      stats.crossLingual.n += 1;
      if (hit) stats.crossLingual.hit += 1;
    }
  }

  stats.mrr = Number((stats.mrr / Math.max(stats.n, 1)).toFixed(4));
  return stats;
}

const pct = (part, total) => (total === 0 ? "n/a" : `${((part / total) * 100).toFixed(0)}%`);

function report(stats) {
  console.log(`\n${stats.strategy}  (${stats.scope}, n=${stats.n}, k=${K})`);
  console.log(`  zero-hit queries   ${stats.zeroHit} (${pct(stats.zeroHit, stats.n)})`);
  console.log(`  recall@1           ${pct(stats.recallAt1, stats.n)}`);
  console.log(`  recall@3           ${pct(stats.recallAt3, stats.n)}`);
  console.log(`  recall@${K}${" ".repeat(Math.max(1, 11 - String(K).length))}${pct(stats[`recallAt${K}`], stats.n)}`);
  console.log(`  MRR                ${stats.mrr}`);
  console.log(`  recall@${K} by lang  en ${pct(stats.byLanguage.en.hit, stats.byLanguage.en.n)} / id ${pct(stats.byLanguage.id.hit, stats.byLanguage.id.n)}`);
  console.log(`  cross-lingual      ${pct(stats.crossLingual.hit, stats.crossLingual.n)} (n=${stats.crossLingual.n})`);
  if (stats.errors > 0) console.log(`  query errors       ${stats.errors}`);
}

/** Negatives should return nothing, or only weak matches. */
async function reportNegatives(items) {
  const negatives = items.filter((item) => item.bucket === "unanswerable");
  if (negatives.length === 0) return null;

  let zero = 0;
  let weak = 0;
  let strong = 0;
  for (const item of negatives) {
    const { rows } = await pool.query(CURRENT_SQL, [sanitize(item.question), 3]);
    const top = rows.length > 0 ? Number(rows[0].score) : 0;
    if (rows.length === 0) zero += 1;
    else if (top < 0.25) weak += 1;
    else strong += 1;
  }

  console.log(`\nnegatives via search_corpus  (n=${negatives.length})`);
  console.log(`  returned nothing   ${zero} (${pct(zero, negatives.length)})  <- desired`);
  console.log(`  weak match only    ${weak}`);
  console.log(`  strong match       ${strong} (${pct(strong, negatives.length)})  <- false positives`);
  return { n: negatives.length, zero, weak, strong };
}

/** search_corpus_hybrid, which additionally takes a query embedding. */
const HYBRID_SQL = `
  SELECT id, score
  FROM public.search_corpus_hybrid($1, $3::extensions.vector, NULL, NULL, NULL, NULL, $2, NULL, NULL, NULL, false)
`;

/**
 * Loads precomputed question embeddings, if scripts/embed-golden-set.py has been run.
 * Returns null when unavailable so the probe still works without a Python
 * environment — the hybrid row is simply skipped rather than failing the run.
 */
function loadQuestionVectors(set) {
  const file = path.resolve(repoRoot, "eval/golden-set-embeddings.json");
  if (!fs.existsSync(file)) return null;

  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  if (payload.generatedAt && set.meta?.generatedAt && payload.generatedAt !== set.meta.generatedAt) {
    console.warn(
      "\nwarning: golden-set-embeddings.json was built from a different golden set " +
      "(re-run scripts/embed-golden-set.py) — skipping the hybrid strategy",
    );
    return null;
  }
  return payload.vectors ?? null;
}

async function main() {
  const set = JSON.parse(fs.readFileSync(SET_PATH, "utf8"));
  const positives = set.items.filter((item) => item.bucket !== "unanswerable");

  console.log(`Golden set: ${path.relative(repoRoot, SET_PATH)}`);
  console.log(`  ${set.items.length} items, ${positives.length} positives, generated ${set.meta?.generatedAt}`);

  const current = await runStrategy("current  public.search_corpus", CURRENT_SQL, positives, { documentsOnly: false });
  report(current);

  const proposed = await runStrategy("proposed mcp_search_tsquery", PROPOSED_SQL, positives, {
    documentsOnly: true,
    params: [STOPWORDS],
  });
  report(proposed);

  // Hybrid needs both the migration and the precomputed question vectors.
  const vectors = loadQuestionVectors(set);
  let hybrid = null;
  const hybridAvailable = await pool
    .query("SELECT to_regprocedure('public.search_corpus_hybrid(text, extensions.vector, text[], text, text, integer, integer, text, text, integer, boolean)') IS NOT NULL AS ok")
    .then((r) => r.rows[0].ok)
    .catch(() => false);

  if (!hybridAvailable) {
    console.log("\nhybrid  search_corpus_hybrid not installed — apply sql/003_hybrid_retrieval.sql");
  } else if (!vectors) {
    console.log("\nhybrid  question embeddings missing — run scripts/embed-golden-set.py");
  } else {
    hybrid = await runStrategy("hybrid  search_corpus_hybrid", HYBRID_SQL, positives, {
      documentsOnly: false,
      params: (item) => {
        const vec = vectors[item.id];
        return vec ? [JSON.stringify(vec)] : null;
      },
    });
    report(hybrid);

    // Per-record-type recall, since entity retrieval was the weakest surface and is
    // the main thing the entity embeddings are meant to fix.
    const byType = {};
    for (const item of positives) {
      const vec = vectors[item.id];
      if (!vec) continue;
      const { rows } = await pool.query(HYBRID_SQL, [sanitize(item.question), K, JSON.stringify(vec)]);
      const type = item.expected.recordType;
      byType[type] ??= { n: 0, at1: 0, at10: 0 };
      byType[type].n += 1;
      const rank = rows.findIndex((r) => r.id === item.expected.recordId);
      if (rank === 0) byType[type].at1 += 1;
      if (rank >= 0) byType[type].at10 += 1;
    }
    console.log("  by record type:");
    for (const [type, s] of Object.entries(byType)) {
      console.log(`    ${type.padEnd(10)} n=${String(s.n).padStart(2)}  recall@1 ${pct(s.at1, s.n).padStart(4)}  recall@${K} ${pct(s.at10, s.n).padStart(4)}`);
    }
    hybrid.byRecordType = byType;
  }

  const negatives = await reportNegatives(set.items);

  if (JSON_OUT) {
    const outPath = path.resolve(repoRoot, JSON_OUT);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify({
      probedAt: new Date().toISOString(),
      goldenSet: path.relative(repoRoot, SET_PATH),
      k: K,
      strategies: [current, proposed, hybrid].filter(Boolean),
      negatives,
    }, null, 2)}\n`);
    console.log(`\nWrote ${JSON_OUT}`);
  }
}

main()
  .catch((error) => {
    process.exitCode = 1;
    console.error(error);
  })
  .finally(() => pool.end());
