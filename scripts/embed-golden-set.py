"""Embed the golden-set questions so probe-retrieval.mjs can evaluate the hybrid path.

The probe is Node and has no embedding model; search_corpus_hybrid needs a query
vector. This precomputes them once into eval/golden-set-embeddings.json, keyed by
item id, so the probe stays dependency-free and repeated runs cost nothing.

Uses the same model as the stored corpus vectors — they are only comparable if the
model matches.

    ~/.pyenv/versions/3.11.11/envs/proposal-agent/bin/python scripts/embed-golden-set.py

Re-run after regenerating the golden set. The probe warns if the two are out of sync.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from fastembed import TextEmbedding

REPO_ROOT = Path(__file__).resolve().parent.parent
MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
SET_PATH = REPO_ROOT / "eval" / "golden-set.json"
OUT_PATH = REPO_ROOT / "eval" / "golden-set-embeddings.json"


def main() -> int:
    if not SET_PATH.exists():
        print(f"missing {SET_PATH}", file=sys.stderr)
        return 2

    golden = json.loads(SET_PATH.read_text(encoding="utf-8"))
    items = golden["items"]
    print(f"embedding {len(items)} questions with {MODEL_NAME} …", file=sys.stderr)

    model = TextEmbedding(model_name=MODEL_NAME)
    vectors = list(model.embed([item["question"] for item in items]))

    payload = {
        "model": MODEL_NAME,
        "generatedAt": golden.get("meta", {}).get("generatedAt"),
        "seed": golden.get("meta", {}).get("seed"),
        # 6 decimals is well past what cosine ranking can distinguish and keeps the
        # file about a third of the size of full float repr.
        "vectors": {
            item["id"]: [round(float(x), 6) for x in vector]
            for item, vector in zip(items, vectors)
        },
    }

    OUT_PATH.write_text(json.dumps(payload), encoding="utf-8")
    dim = len(next(iter(payload["vectors"].values())))
    print(f"wrote {OUT_PATH.relative_to(REPO_ROOT)}  ({len(payload['vectors'])} vectors, dim {dim})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
