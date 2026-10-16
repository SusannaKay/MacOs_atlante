"""Collegamenti suggeriti dall'LLM.

Il motore non chiama nessun modello: prepara il lavoro e salva i risultati. L'LLM gira
sull'app per Mac (Ollama in locale), che chiede qui cosa analizzare e rimanda le risposte.

1. profili:   /api/ai/next -> l'app scrive riassunto ed entità -> /api/ai/profiles
2. abbinamenti: /api/ai/pending_match -> candidati scelti qui (entità/parole in comune)
                -> l'app decide quali sono collegati -> /api/ai/matches
3. tu decidi:  /api/suggestions/decide (accetta / scarta)
"""
import math
import re
import time
import unicodedata

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import db

router = APIRouter()

TEXT_KINDS = ("note", "pdf", "text", "markdown")
SKIP_KINDS = ("dir", "other", "archive")
NAME_ONLY_EXT = ("srt", "vtt", "sub", "ass")
EXCERPT_CHARS = 3500
MIN_CONFIDENCE = 0.6
COMMON_ENTITY = 250  # un'entità presente in troppi file non serve a trovare collegamenti

# file del vault scritti dal motore stesso (wiki, indice, log): non vanno analizzati come fonti
GENERATED_FILES = ("index.md", "log.md", "SCHEMA.md")


def generated_sql(col: str) -> str:
    """Condizione SQL vera se l'id in `col` è un file generato (wiki/, index.md, log.md…)."""
    return ("(substr({c},1,7)='n:wiki/' OR substr({c},1,12)='n:_proposte/' OR {c} IN ({f}))"
            .format(c=col, f=",".join("'n:%s'" % f for f in GENERATED_FILES)))


def is_generated(iid: str) -> bool:
    return iid.startswith(("n:wiki/", "n:_proposte/")) or iid[2:] in GENERATED_FILES


def get_con():
    con = db.connect()
    try:
        yield con
    finally:
        con.close()


def norm_entity(e: str) -> str:
    e = unicodedata.normalize("NFKD", str(e)).encode("ascii", "ignore").decode().lower()
    e = re.sub(r"[^\w\s]", " ", e)
    return re.sub(r"\s+", " ", e).strip()


def pair(x, y):
    return (x, y) if x < y else (y, x)


# ---------------------------------------------------------------- stato

@router.get("/api/ai/stats")
def stats(con=Depends(get_con)):
    q = lambda s, *a: con.execute(s, a).fetchone()[0]  # noqa: E731
    def eligible(a):
        return "%s.is_dir=0 AND %s.kind NOT IN (%s) AND NOT %s" % (
            a, a, ",".join("'%s'" % k for k in SKIP_KINDS), generated_sql(a + ".id"))
    total = q("SELECT count(*) FROM items i WHERE " + eligible("i"))
    profiled = q("SELECT count(*) FROM items i JOIN ai_profiles p ON p.id=i.id AND p.mtime=i.mtime WHERE " + eligible("i"))
    matched = q("SELECT count(*) FROM ai_match m JOIN items i ON i.id=m.id")
    by = {r["status"]: r["n"] for r in con.execute("SELECT status, count(*) n FROM suggestions GROUP BY status")}
    wiki = q("SELECT count(*) FROM wiki_pages WHERE locked=0 AND title<>''")
    return {"total": total, "profiled": profiled, "matched": matched, "wiki": wiki,
            "pending": by.get("pending", 0), "accepted": by.get("accepted", 0), "rejected": by.get("rejected", 0)}


# ---------------------------------------------------------------- 1. profili

