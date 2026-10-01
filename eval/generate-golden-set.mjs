/**
 * Generates the AMANA retrieval evaluation golden set.
 *
 * The set is reference-free: each item carries a question plus the record the
 * answer was drawn from, and nothing else. There is no gold answer, because every
 * metric in the evaluation design (groundedness, citation accuracy, completeness)
 * judges a response against the context that retrieval returned rather than
 * against a reference text. What the set does provide is retrieval ground truth —
 * the document or record that *should* come back — which is what makes recall and
 * source coverage measurable.
 *
 * Composition (100 items):
 *   45  targeted_document  stratified so all 35 ingested documents are covered
 *   25  broad_document     uniform random over usable chunks
 *   15  entity             experts, past projects, partners, org knowledge
 *   15  unanswerable       plausible questions the corpus cannot support
 *
 * Questions are split ~50/50 English and Indonesian. Where the question language
 * differs from the source document's language the item is flagged `crossLingual`,
 * because search_corpus tokenises with the 'simple' configuration and does no
 * translation — cross-lingual recall is a real and separately interesting failure
 * mode rather than an accident of sampling.
 *
 * Sampling is seeded, so re-running reproduces the same item set. Only the model's
 * phrasing varies between runs.
 *
 * Usage:  node eval/generate-golden-set.mjs [--limit N] [--seed N] [--out path]
 */

import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { loadEnv, requireEnv, repoRoot } from "./lib/env.mjs";
import { createPool } from "./lib/db.mjs";
import { mulberry32, shuffle, detectLanguage, chunkQuality, normalizeForPrompt } from "./lib/text.mjs";

const MODEL = "claude-opus-5";

// Generation is a mechanical transformation of a passage into a question, so the
// low effort tier is the right trade here; the judge stages that score responses
// run at a higher tier.
const EFFORT = "low";
const CONCURRENCY = 6;

const PLAN = {
  targeted_document: 45,
  broad_document: 25,
  entity: 15,
  unanswerable: 15,
};

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const SEED = Number(argValue("--seed", "20260930"));
const LIMIT = Number(argValue("--limit", "0")); // 0 = no limit; used for smoke runs
const DRY_RUN = args.includes("--dry-run"); // report the sample plan, call no models
const OUT_PATH = path.resolve(repoRoot, argValue("--out", "eval/golden-set.json"));

const env = requireEnv(loadEnv(), ["DATABASE_URL", "ANTHROPIC_API_KEY"]);
const pool = createPool(env.DATABASE_URL);
const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
const rand = mulberry32(SEED);

// ---------------------------------------------------------------- corpus loading

async function loadDocuments() {
  const { rows } = await pool.query(`
    SELECT d.id, d.title, d.file_name, d.doc_type, d.practice_group, d.sector,
           d.client_name, d.project_name, d.document_year, d.confidentiality,
           d.source_url, count(c.id)::int AS chunk_count
    FROM public.gdrive_knowledge_documents d
    JOIN public.knowledge_chunks c ON c.document_id = d.id
    WHERE d.status = 'ready' AND d.archived_at IS NULL
    GROUP BY d.id
    ORDER BY d.id
  `);
  return rows;
}

async function loadCandidateChunks() {
  // Pre-filter in SQL on cheap numeric bounds, then apply the prose-quality
  // heuristics in JS. Chunks at the extremes are almost always extraction noise.
  const { rows } = await pool.query(`
    SELECT c.id, c.document_id, c.chunk_index, c.heading, c.content,
           c.page_from, c.page_to, c.token_estimate
    FROM public.knowledge_chunks c
    JOIN public.gdrive_knowledge_documents d ON d.id = c.document_id
    WHERE d.status = 'ready' AND d.archived_at IS NULL
      AND c.token_estimate BETWEEN 110 AND 700
      AND length(c.content) >= 400
    ORDER BY c.id
  `);

  return rows
    .map((row) => {
      const quality = chunkQuality(row.content);
      return { ...row, quality, language: detectLanguage(row.content) };
    })
    .filter((row) => row.quality >= 0.45 && row.language !== "unknown");
}

