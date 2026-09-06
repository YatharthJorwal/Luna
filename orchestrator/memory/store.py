"""
Facts/episodes CRUD, plus the actual vec0 nearest-neighbor query. All
functions here are synchronous (sqlite3 has no async driver, and these
are all fast local-disk operations) -- callers in recall.py/
consolidation.py run them via `asyncio.to_thread` the same way tts.py's
pyttsx3 path and stt.py's transcribe() already keep blocking calls off
the event loop.

`facts` has no cap enforced here -- `MAX_FACTS_IN_RECALL` in recall.py
bounds how many get *read back* into a prompt, not how many exist. If
this ever becomes a real problem (thousands of facts, most stale/
duplicated), that's a consolidation-quality problem to solve in
consolidation.py (e.g. dedup/merge on write), not something to solve by
silently dropping facts here.
"""

from __future__ import annotations

import struct

from . import db


def add_fact(content: str) -> None:
    content = content.strip()
    if not content:
        return
    conn = db.get_connection()
    conn.execute("INSERT INTO facts (content) VALUES (?)", (content,))
    conn.commit()


def get_all_facts(limit: int | None = None) -> list[str]:
    conn = db.get_connection()
    # `created_at` only has 1-second resolution (SQLite's datetime('now')),
    # so a tiebreaker on `id DESC` matters in practice, not just in
    # theory -- add_fact() calls happening back-to-back within the same
    # second (e.g. consolidation.py writing several facts from one
    # session) would otherwise come back in an arbitrary order relative
    # to each other. Found by a real test failure, not anticipated up
    # front -- see memory/test_memory.py.
    query = "SELECT content FROM facts ORDER BY created_at DESC, id DESC"
    if limit is not None:
        query += f" LIMIT {int(limit)}"
    rows = conn.execute(query).fetchall()
    return [row[0] for row in rows]


def add_episode(summary: str, embedding: list[float]) -> int:
    """Inserts an episode row and its embedding, sharing one explicit
    rowid between `episodes` and `episode_vectors` so a vector search hit
    can be joined straight back to its summary text. Both inserts happen
    in one transaction -- either both succeed or neither does, so the two
    tables can't drift out of sync with each other."""
    summary = summary.strip()
    conn = db.get_connection()
    cursor = conn.execute("INSERT INTO episodes (summary) VALUES (?)", (summary,))
    episode_id = cursor.lastrowid
    conn.execute(
        "INSERT INTO episode_vectors (rowid, embedding) VALUES (?, ?)",
        (episode_id, _pack(embedding)),
    )
    conn.commit()
    return episode_id


def search_episodes(query_embedding: list[float], top_k: int) -> list[str]:
    """Returns up to `top_k` episode summaries, nearest-first, by cosine/L2
    distance over `episode_vectors` (sqlite-vec's `vec0` MATCH query --
    same shape verified in the sandbox against a synthetic in-memory DB,
    see memory/test_memory.py). Empty list if there are no episodes yet,
    not an error -- a fresh install with no history is the normal starting
    state, not a failure."""
    conn = db.get_connection()
    # sqlite-vec's vec0 KNN queries require a `k = ?` constraint alongside
    # `MATCH` -- a plain `LIMIT ?` with a *bound* parameter isn't accepted
    # (`OperationalError: A LIMIT or 'k = ?' constraint is required on vec0
    # knn queries`), even though a literal `LIMIT 5` works fine. Found by a
    # real test failure (see memory/test_memory.py), not anticipated from
    # documentation alone -- `k = ?` is the parameterized form that's
    # actually accepted.
    rows = conn.execute(
        """
        SELECT episodes.summary, episode_vectors.distance
        FROM episode_vectors
        JOIN episodes ON episodes.id = episode_vectors.rowid
        WHERE episode_vectors.embedding MATCH ? AND k = ?
        ORDER BY episode_vectors.distance
        """,
        (_pack(query_embedding), top_k),
    ).fetchall()
    return [row[0] for row in rows]


def _pack(vector: list[float]) -> bytes:
    """sqlite-vec stores/queries vectors as raw little-endian float32
    bytes, not JSON -- struct.pack is the documented way to hand one over
    from Python (confirmed against sqlite-vec's own README examples, and
    exercised directly in memory/test_memory.py's sandbox smoke test)."""
    return struct.pack(f"{len(vector)}f", *vector)