@router.get("/api/ai/next")
def next_items(limit: int = 10, con=Depends(get_con)):
    """File ancora da descrivere: prima le note, poi i documenti con testo, poi il resto."""
    # prima scelgo i file (veloce, usa gli indici), poi leggo il loro testo in una sola passata
    rows = con.execute(
        "SELECT i.id, i.name, i.rel, i.kind, i.ext, i.year FROM items i "
        "LEFT JOIN ai_profiles p ON p.id=i.id "
        "WHERE i.is_dir=0 AND i.kind NOT IN (%s) AND (p.id IS NULL OR p.mtime IS NOT i.mtime) AND NOT %s "
        "ORDER BY (i.kind='note') DESC, (i.kind IN ('pdf','text','markdown')) DESC, i.mtime DESC LIMIT ?"
        % (",".join("'%s'" % k for k in SKIP_KINDS), generated_sql("i.id")), (max(1, min(limit, 50)),)).fetchall()
    bodies = {}
    ids = [r["id"] for r in rows if r["kind"] in TEXT_KINDS]
    if ids:
        for b in con.execute("SELECT id, substr(body, 1, ?) FROM items_fts WHERE id IN (%s)" % ",".join("?" * len(ids)),
                             [EXCERPT_CHARS] + ids):
            bodies[b[0]] = b[1]
    out = []
    for r in rows:
        body = (bodies.get(r["id"]) or "").strip()
        mode = "text" if len(body) > 200 and r["ext"] not in NAME_ONLY_EXT else "name"
        out.append({"id": r["id"], "name": r["name"], "path": ("Note/" if r["id"].startswith("n:") else "") + r["rel"],
                    "kind": r["kind"], "year": r["year"], "mode": mode, "text": body if mode == "text" else ""})
    return out


class Profile(BaseModel):
    id: str
    summary: str = ""
    entities: list[str] = []


class Profiles(BaseModel):
    model: str
    items: list[Profile]


@router.post("/api/ai/profiles")
def save_profiles(body: Profiles, con=Depends(get_con)):
    now = time.time()
    saved = 0
    with db.writing(con):
        for p in body.items:
            r = con.execute("SELECT mtime FROM items WHERE id=?", (p.id,)).fetchone()
            if not r:
                continue
            con.execute("INSERT OR REPLACE INTO ai_profiles(id, summary, model, created, mtime) VALUES(?,?,?,?,?)",
                        (p.id, p.summary.strip()[:600], body.model, now, r["mtime"]))
            con.execute("DELETE FROM ai_entities WHERE id=?", (p.id,))
            ents = {norm_entity(e) for e in p.entities[:15]}
            con.executemany("INSERT OR IGNORE INTO ai_entities(id, entity) VALUES(?,?)",
                            [(p.id, e) for e in ents if 3 <= len(e) <= 80])
            con.execute("DELETE FROM ai_match WHERE id=?", (p.id,))  # da riabbinare
            saved += 1
    return {"saved": saved}


# ---------------------------------------------------------------- 2. abbinamenti

def linked_ids(con, iid):
    s = {r[0] for r in con.execute("SELECT target_id FROM links WHERE src=? AND target_id IS NOT NULL", (iid,))}
    s |= {r[0] for r in con.execute("SELECT src FROM links WHERE target_id=?", (iid,))}
    s |= {r[0] for r in con.execute("SELECT b FROM suggestions WHERE a=?", (iid,))}
    s |= {r[0] for r in con.execute("SELECT a FROM suggestions WHERE b=?", (iid,))}
    return s


