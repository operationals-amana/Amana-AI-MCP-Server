/**
 * Deterministic PRNG so a re-run with the same seed reproduces the same sample.
 * Reproducibility is a requirement of the evaluation design: a golden set that
 * silently changes between runs makes quality trends unreadable.
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(items, rand) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Function words that are common in one language and essentially absent in the
// other. Counting these is enough to separate Indonesian from English prose and
// avoids pulling in a language-detection dependency.
const ID_MARKERS = [
  "yang", "dan", "untuk", "dengan", "pada", "dari", "ini", "itu", "tidak",
  "akan", "adalah", "dalam", "atau", "dapat", "oleh", "sebagai", "juga",
  "telah", "harus", "serta", "terhadap", "melalui", "namun", "karena",
];

const EN_MARKERS = [
  "the", "and", "for", "with", "that", "this", "from", "have", "has", "are",
  "was", "were", "which", "their", "these", "those", "would", "should",
  "there", "between", "through", "however", "because", "including",
];

/** Returns "id", "en", or "unknown" for a block of text. */
export function detectLanguage(text) {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  if (words.length < 20) return "unknown";

  let id = 0;
  let en = 0;
  for (const word of words) {
    if (ID_MARKERS.includes(word)) id += 1;
    if (EN_MARKERS.includes(word)) en += 1;
  }

  // Require a clear margin; mixed-language chunks are common in this corpus and
  // are better excluded than mislabelled.
  if (id >= en * 1.5 && id >= 3) return "id";
  if (en >= id * 1.5 && en >= 3) return "en";
  return "unknown";
}

/**
 * Scores how usable a chunk is as the basis for a question, 0..1.
 *
 * The corpus is built from PDF extraction, so a large share of chunks are table
 * fragments, running headers, or words broken across line ends. Generating a
 * question from one of those produces an unanswerable item and quietly poisons
 * the golden set, so candidates are filtered before they reach the model.
 */
export function chunkQuality(content) {
  const text = content.replace(/^\s*…\s*/, "").trim();
  if (text.length < 400) return 0;

  const lines = text.split("\n");
  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  const digits = (text.match(/[0-9]/g) ?? []).length;
  const words = text.match(/[A-Za-z]{2,}/g) ?? [];

  // Fraction of characters that are letters: low means tables or numeric dumps.
  const letterRatio = letters / text.length;
  // Short lines dominate in tables and bullet-fragment layouts.
  const shortLines = lines.filter((line) => line.trim().length > 0 && line.trim().length < 12).length;
  const shortLineRatio = lines.length > 0 ? shortLines / lines.length : 1;
  // Long runs of dots are table-of-contents leaders.
  const hasTocLeaders = /\.{5,}/.test(text);
  // Sentence-ish punctuation indicates prose rather than a fragment list.
  const sentences = (text.match(/[.!?](\s|$)/g) ?? []).length;

  if (letterRatio < 0.55) return 0;
  if (shortLineRatio > 0.45) return 0;
  if (hasTocLeaders) return 0;
  if (words.length < 60) return 0;
  if (sentences < 3) return 0;
  if (digits / text.length > 0.18) return 0;

  let score = 0;
  score += Math.min(letterRatio, 0.85) / 0.85 * 0.4;
  score += Math.min(1, sentences / 8) * 0.3;
  score += (1 - Math.min(shortLineRatio / 0.45, 1)) * 0.3;
  return Number(score.toFixed(3));
}

/** Collapses extraction whitespace so prompts stay readable and cheap. */
export function normalizeForPrompt(content) {
  return content
    .replace(/^\s*…\s*/, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