async function loadEntities() {
  const [experts, projects, partners, knowledge] = await Promise.all([
    pool.query(`
      SELECT e.id, e."fullName", e."positionTitle", e."practiceGroup",
             e."yearsOfExperience", e."topTechnicalSkills", e.education,
             e.certifications,
             coalesce(
               (SELECT string_agg(DISTINCT cap."skillName" || ' (' || coalesce(cap."domainName", '-') || ')', '; ')
                  FROM public."ExpertCapability" cap WHERE cap."expertId" = e.id),
               ''
             ) AS capabilities
      FROM public."Expert" e
      ORDER BY e.id
    `),
    pool.query(`
      SELECT id, title, client, sector, duration, objectives, deliverables,
             "keyOutcomes", "technologyStack", "lessonsLearned"
      FROM public."PastProject" ORDER BY id
    `),
    pool.query(`
      SELECT id, "organizationName", description, affiliation, cluster, tags, notes
      FROM public."PartnerContact" ORDER BY id
    `),
    pool.query(`
      SELECT id, title, category, summary, content, tags, "practiceGroup"
      FROM public."OrgKnowledgeEntry" ORDER BY id
    `),
  ]);

  return {
    expert: experts.rows,
    project: projects.rows,
    partner: partners.rows,
    knowledge: knowledge.rows,
  };
}

// ---------------------------------------------------------------- sampling

/**
 * Allocates the targeted budget so every document is represented at least once,
 * then distributes the remainder by sqrt(chunk_count). Plain proportional
 * weighting would spend most of the budget on the single 799-chunk report and
 * leave the small documents — where retrieval failures are most likely — untested.
 */
function allocateTargeted(documents, budget) {
  const eligible = documents.filter((doc) => doc.chunk_count > 0);
  const allocation = new Map(eligible.map((doc) => [doc.id, 1]));
  let remaining = budget - eligible.length;

  if (remaining > 0) {
    const weights = eligible.map((doc) => ({ id: doc.id, weight: Math.sqrt(doc.chunk_count) }));
    const total = weights.reduce((sum, item) => sum + item.weight, 0);
    // Largest-remainder apportionment keeps the total exact.
    const shares = weights
      .map((item) => ({ id: item.id, exact: (item.weight / total) * remaining }))
      .map((item) => ({ ...item, floor: Math.floor(item.exact) }));

    for (const share of shares) {
      allocation.set(share.id, allocation.get(share.id) + share.floor);
      remaining -= share.floor;
    }
    shares
      .sort((a, b) => b.exact - b.floor - (a.exact - a.floor))
      .slice(0, Math.max(0, remaining))
      .forEach((share) => allocation.set(share.id, allocation.get(share.id) + 1));
  }

  return allocation;
}

function pickTargetedChunks(documents, chunks, budget) {
  const byDocument = new Map();
  for (const chunk of chunks) {
    if (!byDocument.has(chunk.document_id)) byDocument.set(chunk.document_id, []);
    byDocument.get(chunk.document_id).push(chunk);
  }

  const documentsWithUsableChunks = documents.filter((doc) => byDocument.has(doc.id));
  const allocation = allocateTargeted(documentsWithUsableChunks, budget);
  const picked = [];

  for (const doc of documentsWithUsableChunks) {
    const wanted = allocation.get(doc.id) ?? 0;
    // Prefer higher-quality chunks but keep spread: shuffle the top half.
    const pool = byDocument.get(doc.id).slice().sort((a, b) => b.quality - a.quality);
    const head = pool.slice(0, Math.max(wanted, Math.ceil(pool.length / 2)));
    picked.push(...shuffle(head, rand).slice(0, wanted).map((chunk) => ({ chunk, document: doc })));
  }

  return picked;
}

function pickBroadChunks(documents, chunks, used, budget) {
  const documentById = new Map(documents.map((doc) => [doc.id, doc]));
  const available = chunks.filter((chunk) => !used.has(chunk.id));
  return shuffle(available, rand)
    .slice(0, budget)
    .map((chunk) => ({ chunk, document: documentById.get(chunk.document_id) }));
}

function pickEntities(entities, budget) {
  // Weighted toward experts and partners, which hold the most records and are the
  // most frequently asked-about surfaces (credentials and consortium search).
  const quota = { expert: 6, partner: 4, project: 3, knowledge: 2 };
  const picked = [];
  for (const [type, count] of Object.entries(quota)) {
    const rows = entities[type] ?? [];
    picked.push(...shuffle(rows, rand).slice(0, count).map((record) => ({ type, record })));
  }
  return picked.slice(0, budget);
}

// ---------------------------------------------------------------- prompt building