def candidates_for(con, iid, limit=8):
    ents = [r[0] for r in con.execute("SELECT entity FROM ai_entities WHERE id=?", (iid,))]
    skip = linked_ids(con, iid) | {iid}
    keep = lambda x: x not in skip and not is_generated(x)  # noqa: E731
    score = {}
    for e in ents:
        rows = con.execute("SELECT id FROM ai_entities WHERE entity=? LIMIT ?", (e, COMMON_ENTITY + 1)).fetchall()
        if len(rows) > COMMON_ENTITY:
            continue
        w = 1.0 / math.log(len(rows) + 1.5)
        for (other,) in rows:
            if keep(other):
                score[other] = score.get(other, 0) + w
    # parole chiave nel testo degli altri file
    words = [e for e in ents if len(e) >= 4][:6]
    if words:
        fq = " OR ".join('"%s"' % w.replace('"', "") for w in words)
        try:
            for r in con.execute("SELECT id FROM items_fts WHERE items_fts MATCH ? LIMIT 20", (fq,)):
                if keep(r[0]):
                    score[r[0]] = score.get(r[0], 0) + 0.5
        except Exception:
            pass
    best = sorted(score, key=lambda k: -score[k])[: limit * 2]
    out = []
    for cid in best:
        r = con.execute("SELECT i.id, i.name, i.rel, i.kind, i.year, p.summary FROM items i "
                        "LEFT JOIN ai_profiles p ON p.id=i.id WHERE i.id=? AND i.is_dir=0", (cid,)).fetchone()
        if r:
            out.append({"id": r["id"], "name": r["name"], "path": r["rel"], "kind": r["kind"], "year": r["year"],
                        "summary": r["summary"] or "",
                        "entities": [x[0] for x in con.execute("SELECT entity FROM ai_entities WHERE id=? LIMIT 10", (cid,))]})
        if len(out) >= limit:
            break
    return out


@router.get("/api/ai/pending_match")
def pending_match(limit: int = 3, con=Depends(get_con)):
    """File già descritti ma non ancora confrontati con gli altri, ciascuno con i suoi candidati."""
    rows = con.execute(
        "SELECT i.id, i.name, i.rel, i.kind, i.year, p.summary FROM items i "
        "JOIN ai_profiles p ON p.id=i.id AND p.mtime=i.mtime "
        "LEFT JOIN ai_match m ON m.id=i.id WHERE m.id IS NULL AND NOT " + generated_sql("i.id") + " "
        "ORDER BY (i.kind='note') DESC, i.mtime DESC LIMIT ?", (max(1, min(limit, 20)),)).fetchall()
    out = []
    empty = []
    for r in rows:
        cands = candidates_for(con, r["id"])
        if not cands:
            empty.append(r["id"])
            continue
        out.append({"id": r["id"], "name": r["name"], "path": r["rel"], "kind": r["kind"], "year": r["year"],
                    "summary": r["summary"] or "",
                    "entities": [x[0] for x in con.execute("SELECT entity FROM ai_entities WHERE id=?", (r["id"],))],
                    "candidates": cands})
    if empty:  # niente da confrontare: segno come fatto
        with db.writing(con):
            con.executemany("INSERT OR REPLACE INTO ai_match(id, model, created) VALUES(?, 'nessun candidato', ?)",
                            [(i, time.time()) for i in empty])
    return {"items": out, "skipped": len(empty)}


class MatchLink(BaseModel):
    target: str
    reason: str = ""
    confidence: float = 0.0


class Match(BaseModel):
    id: str
    model: str
    links: list[MatchLink] = []


@router.post("/api/ai/matches")
def save_matches(body: Match, con=Depends(get_con)):
    now = time.time()
    added = 0
    with db.writing(con):
        for l in body.links:
            if l.confidence < MIN_CONFIDENCE or l.target == body.id:
                continue
            if not con.execute("SELECT 1 FROM items WHERE id=?", (l.target,)).fetchone():
                continue
            a, b = pair(body.id, l.target)
            cur = con.execute("INSERT OR IGNORE INTO suggestions(a, b, reason, confidence, model, status, created) "
                              "VALUES(?,?,?,?,?,'pending',?)", (a, b, l.reason.strip()[:300], l.confidence, body.model, now))
            added += cur.rowcount
        con.execute("INSERT OR REPLACE INTO ai_match(id, model, created) VALUES(?,?,?)", (body.id, body.model, now))
    return {"added": added}


# ---------------------------------------------------------------- 3. revisione

