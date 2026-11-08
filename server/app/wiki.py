"""Wiki compilata dall'LLM (il pattern «LLM Wiki» di Karpathy).

Come per i collegamenti, il motore non chiama nessun modello: sceglie su cosa scrivere,
prepara il materiale e poi scrive i file. L'LLM gira sull'app per Mac.

1. /api/wiki/next  -> un'entità che compare in abbastanza file, con i riassunti dei file
                      non ancora usati, la pagina attuale (se c'è) e le pagine collegabili
2. l'app chiede all'LLM i contenuti della pagina (in JSON)
3. /api/wiki/page  -> il motore scrive vault/wiki/entita/<slug>.md, rigenera index.md
                      e aggiunge una riga a log.md

Le pagine scritte qui hanno `generato: atlante` nel frontmatter. Una pagina con
`bloccata: true`, o senza `generato: atlante` (scritta a mano), non viene mai toccata.
"""
import datetime as dt
import json
import os
import re
import time

import yaml
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import db, notes
from .ai import COMMON_ENTITY, generated_sql, get_con
from .config import STORAGE_LABEL, VAULT_LABEL, VAULT_ROOT

router = APIRouter()

# impostati da main.startup(): register(con, rel), index_note(id, text), resolve_links(), link_name(con, id)
HOOKS = {}

ENT_DIR = "wiki/entita"
SECTIONS = (("entita", "Entità"), ("temi", "Temi"), ("risposte", "Risposte"))
MIN_FILES = 3          # un'entità diventa una pagina quando compare in almeno 3 file
BATCH = 8              # fonti nuove per ogni passaggio dell'LLM
RELATED = 25           # pagine proposte all'LLM come possibili collegamenti
MAX_DETAILS = 6000     # caratteri della pagina attuale passati all'LLM

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo("Europe/Rome")
except Exception:  # noqa: BLE001
    TZ = None


def now_local():
    return dt.datetime.now(TZ) if TZ else dt.datetime.now()


