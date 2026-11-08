"""Wiki, seconda parte: le domande (wiki/risposte) e i temi (wiki/temi).

Come per le entità, il motore non chiama nessun modello: prepara il materiale e scrive i file,
l'LLM gira sul Mac.

Domande
  1. /api/wiki/ask/candidates?q=  pagine della wiki e file che c'entrano con la domanda
  2. l'app fa scegliere all'LLM le pagine utili, poi /api/wiki/ask/pages?ids= ne dà il testo
  3. l'LLM risponde e /api/wiki/answer salva la risposta in wiki/risposte/, con le fonti

Temi
  1. /api/wiki/theme/next  un gruppo di entità che compaiono spesso negli stessi file
  2. l'LLM dice se formano un tema, come chiamarlo e quali ne fanno parte
  3. /api/wiki/theme       scrive wiki/temi/<slug>.md con i link alle pagine
"""
import json
import os
import re
import time

import yaml
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import db, notes
from .ai import get_con, is_generated
from .config import VAULT_ROOT
from .wiki import HOOKS, jl, log, now_local, one_line, plain, rerender, save_note, slug_for, touchable, write_index

router = APIRouter()

ANS_DIR = "wiki/risposte"
THEME_DIR = "wiki/temi"
MIN_PAGES_FOR_THEMES = 15   # sotto questo numero di pagine i temi non hanno senso
THEME_NEIGHBOURS = 14       # entità vicine proposte all'LLM per un tema
STOP = set("""il lo la i gli le un uno una di a da in con su per tra fra e o ma se che chi cosa come quando dove
perché perche quale quali quanto quanti del dello della dei degli delle al allo alla ai agli alle dal dallo dalla dai
dagli dalle nel nello nella nei negli nelle sul sullo sulla sui sugli sulle è e' sono ho hai ha abbiamo hanno mi ti
ci vi si mio mia miei mie tuo tua suo sua nostro questo questa questi queste quello quella non più piu anche già gia
fatto fare stato stata cos cosa successo detto ecco""".split())


def words(q: str):
    out = []
    for w in re.findall(r"[\w'\-]+", q.lower(), re.U):
        w = w.strip("'-")
        if len(w) >= 3 and w not in STOP and w not in out:
            out.append(w)
    return out[:10]


def fts(q: str):
    ws = words(q)
    return " OR ".join('"%s"*' % w.replace('"', "") for w in ws) if ws else None


def page_props(con, ids):
    out = {}
    if not ids:
        return out
    q = ",".join("?" * len(ids))
    for r in con.execute("SELECT id, lower(key) AS k, value FROM props WHERE origin='note' AND id IN (%s) "
                         "AND lower(key) IN ('titolo','descrizione','tipo')" % q, list(ids)):
        out.setdefault(r["id"], {})[r["k"]] = r["value"]
    return out


def stem_of(rel):
    name = rel.rsplit("/", 1)[-1]
    return name[:-3] if name.lower().endswith(".md") else name


# ---------------------------------------------------------------- domande

@router.get("/api/wiki/ask/candidates")
def ask_candidates(q: str, con=Depends(get_con)):
    """Pagine della wiki (entità e temi) e file dell'archivio che probabilmente c'entrano."""
    match = fts(q)
    page_ids, file_ids = [], []
    if match:
        try:
            for r in con.execute("SELECT id FROM items_fts WHERE items_fts MATCH ? ORDER BY rank LIMIT 300", (match,)):
                iid = r[0]
                if iid.startswith(("n:wiki/entita/", "n:wiki/temi/")):
                    if len(page_ids) < 30:
                        page_ids.append(iid)
                elif not is_generated(iid) and len(file_ids) < 8:
                    file_ids.append(iid)
        except Exception:  # noqa: BLE001  (query FTS non valida)
            pass
    if len(page_ids) < 8:  # poche corrispondenze: aggiungo le pagine più ricche
        for r in con.execute("SELECT 'n:wiki/entita/' || w.slug || '.md' AS id, count(ws.id) AS n FROM wiki_pages w "
                             "JOIN wiki_sources ws ON ws.entity=w.entity WHERE w.locked=0 AND w.title<>'' "
                             "GROUP BY w.entity ORDER BY n DESC LIMIT 20"):
            if r["id"] not in page_ids and len(page_ids) < 20:
                page_ids.append(r["id"])
    page_ids = [i for i in page_ids if con.execute("SELECT 1 FROM items WHERE id=?", (i,)).fetchone()]
    props = page_props(con, page_ids)
    pages = [{"id": i, "title": (props.get(i, {}).get("titolo") or stem_of(i)).strip(),
              "descrizione": one_line(props.get(i, {}).get("descrizione") or "", 160),
              "tipo": "tema" if i.startswith("n:wiki/temi/") else "entita"} for i in page_ids]
    files = []
    for i in file_ids:
        r = con.execute("SELECT i.id, i.name, i.rel, i.src, i.year, p.summary FROM items i LEFT JOIN ai_profiles p ON p.id=i.id "
                        "WHERE i.id=? AND i.is_dir=0", (i,)).fetchone()
        if r:
            files.append({"id": r["id"], "name": r["name"], "path": ("Note/" if r["src"] == "n" else "") + r["rel"],
                          "year": r["year"], "summary": one_line(r["summary"] or "", 300)})
    return {"pages": pages, "files": files}