def suggestion_rows(con, where, args, limit=200, offset=0):
    rows = con.execute(
        "SELECT s.sid, s.a, s.b, s.reason, s.confidence, s.status, ia.name AS a_name, ia.kind AS a_kind, "
        "ib.name AS b_name, ib.kind AS b_kind FROM suggestions s "
        "JOIN items ia ON ia.id=s.a JOIN items ib ON ib.id=s.b WHERE %s "
        "ORDER BY s.confidence DESC, s.sid LIMIT ? OFFSET ?" % where, args + [limit, offset]).fetchall()
    return [dict(r) for r in rows]


def for_item(con, iid, status):
    out = []
    for r in suggestion_rows(con, "(s.a=? OR s.b=?) AND s.status=?", [iid, iid, status], limit=100):
        other = r["b"] if r["a"] == iid else r["a"]
        out.append({"sid": r["sid"], "id": other, "name": r["b_name"] if other == r["b"] else r["a_name"],
                    "kind": r["b_kind"] if other == r["b"] else r["a_kind"],
                    "reason": r["reason"], "confidence": r["confidence"]})
    return out


def item_extras(con, iid):
    p = con.execute("SELECT summary, model FROM ai_profiles WHERE id=?", (iid,)).fetchone()
    return {
        "ai_summary": p["summary"] if p else None,
        "ai_entities": [r[0] for r in con.execute("SELECT entity FROM ai_entities WHERE id=?", (iid,))],
        "related": for_item(con, iid, "accepted"),
        "suggested": for_item(con, iid, "pending"),
    }


@router.get("/api/suggestions")
def list_suggestions(status: str = "pending", limit: int = 100, offset: int = 0, con=Depends(get_con)):
    if status not in ("pending", "accepted", "rejected"):
        raise HTTPException(400, "stato non valido")
    total = con.execute("SELECT count(*) FROM suggestions s JOIN items ia ON ia.id=s.a JOIN items ib ON ib.id=s.b "
                        "WHERE s.status=?", (status,)).fetchone()[0]
    return {"total": total, "items": suggestion_rows(con, "s.status=?", [status], min(limit, 500), offset)}


class Decide(BaseModel):
    sid: int
    accept: bool


@router.post("/api/suggestions/decide")
def decide(body: Decide, con=Depends(get_con)):
    with db.writing(con):
        cur = con.execute("UPDATE suggestions SET status=?, decided=? WHERE sid=?",
                          ("accepted" if body.accept else "rejected", time.time(), body.sid))
    if not cur.rowcount:
        raise HTTPException(404, "suggerimento non trovato")
    return {"ok": True}


class DecideMany(BaseModel):
    min_confidence: float
    accept: bool


@router.post("/api/suggestions/decide_many")
def decide_many(body: DecideMany, con=Depends(get_con)):
    with db.writing(con):
        cur = con.execute("UPDATE suggestions SET status=?, decided=? WHERE status='pending' AND confidence>=?",
                          ("accepted" if body.accept else "rejected", time.time(), body.min_confidence))
    return {"changed": cur.rowcount}


def graph_edges(con, include_pending):
    """Archi per il grafo: accettati sempre, in attesa solo se richiesti."""
    st = ("accepted", "pending") if include_pending else ("accepted",)
    return [(r["a"], r["b"], "ai" if r["status"] == "accepted" else "suggest") for r in con.execute(
        "SELECT a, b, status FROM suggestions WHERE status IN (%s)" % ",".join("?" * len(st)), st)]


def rename_ids(con, old, new):
    for t in ("ai_profiles", "ai_entities", "ai_match"):
        con.execute("UPDATE OR IGNORE %s SET id=? WHERE id=?" % t, (new, old))
    for r in con.execute("SELECT sid, a, b FROM suggestions WHERE a=? OR b=?", (old, old)).fetchall():
        a, b = pair(new if r["a"] == old else r["a"], new if r["b"] == old else r["b"])
        con.execute("UPDATE OR IGNORE suggestions SET a=?, b=? WHERE sid=?", (a, b, r["sid"]))