function describeDocument(doc) {
  return [
    ["Title", doc.title],
    ["File", doc.file_name],
    ["Document type", doc.doc_type],
    ["Practice group", doc.practice_group],
    ["Client", doc.client_name],
    ["Project", doc.project_name],
    ["Year", doc.document_year],
  ]
    .filter(([, value]) => value != null && value !== "")
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");
}

function describeEntity(type, record) {
  const parse = (value) => {
    if (!value) return null;
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.join("; ") : String(parsed);
    } catch {
      return String(value);
    }
  };

  if (type === "expert") {
    return [
      `Name: ${record.fullName}`,
      record.positionTitle && `Position: ${record.positionTitle}`,
      record.practiceGroup && `Practice group: ${record.practiceGroup}`,
      record.yearsOfExperience && `Years of experience: ${record.yearsOfExperience}`,
      parse(record.topTechnicalSkills) && `Skills: ${parse(record.topTechnicalSkills)}`,
      parse(record.education) && `Education: ${parse(record.education)}`,
      parse(record.certifications) && `Certifications: ${parse(record.certifications)}`,
      record.capabilities && `Capabilities: ${record.capabilities}`,
    ].filter(Boolean).join("\n");
  }

  if (type === "project") {
    return [
      `Title: ${record.title}`,
      record.client && `Client: ${record.client}`,
      record.sector && `Sector: ${record.sector}`,
      record.duration && `Duration: ${record.duration}`,
      parse(record.objectives) && `Objectives: ${parse(record.objectives)}`,
      parse(record.deliverables) && `Deliverables: ${parse(record.deliverables)}`,
      parse(record.keyOutcomes) && `Outcomes: ${parse(record.keyOutcomes)}`,
      parse(record.technologyStack) && `Technology: ${parse(record.technologyStack)}`,
    ].filter(Boolean).join("\n");
  }

  if (type === "partner") {
    return [
      `Organization: ${record.organizationName}`,
      record.affiliation && `Affiliation: ${record.affiliation}`,
      record.cluster && `Cluster: ${record.cluster}`,
      record.description && `Description: ${record.description}`,
      parse(record.tags) && `Tags: ${parse(record.tags)}`,
    ].filter(Boolean).join("\n");
  }

  return [
    `Title: ${record.title}`,
    record.category && `Category: ${record.category}`,
    record.practiceGroup && `Practice group: ${record.practiceGroup}`,
    record.summary && `Summary: ${record.summary}`,
    record.content && `Content: ${String(record.content).slice(0, 1200)}`,
  ].filter(Boolean).join("\n");
}

const LANGUAGE_NAME = { en: "English", id: "Bahasa Indonesia" };

const GENERATOR_SYSTEM = `You write evaluation questions for the knowledge retrieval system of AMANA, an Indonesian consulting firm working on digital government, public health, education, and strategy and transformation.

The questions are used to test whether a retrieval system can find the right source material. They will be asked against the whole knowledge base, not against the passage you are shown, so each question must stand alone.

Rules that matter for every question you write:
- Write the question the way an AMANA consultant or analyst would actually type it when looking for this material. Natural, specific, and self-contained.
- Never refer to "the document", "this passage", "the text above", or any position in a source. The reader of the question cannot see what you were shown.
- Paraphrase. Do not reuse distinctive noun phrases verbatim from the source. A question that copies the source's exact wording measures keyword overlap rather than retrieval quality, which makes it worthless as a test.
- Ask about substance the source genuinely establishes: findings, recommendations, mechanisms, figures, responsibilities, definitions. Do not ask about page numbers, formatting, or document structure.
- One question. No preamble, no alternatives.`;

const QUESTION_SCHEMA = {
  type: "object",
  properties: {
    question: { type: "string" },
    answerSketch: {
      type: "string",
      description: "One or two sentences stating what the source says in answer. Used as a reviewer hint, never as a graded reference.",
    },
    questionType: {
      type: "string",
      enum: ["factual", "definitional", "procedural", "comparative", "evaluative", "who_has_experience"],
    },
    difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
    reusesSourceWording: {
      type: "boolean",
      description: "True if the question had to reuse a distinctive phrase from the source, e.g. a proper noun with no paraphrase.",
    },
  },
  required: ["question", "answerSketch", "questionType", "difficulty", "reusesSourceWording"],
  additionalProperties: false,
};

