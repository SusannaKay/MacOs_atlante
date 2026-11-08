"""Wiki, seconda parte: le domande (wiki/risposte).

Come per le entità, il motore non chiama nessun modello: prepara il materiale e scrive i file,
l'LLM gira sul Mac.

Domande
  1. /api/wiki/ask/candidates?q=  pagine della wiki e file che c'entrano con la domanda
  2. l'app fa scegliere all'LLM le pagine utili, poi /api/wiki/ask/pages?ids= ne dà il testo
  3. l'LLM risponde e /api/wiki/answer salva la risposta in wiki/risposte/, con le fonti

"""
import os
import re

import yaml
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import notes
from .ai import get_con, is_generated
from .config import VAULT_ROOT
from .wiki import HOOKS, log, now_local, one_line, plain, save_note, write_index

router = APIRouter()

ANS_DIR = "wiki/risposte"
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