@router.get("/api/wiki/ask/pages")
def ask_pages(ids: str, con=Depends(get_con)):
    out = []
    for iid in [i for i in ids.split("|") if i][:8]:
        if not iid.startswith("n:wiki/"):
            continue
        try:
            with open(os.path.join(VAULT_ROOT, iid[2:]), encoding="utf-8", errors="replace") as f:
                fm, body = notes.split_frontmatter(f.read())
        except OSError:
            continue
        body = re.sub(r"!?\[\[(?:[^\]|]*\|)?([^\]]*)\]\]", r"\1", body)  # i link come testo semplice
        out.append({"id": iid, "title": str(fm.get("titolo") or stem_of(iid)), "text": body.strip()[:3500]})
    return {"pages": out}


class AnswerIn(BaseModel):
    question: str
    answer: str
    pages: list[str] = []
    files: list[str] = []
    model: str = ""


@router.post("/api/wiki/answer")
def answer(body: AnswerIn, con=Depends(get_con)):
    q = re.sub(r"\s+", " ", body.question).strip()
    text = plain(body.answer)
    if not q or not text:
        raise HTTPException(400, "domanda o risposta vuota")
    day = now_local().date().isoformat()
    name = re.sub(r'[\\/:*?"<>|#^\[\]]', " ", q).strip().rstrip("?.! ")[:70].strip() or "Domanda"
    base = "%s/%s %s" % (ANS_DIR, day, name)
    rel, n = base + ".md", 1
    while os.path.exists(os.path.join(VAULT_ROOT, rel)):
        n += 1
        rel = "%s %d.md" % (base, n)
    lines = [ln for ln in text.split("\n") if ln.strip() and not ln.lstrip().startswith("#")]
    first = re.split(r"(?<=[.!?])\s", re.sub(r"[*_>`]|^\s*[-+]\s", "", " ".join(lines[:3])).strip(), maxsplit=1)[0]
    fm = {"titolo": q, "tipo": "risposta", "domanda": q, "descrizione": one_line(first, 160), "data": day,
          "tag": ["wiki", "risposta"], "generato": "atlante", "modello": body.model}
    out = ["---", yaml.safe_dump(fm, allow_unicode=True, sort_keys=False, width=1000).strip(), "---", "",
           "# " + q, "", text, ""]
    pages = [p for p in dict.fromkeys(body.pages) if p.startswith("n:wiki/")]
    props = page_props(con, pages)
    if pages:
        out += ["## Pagine della wiki", ""]
        out += ["- [[%s|%s]]" % (stem_of(p), (props.get(p, {}).get("titolo") or stem_of(p)).strip()) for p in pages]
        out.append("")
    files = [f for f in dict.fromkeys(body.files) if con.execute("SELECT 1 FROM items WHERE id=?", (f,)).fetchone()]
    if files:
        out += ["## File", ""]
        for f in files:
            name = con.execute("SELECT name FROM items WHERE id=?", (f,)).fetchone()[0].replace("|", " ").replace("]", " ")
            target = HOOKS["link_name"](con, f)
            out.append("- [[%s|%s]]" % (target, name) if target != name else "- [[%s]]" % target)
        out.append("")
    iid = save_note(con, rel, "\n".join(out).rstrip() + "\n")
    write_index(con)
    log(con, "domanda", q, rel)
    HOOKS["resolve_links"]()
    return {"id": iid}


# ---------------------------------------------------------------- temi

def theme_rel(slug):
    return "%s/%s.md" % (THEME_DIR, slug)


def live_pages(con):
    return con.execute("SELECT count(*) FROM wiki_pages WHERE locked=0 AND title<>''").fetchone()[0]


@router.get("/api/wiki/theme/next")
def theme_next(con=Depends(get_con)):
    if live_pages(con) < MIN_PAGES_FOR_THEMES:
        return {"item": None}
    seeds = con.execute(
        "SELECT w.entity, w.title FROM wiki_pages w JOIN wiki_sources ws ON ws.entity=w.entity "
        "LEFT JOIN wiki_theme_seen s ON s.entity=w.entity "
        "WHERE w.locked=0 AND w.title<>'' AND s.entity IS NULL GROUP BY w.entity ORDER BY count(ws.id) DESC LIMIT 25").fetchall()
    for seed in seeds:
        rows = con.execute(
            "SELECT w.entity, w.title, w.descrizione, w.sintesi, count(*) AS c FROM ai_entities e1 "
            "JOIN ai_entities e2 ON e2.id=e1.id AND e2.entity<>e1.entity "
            "JOIN wiki_pages w ON w.entity=e2.entity AND w.locked=0 AND w.title<>'' "
            "WHERE e1.entity=? GROUP BY w.entity HAVING c>=2 ORDER BY c DESC LIMIT ?",
            (seed["entity"], THEME_NEIGHBOURS)).fetchall()
        if len(rows) < 3:  # troppo isolata per fare da centro a un tema
            with db.writing(con):
                con.execute("INSERT OR IGNORE INTO wiki_theme_seen(entity, at) VALUES(?,?)", (seed["entity"], time.time()))
            continue
        me = con.execute("SELECT entity, title, descrizione, sintesi FROM wiki_pages WHERE entity=?", (seed["entity"],)).fetchone()
        members = [dict(me)] + [dict(r) for r in rows]
        themes = [{"slug": r["slug"], "title": r["title"], "descrizione": r["descrizione"] or ""}
                  for r in con.execute("SELECT slug, title, descrizione FROM wiki_themes WHERE locked=0 ORDER BY title")]
        return {"item": {"seed": seed["entity"], "members": [
            {"entity": m["entity"], "title": m["title"], "descrizione": one_line(m["descrizione"] or "", 160),
             "sintesi": one_line(m["sintesi"] or "", 300)} for m in members], "themes": themes}}
    return {"item": None}