const UNANSWERABLE_SCHEMA = {
  type: "object",
  properties: {
    question: { type: "string" },
    whyUncovered: { type: "string" },
    plausibility: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: ["question", "whyUncovered", "plausibility"],
  additionalProperties: false,
};

// ---------------------------------------------------------------- model calls

async function callModel({ system, prompt, schema, maxTokens = 6000 }) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: maxTokens,
        system,
        output_config: { effort: EFFORT, format: { type: "json_schema", schema } },
        messages: [{ role: "user", content: prompt }],
      });

      if (response.stop_reason === "refusal") {
        throw new Error(`model refused: ${response.stop_details?.category ?? "unknown"}`);
      }
      const text = response.content.filter((block) => block.type === "text").map((block) => block.text).join("");
      if (!text.trim()) throw new Error(`empty response (stop_reason=${response.stop_reason})`);
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function generateFromChunk(item, questionLanguage) {
  const { chunk, document } = item;
  const sourceLanguage = chunk.language;

  const crossLingualNote = questionLanguage !== sourceLanguage
    ? `\nThe source material is in ${LANGUAGE_NAME[sourceLanguage]} but you must write the question in ${LANGUAGE_NAME[questionLanguage]}. Use the terminology a ${LANGUAGE_NAME[questionLanguage]} speaker would naturally use — do not transliterate the source's wording.`
    : "";

  const result = await callModel({
    system: GENERATOR_SYSTEM,
    schema: QUESTION_SCHEMA,
    prompt: `Write one question in ${LANGUAGE_NAME[questionLanguage]}.${crossLingualNote}

Source document metadata:
${describeDocument(document)}
${chunk.heading ? `Section heading: ${chunk.heading}` : ""}

Source passage:
"""
${normalizeForPrompt(chunk.content).slice(0, 5000)}
"""`,
  });

  return {
    ...result,
    questionLanguage,
    sourceLanguage,
    crossLingual: questionLanguage !== sourceLanguage,
    expected: {
      recordId: `gdrive:${document.id}`,
      recordType: "document",
      chunkId: String(chunk.id),
      chunkIndex: chunk.chunk_index,
      heading: chunk.heading,
      pageFrom: chunk.page_from,
      pageTo: chunk.page_to,
      documentTitle: document.title,
      docType: document.doc_type,
      practiceGroup: document.practice_group,
      documentYear: document.document_year,
      sourceUrl: document.source_url,
      confidentiality: document.confidentiality,
    },
    provenance: { chunkQuality: chunk.quality, tokenEstimate: chunk.token_estimate },
  };
}

async function generateFromEntity(item, questionLanguage) {
  const { type, record } = item;
  const prefix = { expert: "expert", project: "project", partner: "partner", knowledge: "knowledge" }[type];
  const label = {
    expert: "a staff member in the talent roster",
    project: "a past AMANA project",
    partner: "a partner or consortium contact",
    knowledge: "an internal organisational knowledge entry",
  }[type];

  const guidance = type === "expert"
    ? "Ask the kind of question a proposal lead asks when staffing a bid — about capability, sector experience, or qualification. Do not name the person in the question; the retrieval system is supposed to find them."
    : type === "partner"
      ? "Ask the kind of question someone asks when assembling a consortium or looking for an implementing partner. Do not name the organisation in the question."
      : type === "project"
        ? "Ask the kind of question someone asks when looking for comparable past work or credentials to cite in a proposal."
        : "Ask the kind of question a staff member asks about how AMANA works internally.";

  const result = await callModel({
    system: GENERATOR_SYSTEM,
    schema: QUESTION_SCHEMA,
    prompt: `Write one question in ${LANGUAGE_NAME[questionLanguage]} that this record should be the answer to.

The record is ${label}. ${guidance}

Record:
"""
${describeEntity(type, record).slice(0, 4000)}
"""`,
  });

  const title = record.fullName ?? record.title ?? record.organizationName ?? "(untitled)";
  return {
    ...result,
    questionLanguage,
    sourceLanguage: "unknown",
    crossLingual: false,
    expected: {
      recordId: `${prefix}:${record.id}`,
      recordType: type,
      documentTitle: title,
      practiceGroup: record.practiceGroup ?? null,
    },
    provenance: { chunkQuality: null, tokenEstimate: null },
  };
}

