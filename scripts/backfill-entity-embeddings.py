"""Populate public.mcp_entity_embeddings for the structured MCP records.

Why
---
Entity retrieval was the weakest part of corpus search: lexically, the correct
record landed in the top 10 of its own ranking only 5 times out of 15 on
eval/golden-set.json (experts 33% recall@10, partners 25%, knowledge 0%). The cause
is paraphrase — a question like "who can lead product concept definition with user
interviews" shares almost no tokens with a skills JSON blob, and hundreds of records
match the query's common words equally weakly.

Embedding the same text fixes most of it: experts, projects and org-knowledge all
reach 100% recall@10, and entities overall 80%. (Partners do not improve and stay at
25% — see the note at the end of this docstring.)

Model
-----
sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2, 384 dims — the same
model that produced the embeddings already stored on knowledge_chunks and
gdrive_knowledge_documents. It must stay the same: vectors from different models are
not comparable, and mixing them silently degrades ranking rather than erroring.
Resolved from the proposal agent's own setting so the two cannot drift apart.

Running it
----------
    ~/.pyenv/versions/3.11.11/envs/proposal-agent/bin/python \\
        scripts/backfill-entity-embeddings.py [--dry-run]

Requires sql/003_hybrid_retrieval.sql to have been applied first.

Re-runnable and incremental: each record's text is hashed, and only changed rows are
re-embedded. Entity rows are edited through the operational dashboard, which knows
nothing about this table, so there is no trigger keeping it current — run this on a
schedule, or after a bulk roster edit. Rows whose source record has been deleted are
removed.

Known limitation
----------------
Partner contacts do not benefit (25% recall@10 either way). Their records are thin —
often little more than an organisation name, affiliation and cluster — so there is
not enough text for either matching strategy to discriminate among 220 of them.
Fixing that needs richer partner descriptions, not a better retrieval strategy.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import sys
from pathlib import Path

import asyncpg
from fastembed import TextEmbedding

REPO_ROOT = Path(__file__).resolve().parent.parent
MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
EXPECTED_DIM = 384
BATCH = 64


def load_env(file_name: str = ".env.production") -> dict[str, str]:
    """Parse a shell-style env file; real environment variables win."""
    env: dict[str, str] = {}
    path = REPO_ROOT / file_name
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            match = re.match(r"^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$", line)
            if match:
                env[match.group(1)] = match.group(2).strip().strip("'\"")
    env.update(os.environ)
    return env


def unwrap(value) -> str:
    """Prisma stores several of these fields as JSON-encoded text."""
    if not value:
        return ""
    if isinstance(value, (list, tuple)):
        return "; ".join(str(v) for v in value if v)
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return str(value)
    if isinstance(parsed, list):
        return "; ".join(str(v) for v in parsed if v)
    return str(parsed)


def join(parts) -> str:
    return ". ".join(str(p).strip() for p in parts if p and str(p).strip())


# Body construction is the measured configuration — changing it changes retrieval
# quality, so re-run eval/probe-retrieval.mjs if you touch these.
QUERIES = {
    "expert": """
        SELECT e.id,
               e."fullName", e."positionTitle", e."practiceGroup", e."yearsOfExperience",
               e."topTechnicalSkills", e.education, e.certifications,
               coalesce((
                 SELECT string_agg(DISTINCT c."skillName" || ' ' || coalesce(c."domainName", ''), '; ')
                 FROM public."ExpertCapability" c WHERE c."expertId" = e.id
               ), '') AS caps
        FROM public."Expert" e
    """,
    "project": """
        SELECT id, title, client, sector, duration, objectives, deliverables,
               "keyOutcomes", "technologyStack", "lessonsLearned"
        FROM public."PastProject"
    """,
    "partner": """
        SELECT id, "organizationName", description, affiliation, cluster, tags, notes
        FROM public."PartnerContact"
    """,
    "knowledge": """
        SELECT id, title, category, summary, content, tags, "practiceGroup"
        FROM public."OrgKnowledgeEntry"
    """,
}


def build_body(record_type: str, row) -> str:
    if record_type == "expert":
        years = f"{row['yearsOfExperience']} years experience" if row["yearsOfExperience"] else ""
        return join([
            row["fullName"], row["positionTitle"], row["practiceGroup"], years,
            unwrap(row["topTechnicalSkills"]), unwrap(row["education"]),
            unwrap(row["certifications"]), row["caps"],
        ])
    if record_type == "project":
        return join([
            row["title"], row["client"], row["sector"], row["duration"],
            unwrap(row["objectives"]), unwrap(row["deliverables"]),
            unwrap(row["keyOutcomes"]), unwrap(row["technologyStack"]),
            unwrap(row["lessonsLearned"]),
        ])
    if record_type == "partner":
        return join([
            row["organizationName"], row["affiliation"], row["cluster"],
            row["description"], unwrap(row["tags"]), row["notes"],
        ])
    return join([
        row["title"], row["category"], row["practiceGroup"], row["summary"],
        (row["content"] or "")[:2000], unwrap(row["tags"]),
    ])


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="report what would change, write nothing")
    args = parser.parse_args()

    env = load_env()
    # Session-mode pooler: this writes, so avoid the transaction-mode URL.
    url = env.get("DIRECT_URL") or env.get("DATABASE_URL")
    if not url:
        print("Neither DIRECT_URL nor DATABASE_URL is set", file=sys.stderr)
        return 2

    conn = await asyncpg.connect(url, ssl="require", statement_cache_size=0)
    try:
        exists = await conn.fetchval(
            "SELECT to_regclass('public.mcp_entity_embeddings') IS NOT NULL"
        )
        if not exists:
            print("mcp_entity_embeddings does not exist — apply sql/003_hybrid_retrieval.sql first", file=sys.stderr)
            return 2

        wanted: dict[str, tuple[str, str, str]] = {}  # record_id -> (type, hash, body)
        for record_type, sql in QUERIES.items():
            for row in await conn.fetch(sql):
                record_id = f"{record_type}:{row['id']}"
                body = build_body(record_type, row)
                if not body:
                    continue
                digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
                wanted[record_id] = (record_type, digest, body)

        existing = {
            r["record_id"]: r["content_hash"]
            for r in await conn.fetch("SELECT record_id, content_hash FROM public.mcp_entity_embeddings")
        }

        todo = [(rid, v) for rid, v in wanted.items() if existing.get(rid) != v[1]]
        orphans = [rid for rid in existing if rid not in wanted]

        by_type: dict[str, int] = {}
        for rid, (record_type, _, _) in todo:
            by_type[record_type] = by_type.get(record_type, 0) + 1

        print(f"source records      {len(wanted)}")
        print(f"already current     {len(wanted) - len(todo)}")
        print(f"to embed            {len(todo)}  {by_type or ''}")
        print(f"orphans to delete   {len(orphans)}")

        if args.dry_run:
            print("\ndry run — nothing written")
            return 0

        if todo:
            print(f"\nloading {MODEL_NAME} …")
            model = TextEmbedding(model_name=MODEL_NAME)
            done = 0
            for start in range(0, len(todo), BATCH):
                chunk = todo[start:start + BATCH]
                vectors = list(model.embed([body for _, (_, _, body) in chunk]))
                rows = []
                for (rid, (record_type, digest, _)), vector in zip(chunk, vectors):
                    values = [float(x) for x in vector]
                    if len(values) != EXPECTED_DIM:
                        raise RuntimeError(
                            f"model returned {len(values)} dims, expected {EXPECTED_DIM}; "
                            "the column and the stored corpus vectors would no longer match"
                        )
                    rows.append((rid, record_type, digest, "[" + ",".join(map(repr, values)) + "]"))

                await conn.executemany(
                    """
                    INSERT INTO public.mcp_entity_embeddings
                      (record_id, record_type, content_hash, embedding, updated_at)
                    VALUES ($1, $2, $3, $4::extensions.vector, now())
                    ON CONFLICT (record_id) DO UPDATE
                      SET record_type = EXCLUDED.record_type,
                          content_hash = EXCLUDED.content_hash,
                          embedding = EXCLUDED.embedding,
                          updated_at = now()
                    """,
                    rows,
                )
                done += len(chunk)
                print(f"  embedded {done}/{len(todo)}")

        if orphans:
            await conn.execute(
                "DELETE FROM public.mcp_entity_embeddings WHERE record_id = ANY($1::text[])",
                orphans,
            )
            print(f"deleted {len(orphans)} orphaned rows")

        total = await conn.fetchval("SELECT count(*) FROM public.mcp_entity_embeddings")
        per_type = await conn.fetch(
            "SELECT record_type, count(*) AS n FROM public.mcp_entity_embeddings GROUP BY record_type ORDER BY record_type"
        )
        print(f"\nmcp_entity_embeddings now holds {total} rows:")
        for row in per_type:
            print(f"  {row['record_type']:<10} {row['n']}")
        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