class ThemeIn(BaseModel):
    seed: str
    model: str = ""
    scarta: bool = False
    esistente: str = ""          # slug di un tema già scritto a cui aggiungere i membri
    titolo: str = ""
    descrizione: str = ""
    sintesi: str = ""
    membri: list[str] = []       # entità


def render_theme(con, t, members):
    pages = []
    for e in members:
        r = con.execute("SELECT slug, title, descrizione FROM wiki_pages WHERE entity=? AND locked=0 AND title<>''", (e,)).fetchone()
        if r:
            pages.append(r)
    pages.sort(key=lambda r: r["title"].lower())
    fm = {"titolo": t["title"], "tipo": "tema", "descrizione": t["descrizione"], "tag": ["wiki", "tema"],
          "aggiornato": now_local().date().isoformat(), "generato": "atlante", "modello": t["model"]}
    out = ["---", yaml.safe_dump(fm, allow_unicode=True, sort_keys=False, width=1000).strip(), "---", "",
           "# " + t["title"], ""]
    if t["sintesi"]:
        out += [t["sintesi"], ""]
    out += ["## Pagine", ""]
    out += ["- [[%s|%s]]%s" % (r["slug"], r["title"], (" — " + one_line(r["descrizione"], 160)) if r["descrizione"] else "")
            for r in pages]
    return "\n".join(out).rstrip() + "\n"


@router.post("/api/wiki/theme")
def theme_save(body: ThemeIn, con=Depends(get_con)):
    now = time.time()
    known = {r[0] for r in con.execute("SELECT entity FROM wiki_pages WHERE locked=0 AND title<>''")}
    members = [m for m in dict.fromkeys([body.seed] + list(body.membri)) if m in known]
    with db.writing(con):  # il centro non riparte più, e nemmeno chi è finito in un tema
        con.executemany("INSERT OR IGNORE INTO wiki_theme_seen(entity, at) VALUES(?,?)",
                        [(e, now) for e in ([body.seed] + (members if not body.scarta else []))])
    if body.scarta or len(members) < 3:
        return {"ok": True, "written": None}

    old = None
    if body.esistente:
        old = con.execute("SELECT * FROM wiki_themes WHERE slug=? AND locked=0", (body.esistente,)).fetchone()
    if old:
        slug = old["slug"]
        members = list(dict.fromkeys(jl(old["members"]) + members))
        t = {"title": old["title"], "descrizione": old["descrizione"] or "", "sintesi": old["sintesi"] or "", "model": old["model"]}
    else:
        title = one_line(body.titolo, 80)
        if not title:
            return {"ok": True, "written": None}
        base = slug_for(title)
        slug, n = base, 1
        while con.execute("SELECT 1 FROM wiki_themes WHERE slug=?", (slug,)).fetchone() or not touchable(theme_rel(slug)):
            n += 1
            slug = "%s-%d" % (base, n)
        t = {"title": title, "descrizione": one_line(body.descrizione, 200), "sintesi": plain(body.sintesi)[:1500],
             "model": body.model}
    if not touchable(theme_rel(slug)):
        with db.writing(con):
            con.execute("UPDATE wiki_themes SET locked=1 WHERE slug=?", (slug,))
        return {"ok": True, "written": None}
    with db.writing(con):
        con.execute(
            "INSERT INTO wiki_themes(slug, title, descrizione, sintesi, members, model, created, updated, locked) "
            "VALUES(?,?,?,?,?,?,?,?,0) ON CONFLICT(slug) DO UPDATE SET members=excluded.members, updated=excluded.updated",
            (slug, t["title"], t["descrizione"], t["sintesi"], json.dumps(members), t["model"], now, now))
    rel = theme_rel(slug)
    save_note(con, rel, render_theme(con, t, members))
    for m in members:  # ogni pagina del tema mostra il tema nella sezione «Temi»
        rerender(con, m)
    write_index(con)
    log(con, "tema", "%s «%s» (%d pagine)" % ("aggiornato" if old else "nuovo tema", t["title"], len(members)), rel)
    HOOKS["resolve_links"]()
    return {"ok": True, "written": "n:" + rel, "title": t["title"]}