async function generateUnanswerable(theme, questionLanguage, coverageSummary) {
  const result = await callModel({
    system: GENERATOR_SYSTEM,
    schema: UNANSWERABLE_SCHEMA,
    prompt: `Write one question in ${LANGUAGE_NAME[questionLanguage]} that AMANA staff could plausibly ask but that the knowledge base CANNOT answer.

This is a negative test case. The point is to check that the retrieval system returns nothing rather than returning weak, unrelated material that a model might then write up as fact. So the question must sound entirely reasonable for this firm while falling outside everything the corpus covers.

Focus this one on: ${theme}

What the corpus DOES cover (avoid all of it):
${coverageSummary}

Do not invent fake client names or fake statistics that could be mistaken for real records. Ask about a real-sounding topic, sector, geography, or time period that simply is not present.`,
  });

  return {
    ...result,
    answerSketch: null,
    questionType: "unanswerable",
    difficulty: "hard",
    reusesSourceWording: false,
    questionLanguage,
    sourceLanguage: null,
    crossLingual: false,
    theme,
    expected: { recordId: null, recordType: "none", shouldReturnNoSupport: true },
    provenance: { chunkQuality: null, tokenEstimate: null },
  };
}

// ---------------------------------------------------------------- negative check

/**
 * Runs each negative through the real search_corpus function. A question intended
 * to be unanswerable that returns a strong match is not a negative — it is a
 * mislabelled positive, and leaving it in the set would penalise the system for
 * correctly finding something. Items above the threshold are flagged rather than
 * dropped so the count stays reproducible and the reason stays visible.
 */
async function verifyNegatives(items) {
  for (const item of items) {
    try {
      const { rows } = await pool.query(
        `SELECT id, doc_type, title, score FROM public.search_corpus($1, NULL, NULL, NULL, NULL, 3, NULL, NULL, NULL, false)`,
        [item.question],
      );
      const topScore = rows.length > 0 ? Number(rows[0].score) : 0;
      item.negativeCheck = {
        topScore,
        topId: rows[0]?.id ?? null,
        topTitle: rows[0]?.title ?? null,
        hitCount: rows.length,
        verdict: topScore >= 0.25 ? "suspect_answerable" : "confirmed_unanswerable",
      };
    } catch (error) {
      item.negativeCheck = { error: String(error.message ?? error), verdict: "unverified" };
    }
  }
}