def slug_for(entity: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", entity.lower()).strip("-")[:80] or "pagina"


def page_rel(slug: str) -> str:
    return "%s/%s.md" % (ENT_DIR, slug)


def write_atomic(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".atlante-tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def touchable(rel: str) -> bool:
    """Si può riscrivere? Solo se non esiste o se l'ha scritta Atlante e non è bloccata."""
    p = os.path.join(VAULT_ROOT, rel)
    if not os.path.exists(p):
        return True
    try:
        with open(p, encoding="utf-8", errors="replace") as f:
            fm, _ = notes.split_frontmatter(f.read(20000))
    except OSError:
        return False
    if str(fm.get("generato", "")).strip().lower() != "atlante":
        return False
    return str(fm.get("bloccata", "")).strip().lower() not in ("true", "1", "si", "sì", "yes")


def plain(s) -> str:
    """Testo dell'LLM ripulito: niente [[link]] (li mette il motore), titoli al terzo livello."""
    s = str(s or "").replace("\r", "")
    s = re.sub(r"!?\[\[(?:[^\]|]*\|)?([^\]]*)\]\]", r"\1", s)
    s = re.sub(r"^#{1,2}(?=\s)", "###", s, flags=re.M)
    return s.strip()


def one_line(s, limit=200) -> str:
    return re.sub(r"\s+", " ", plain(s)).strip()[:limit]


def clean_list(v, limit=10, n=80):
    out = []
    for x in v or []:
        x = one_line(x, n)
        if x and x.lower() not in (o.lower() for o in out):
            out.append(x)
    return out[:limit]


def tag_for(s: str) -> str:
    return re.sub(r"[^\w\-/]+", "-", one_line(s, 40).lower()).strip("-")


def jl(v):
    try:
        return json.loads(v) if v else []
    except ValueError:
        return []


# ---------------------------------------------------------------- 1. cosa scrivere

PICK = """
SELECT e.entity, count(*) AS n, sum(ws.id IS NULL) AS fresh, max(w.updated) AS updated
FROM ai_entities e
JOIN items i ON i.id = e.id
JOIN ai_profiles p ON p.id = e.id AND p.mtime = i.mtime
LEFT JOIN wiki_sources ws ON ws.entity = e.entity AND ws.id = e.id
LEFT JOIN wiki_pages w ON w.entity = e.entity
WHERE p.summary <> '' AND coalesce(w.locked, 0) = 0 AND NOT {gen}
GROUP BY e.entity
HAVING n >= ? AND n <= ? AND fresh > 0
ORDER BY (max(w.updated) IS NOT NULL), n DESC
LIMIT 1
""".format(gen=generated_sql("i.id"))


def lock(con, entity, slug=None):
    with db.writing(con):
        con.execute("INSERT INTO wiki_pages(entity, slug, locked, created, updated) VALUES(?,?,1,?,?) "
                    "ON CONFLICT(entity) DO UPDATE SET locked=1",
                    (entity, slug, time.time(), time.time()))


def free_slug(con, entity):
    base = slug_for(entity)
    slug, n = base, 1
    while True:
        r = con.execute("SELECT entity FROM wiki_pages WHERE slug=?", (slug,)).fetchone()
        if (not r or r["entity"] == entity) and (r or touchable(page_rel(slug))):
            return slug
        n += 1
        slug = "%s-%d" % (base, n)


def fresh_sources(con, entity, limit=BATCH):
    rows = con.execute(
        "SELECT i.id, i.src, i.rel, i.name, i.kind, i.year, p.summary FROM ai_entities e "
        "JOIN items i ON i.id=e.id JOIN ai_profiles p ON p.id=e.id AND p.mtime=i.mtime "
        "LEFT JOIN wiki_sources ws ON ws.entity=e.entity AND ws.id=e.id "
        "WHERE e.entity=? AND ws.id IS NULL AND p.summary<>'' AND NOT " + generated_sql("i.id") + " "
        "ORDER BY i.mtime DESC LIMIT ?", (entity, limit)).fetchall()
    out = []
    for r in rows:
        ents = [x[0] for x in con.execute("SELECT entity FROM ai_entities WHERE id=? AND entity<>? LIMIT 8",
                                          (r["id"], entity))]
        out.append({"id": r["id"], "path": ("vault/" if r["src"] == "n" else "") + r["rel"], "name": r["name"],
                    "kind": r["kind"], "year": r["year"], "summary": r["summary"], "entities": ents})
    return out


def related_pages(con, entity):
    rows = con.execute(
        "SELECT w.entity, w.slug, w.title, w.descrizione, count(*) AS c FROM ai_entities e1 "
        "JOIN ai_entities e2 ON e2.id=e1.id AND e2.entity<>e1.entity "
        "JOIN wiki_pages w ON w.entity=e2.entity AND w.locked=0 AND w.title<>'' "
        "WHERE e1.entity=? GROUP BY w.entity ORDER BY c DESC LIMIT ?", (entity, RELATED)).fetchall()
    return [{"entity": r["entity"], "title": r["title"], "descrizione": r["descrizione"] or ""} for r in rows]


@router.get("/api/wiki/next")
def wiki_next(con=Depends(get_con)):
    for _ in range(10):
        row = con.execute(PICK, (MIN_FILES, COMMON_ENTITY)).fetchone()
        if not row:
            return {"item": None}
        ent = row["entity"]
        page = con.execute("SELECT * FROM wiki_pages WHERE entity=?", (ent,)).fetchone()
        if page and page["slug"] and not touchable(page_rel(page["slug"])):
            lock(con, ent)  # bloccata o riscritta a mano: da ora in poi la lascio stare
            continue
        existing = None
        if page and page["title"]:
            existing = {"title": page["title"], "descrizione": page["descrizione"] or "",
                        "sintesi": page["sintesi"] or "", "dettagli": (page["dettagli"] or "")[:MAX_DETAILS],
                        "da_verificare": jl(page["verificare"]), "alias": jl(page["alias"])}
        return {"item": {"entity": ent, "total": row["n"], "fresh": row["fresh"], "existing": existing,
                         "sources": fresh_sources(con, ent), "related": related_pages(con, ent)}}
    return {"item": None}


# ---------------------------------------------------------------- 2. scrivere la pagina

class PageIn(BaseModel):
    entity: str
    model: str
    sources: list[str]                 # id dei file usati in questo passaggio
    scarta: bool = False               # l'LLM dice che l'entità non merita una pagina
    rinvia: bool = False               # risposta illeggibile: segno le fonti come viste e vado avanti
    titolo: str = ""
    descrizione: str = ""
    tipo: str = ""
    alias: list[str] = []
    tag: list[str] = []
    sintesi: str = ""
    dettagli: str = ""
    da_verificare: list[str] = []
    collegati: list[str] = []          # entità delle pagine collegate


def mark_sources(con, entity, ids):
    now = time.time()
    with db.writing(con):
        con.executemany("INSERT OR IGNORE INTO wiki_sources(entity, id, added) VALUES(?,?,?)",
                        [(entity, i, now) for i in ids])


def all_sources(con, entity):
    return con.execute(
        "SELECT i.id, i.src, i.rel, i.name, i.year, p.summary FROM wiki_sources ws "
        "JOIN items i ON i.id=ws.id LEFT JOIN ai_profiles p ON p.id=i.id "
        "WHERE ws.entity=? ORDER BY coalesce(i.year, 0) DESC, i.name", (entity,)).fetchall()


def render(con, page, sources, related):
    fonti = [(VAULT_LABEL + "/" if s["src"] == "n" else STORAGE_LABEL + "/") + s["rel"] for s in sources]
    fm = {
        "titolo": page["title"],
        "tipo": "entita",
        "descrizione": page["descrizione"],
        "alias": page["alias"],
        "tag": page["tags"],
        "fonti": fonti,
        "aggiornato": now_local().date().isoformat(),
        "generato": "atlante",
        "modello": page["model"],
    }
    out = ["---", yaml.safe_dump(fm, allow_unicode=True, sort_keys=False, width=1000).strip(), "---", "",
           "# " + page["title"], ""]
    if page["sintesi"]:
        out += [page["sintesi"], ""]
    if page["dettagli"]:
        out += [page["dettagli"], ""]
    if page["verificare"]:
        out += ["## Da verificare", ""] + ["- " + v for v in page["verificare"]] + [""]
    if related:
        out += ["## Collegamenti", ""] + ["- [[%s|%s]]" % (r["slug"], r["title"]) for r in related] + [""]
    out += ["## Fonti", ""]
    for s in sources:
        name = s["name"].replace("|", " ").replace("]", " ")
        target = HOOKS["link_name"](con, s["id"])
        line = "- [[%s|%s]]" % (target, name) if target != name else "- [[%s]]" % target
        if s["year"]:
            line += " (%s)" % s["year"]
        if s["summary"]:
            line += " — " + one_line(s["summary"], 300)
        out.append(line)
    return "\n".join(out).rstrip() + "\n"


def save_note(con, rel, text):
    write_atomic(os.path.join(VAULT_ROOT, rel), text)
    iid, _ = HOOKS["register"](con, rel)
    HOOKS["index_note"](iid, text)
    return iid


def write_index(con):
    rows = con.execute("SELECT id, rel, name FROM items WHERE src='n' AND kind='note' AND substr(rel,1,5)='wiki/' "
                       "ORDER BY rel").fetchall()
    props = {}
    for r in con.execute("SELECT p.id, lower(p.key) AS k, p.value FROM props p JOIN items i ON i.id=p.id "
                         "WHERE i.src='n' AND substr(i.rel,1,5)='wiki/' AND p.origin='note' "
                         "AND lower(p.key) IN ('titolo','descrizione')"):
        props.setdefault(r["id"], {})[r["k"]] = r["value"]
    groups = {}
    for r in rows:
        folder = r["rel"].split("/")[1] if r["rel"].count("/") >= 2 else ""
        stem = r["name"][:-3] if r["name"].lower().endswith(".md") else r["name"]
        p = props.get(r["id"], {})
        title = (p.get("titolo") or "").strip()
        line = "- [[%s|%s]]" % (stem, title) if title and title != stem else "- [[%s]]" % stem
        if p.get("descrizione"):
            line += " — " + one_line(p["descrizione"], 200)
        groups.setdefault(folder, []).append((title.lower() or stem, line))
    n = sum(len(v) for v in groups.values())
    out = ["# Indice della wiki", "",
           "_Lo riscrive Atlante ogni volta che scrive una pagina: le modifiche a mano vanno perse._", "",
           "Aggiornato il %s · %d pagine" % (now_local().strftime("%Y-%m-%d %H:%M"), n), ""]
    known = [k for k, _ in SECTIONS]
    for key, label in list(SECTIONS) + [(k, k.capitalize() or "Altro") for k in sorted(groups) if k not in known]:
        out += ["## " + label, ""]
        out += [line for _, line in sorted(groups.get(key, []))] or ["_(ancora nessuna)_"]
        out.append("")
    save_note(con, "index.md", "\n".join(out).rstrip() + "\n")


def log(con, op, what, pages):
    p = os.path.join(VAULT_ROOT, "log.md")
    line = "- %s | %s | %s | %s\n" % (now_local().strftime("%Y-%m-%d %H:%M"), op, one_line(what, 200), pages)
    try:
        with open(p, encoding="utf-8") as f:
            text = f.read()
    except FileNotFoundError:
        text = "# Log\n\n"
    if not text.endswith("\n"):
        text += "\n"
    save_note(con, "log.md", text + line)


@router.post("/api/wiki/page")
def wiki_page(body: PageIn, con=Depends(get_con)):
    ent = body.entity
    ids = [i for i in body.sources if con.execute("SELECT 1 FROM ai_entities WHERE id=? AND entity=?",
                                                  (i, ent)).fetchone()]
    if not ids:
        raise HTTPException(400, "nessuna fonte valida per questa entità")
    if body.rinvia:
        mark_sources(con, ent, ids)
        return {"ok": True, "written": None}
    if body.scarta:
        mark_sources(con, ent, ids)
        old = con.execute("SELECT title FROM wiki_pages WHERE entity=?", (ent,)).fetchone()
        if not (old and old["title"]):  # una pagina già scritta non la cancello per un parere
            lock(con, ent)
            log(con, "scarto", "«%s»: le fonti non dicono abbastanza" % ent, "—")
        return {"ok": True, "written": None}

    page = con.execute("SELECT * FROM wiki_pages WHERE entity=?", (ent,)).fetchone()
    if page and page["locked"]:
        raise HTTPException(409, "pagina bloccata")
    slug = page["slug"] if page and page["slug"] else free_slug(con, ent)
    rel = page_rel(slug)
    if not touchable(rel):
        lock(con, ent, slug)
        raise HTTPException(409, "pagina scritta a mano o bloccata: non la tocco")

    old_related = jl(page["related"]) if page else []
    related_ents = [e for e in dict.fromkeys(old_related + [str(x) for x in body.collegati]) if e != ent]
    related = []
    for e in related_ents:
        r = con.execute("SELECT entity, slug, title FROM wiki_pages WHERE entity=? AND locked=0 AND title<>''",
                        (e,)).fetchone()
        if r:
            related.append(dict(r))
    related.sort(key=lambda r: r["title"].lower())

    tags = ["wiki"] + [t for t in (tag_for(x) for x in [body.tipo] + list(body.tag)) if t]
    data = {
        "title": one_line(body.titolo, 120) or ent.title(),
        "descrizione": one_line(body.descrizione, 200),
        "sintesi": plain(body.sintesi)[:1500],
        "dettagli": plain(body.dettagli)[:12000],
        "verificare": clean_list(body.da_verificare, 15, 300),
        "alias": [a for a in clean_list(body.alias) if a.lower() != one_line(body.titolo, 120).lower()],
        "tags": list(dict.fromkeys(tags))[:10],
        "model": body.model,
    }
    if page and page["title"]:  # aggiornamento: non perdere quello che c'era se il modello lo dimentica
        for k in ("descrizione", "sintesi"):
            data[k] = data[k] or (page[k] or "")
        old = (page["dettagli"] or "").strip()
        if old and len(data["dettagli"]) < 0.4 * len(old):
            have = {ln.strip() for ln in old.splitlines()}
            extra = [ln for ln in data["dettagli"].splitlines() if ln.strip() and ln.strip() not in have]
            data["dettagli"] = (old + ("\n" + "\n".join(extra) if extra else ""))[:12000]
        data["verificare"] = data["verificare"] or jl(page["verificare"])
        data["alias"] = list(dict.fromkeys(jl(page["alias"]) + data["alias"]))[:10]
    now = time.time()
    with db.writing(con):
        con.execute(
            "INSERT INTO wiki_pages(entity, slug, title, descrizione, sintesi, dettagli, verificare, alias, tags, "
            "related, model, created, updated, locked) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0) "
            "ON CONFLICT(entity) DO UPDATE SET slug=excluded.slug, title=excluded.title, "
            "descrizione=excluded.descrizione, sintesi=excluded.sintesi, dettagli=excluded.dettagli, "
            "verificare=excluded.verificare, alias=excluded.alias, tags=excluded.tags, related=excluded.related, "
            "model=excluded.model, updated=excluded.updated",
            (ent, slug, data["title"], data["descrizione"], data["sintesi"], data["dettagli"],
             json.dumps(data["verificare"]), json.dumps(data["alias"]), json.dumps(data["tags"]),
             json.dumps([r["entity"] for r in related]), body.model, now, now))
        con.executemany("INSERT OR IGNORE INTO wiki_sources(entity, id, added) VALUES(?,?,?)",
                        [(ent, i, now) for i in ids])

    text = render(con, data, all_sources(con, ent), related)
    save_note(con, rel, text)
    write_index(con)
    log(con, "ingest", "%s «%s» (+%d fonti)" % ("aggiornata" if page and page["title"] else "nuova pagina",
                                              data["title"], len(ids)), rel)
    HOOKS["resolve_links"]()
    return {"ok": True, "written": "n:" + rel, "title": data["title"]}


@router.get("/api/wiki/stats")
def wiki_stats(con=Depends(get_con)):
    q = lambda s, *a: con.execute(s, a).fetchone()[0]  # noqa: E731
    return {"pages": q("SELECT count(*) FROM wiki_pages WHERE locked=0 AND title<>''"),
            "locked": q("SELECT count(*) FROM wiki_pages WHERE locked=1"),
            "sources": q("SELECT count(DISTINCT id) FROM wiki_sources")}