// ---------------------------------------------------------------- orchestration

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  let done = 0;

  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = { __error: String(error?.message ?? error) };
      }
      done += 1;
      if (done % 10 === 0 || done === items.length) {
        process.stderr.write(`  ${done}/${items.length}\n`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

/** Minimum number of items whose question language differs from their source. */
const CROSS_LINGUAL_FLOOR = 20;

/**
 * English quota per bucket. Balancing within each bucket rather than across the
 * set as a whole matters for the negatives in particular: Indonesian is the
 * dominant corpus language, so "correctly returns nothing" has to be tested in
 * Indonesian too. A global-only balance lets the buckets with no natural language
 * absorb the corpus skew and come out almost entirely English.
 *
 * The quotas sum to exactly half of PLAN's total.
 */
const ENGLISH_QUOTA = {
  targeted_document: 23,
  broad_document: 13,
  entity: 7,
  unanswerable: 7,
};

/**
 * Assigns question languages so each bucket is evenly split between English and
 * Indonesian, and a known share of chunk-backed items are deliberately
 * cross-lingual.
 *
 * Cross-lingual items are not a sampling accident to be minimised: search_corpus
 * tokenises with the 'simple' configuration and does no translation, so asking in
 * Indonesian against an English report is a failure mode worth measuring on
 * purpose.
 *
 * Per bucket: start chunk items in their source language, flip from the
 * over-represented side to meet the quota, then use balance-neutral pair swaps to
 * top cross-lingual coverage up to the floor.
 */
function assignLanguages(specs) {
  const languages = new Array(specs.length);
  const naturalOf = (spec) => (spec.kind === "chunk" ? spec.item.chunk.language : null);
  const buckets = [...new Set(specs.map((spec) => spec.bucket))];

  for (const bucket of buckets) {
    const indices = shuffle(
      specs.map((spec, index) => index).filter((index) => specs[index].bucket === bucket),
      rand,
    );
    const quota = ENGLISH_QUOTA[bucket] ?? Math.round(indices.length / 2);

    // Chunk items start in their source language; items without one are unset.
    for (const i of indices) languages[i] = naturalOf(specs[i]);

    const englishCount = () => indices.filter((i) => languages[i] === "en").length;
    const unset = indices.filter((i) => languages[i] == null);

    // Items with no source language fill whichever side is short.
    for (const i of unset) languages[i] = englishCount() < quota ? "en" : "id";

    // Close any remaining gap by flipping chunk items away from their source.
    const over = englishCount() > quota ? "en" : "id";
    const under = over === "en" ? "id" : "en";
    for (const i of indices) {
      if (englishCount() === quota) break;
      if (languages[i] !== over || naturalOf(specs[i]) !== over) continue;
      languages[i] = under;
    }
  }

  // Balance-neutral swaps across all chunk items: flipping one each way keeps
  // every quota intact while adding two cross-lingual items.
  const chunkIndices = specs.map((_, i) => i).filter((i) => naturalOf(specs[i]) !== null);
  const isCross = (i) => languages[i] !== naturalOf(specs[i]);
  let crossCount = chunkIndices.filter(isCross).length;

  for (const bucket of buckets) {
    const inBucket = (lang) =>
      shuffle(
        chunkIndices.filter(
          (i) => specs[i].bucket === bucket && !isCross(i) && naturalOf(specs[i]) === lang,
        ),
        rand,
      );
    const enPool = inBucket("en");
    const idPool = inBucket("id");
    while (crossCount < CROSS_LINGUAL_FLOOR && enPool.length > 0 && idPool.length > 0) {
      languages[enPool.pop()] = "id";
      languages[idPool.pop()] = "en";
      crossCount += 2;
    }
  }

  return languages;
}

const UNANSWERABLE_THEMES = [
  "a sector AMANA has no documented work in, such as mining or extractive industries",
  "agriculture and food security programming",
  "a geography outside Indonesia, such as a Pacific island state",
  "defence or military procurement",
  "a specific calendar year well before any document in the corpus",
  "climate finance and carbon markets",
  "tourism and creative economy development",
  "the operations practice group's internal service delivery work",
  "a named international financing instrument the corpus never discusses",
  "housing and urban land tenure policy",
  "vocational training for the maritime sector",
  "telecommunications spectrum auctions",
  "social protection cash transfer programme design",
  "water and sanitation infrastructure delivery",
  "electoral systems and voter administration",
];

async function main() {
  process.stderr.write(`Loading corpus (seed ${SEED})…\n`);
  const [documents, chunks, entities] = await Promise.all([
    loadDocuments(),
    loadCandidateChunks(),
    loadEntities(),
  ]);

  process.stderr.write(
    `  ${documents.length} documents, ${chunks.length} usable chunks, ` +
    `${entities.expert.length} experts / ${entities.project.length} projects / ` +
    `${entities.partner.length} partners / ${entities.knowledge.length} knowledge entries\n`,
  );

  const targeted = pickTargetedChunks(documents, chunks, PLAN.targeted_document);
  const usedChunkIds = new Set(targeted.map((item) => item.chunk.id));
  const broad = pickBroadChunks(documents, chunks, usedChunkIds, PLAN.broad_document);
  const entityPicks = pickEntities(entities, PLAN.entity);
  const themes = shuffle(UNANSWERABLE_THEMES, rand).slice(0, PLAN.unanswerable);

  const specs = [
    ...targeted.map((item) => ({ kind: "chunk", bucket: "targeted_document", item })),
    ...broad.map((item) => ({ kind: "chunk", bucket: "broad_document", item })),
    ...entityPicks.map((item) => ({ kind: "entity", bucket: "entity", item })),
    ...themes.map((theme) => ({ kind: "unanswerable", bucket: "unanswerable", item: theme })),
  ];

  const languages = assignLanguages(specs);
  const work = specs.map((spec, index) => ({ ...spec, language: languages[index] }));
  const selected = LIMIT > 0 ? work.slice(0, LIMIT) : work;

  const coverageSummary = documents
    .map((doc) => `- ${doc.doc_type ?? "unknown"} / ${doc.practice_group ?? "unassigned"}: ${doc.title}`)
    .slice(0, 40)
    .join("\n");

  if (DRY_RUN) {
    const tally = (list, key) =>
      list.reduce((acc, value) => ({ ...acc, [value[key] ?? "none"]: (acc[value[key] ?? "none"] ?? 0) + 1 }), {});
    const crossLingual = work.filter(
      (spec) => spec.kind === "chunk" && spec.language !== spec.item.chunk.language,
    ).length;
    const docsCovered = new Set(
      work.filter((spec) => spec.kind === "chunk").map((spec) => spec.item.document.id),
    );

    console.log(JSON.stringify({
      dryRun: true,
      seed: SEED,
      total: work.length,
      byBucket: tally(work, "bucket"),
      byQuestionLanguage: tally(work, "language"),
      languageByBucket: Object.fromEntries(
        [...new Set(work.map((spec) => spec.bucket))].map((bucket) => [
          bucket,
          {
            en: work.filter((spec) => spec.bucket === bucket && spec.language === "en").length,
            id: work.filter((spec) => spec.bucket === bucket && spec.language === "id").length,
          },
        ]),
      ),
      crossLingual,
      documentsCovered: `${docsCovered.size}/${documents.length}`,
      chunkSourceLanguages: tally(
        work.filter((spec) => spec.kind === "chunk").map((spec) => ({ lang: spec.item.chunk.language })),
        "lang",
      ),
      perDocumentQuestions: documents
        .map((doc) => ({
          title: (doc.title ?? "").slice(0, 60),
          chunks: doc.chunk_count,
          questions: work.filter((spec) => spec.kind === "chunk" && spec.item.document.id === doc.id).length,
        }))
        .sort((a, b) => b.questions - a.questions),
    }, null, 2));
    return;
  }

  process.stderr.write(`Generating ${selected.length} questions with ${MODEL} (effort=${EFFORT})…\n`);
  const generated = await mapWithConcurrency(selected, CONCURRENCY, async (spec) => {
    if (spec.kind === "chunk") return generateFromChunk(spec.item, spec.language);
    if (spec.kind === "entity") return generateFromEntity(spec.item, spec.language);
    return generateUnanswerable(spec.item, spec.language, coverageSummary);
  });

  const items = [];
  const failures = [];
  generated.forEach((result, index) => {
    const spec = selected[index];
    if (!result || result.__error) {
      failures.push({ bucket: spec.bucket, error: result?.__error ?? "unknown" });
      return;
    }
    items.push({
      id: `amana-eval-${String(items.length + 1).padStart(3, "0")}`,
      bucket: spec.bucket,
      ...result,
    });
  });

  const negatives = items.filter((item) => item.bucket === "unanswerable");
  if (negatives.length > 0) {
    process.stderr.write(`Verifying ${negatives.length} negatives against search_corpus…\n`);
    await verifyNegatives(negatives);
  }

  const output = {
    meta: {
      generatedAt: new Date().toISOString(),
      seed: SEED,
      generatorModel: MODEL,
      generatorEffort: EFFORT,
      plan: PLAN,
      counts: {
        total: items.length,
        byBucket: Object.fromEntries(
          Object.keys(PLAN).map((bucket) => [bucket, items.filter((item) => item.bucket === bucket).length]),
        ),
        byLanguage: {
          en: items.filter((item) => item.questionLanguage === "en").length,
          id: items.filter((item) => item.questionLanguage === "id").length,
        },
        crossLingual: items.filter((item) => item.crossLingual).length,
        distinctDocumentsCovered: new Set(
          items.filter((item) => item.expected?.recordType === "document").map((item) => item.expected.recordId),
        ).size,
        documentsInCorpus: documents.length,
      },
      failures,
      notes: [
        "Reference-free: items carry retrieval ground truth, not gold answers.",
        "answerSketch is a reviewer hint. Never score a response against it.",
        "Negatives flagged suspect_answerable should be reviewed before use as negatives.",
        "CAVEAT: while search_corpus builds its tsquery with plainto_tsquery (AND over " +
          "every term), any multi-word question returns zero rows, so every negative " +
          "trivially verifies as confirmed_unanswerable. Re-run this generator after that " +
          "is fixed to get a meaningful negative verification.",
      ],
    },
    items,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(output, null, 2)}\n`);

  process.stderr.write(`\nWrote ${items.length} items to ${path.relative(repoRoot, OUT_PATH)}\n`);
  if (failures.length > 0) process.stderr.write(`${failures.length} generation failures (see meta.failures)\n`);
  console.log(JSON.stringify(output.meta.counts, null, 2));
}

main()
  .catch((error) => {
    process.exitCode = 1;
    console.error(error);
  })
  .finally(() => pool.end());
