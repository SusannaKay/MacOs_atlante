"""Agenda: eventi (note con `tipo: evento` e `data:`) e todo delle note ("- [ ] cosa 📅 2026-10-25").

- /api/agenda?start=&end=   eventi del periodo + todo con scadenza nel periodo
- /api/tasks                todo aperte da mostrare nella lista «Da fare»
- /api/task/toggle          spunta una todo, scrivendo nella nota
- /api/event/create         nuova nota evento dal modello vault/_modelli/evento.md
- /api/task/add             todo veloce, senza evento, in vault/Da fare.md
- /api/sync/manifest        elenco dei file del vault, per la copia offline sul Mac
"""
import datetime as dt
import os
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import db, notes
from .ai import get_con
from .config import VAULT_ROOT

router = APIRouter()

# impostati da main.startup(): register(con, rel), index_note(id, text), resolve_links(), write(path, text)
HOOKS = {}

EVENT_DIR = "eventi"
TEMPLATE_REL = "_modelli/evento.md"
INBOX_REL = "Da fare.md"
INBOX_HEAD = "# Da fare\n\nTodo veloci, senza evento. Le aggiunge l'Agenda; puoi scriverle anche a mano.\n\n"
SYNC_SKIP = (".trash", ".atlante")
SKIP_PREFIXES = ("n:_modelli/", "n:.trash/", "n:wiki/")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
REL_DUE_RE = re.compile(r"📅\s*([+-]?\d{1,3})(?![\d-])")
STATI = ("idea", "in preparazione", "confermato", "fatto", "annullato")

DEFAULT_TEMPLATE = """---
tipo: evento
data: {{data}}
ora: "{{ora}}"
luogo: "{{luogo}}"
stato: idea
tag: [evento]
---

Le scadenze con 📅 -N sono calcolate da Atlante sulla data dell'evento quando lo crei.
Questo è il modello: modificalo come vuoi, i prossimi eventi useranno la versione nuova.

## Da fare

### Prima
- [ ] Definire obiettivo, pubblico e formato 📅 -21
- [ ] Prenotare la sala o lo spazio 📅 -21
- [ ] Coinvolgere relatori, staff o volontari 📅 -14
- [ ] Preparare testo e grafica della comunicazione 📅 -10
- [ ] Pubblicare su Intra, Slack e social 📅 -7
- [ ] Aprire le iscrizioni 📅 -7
- [ ] Lista dei materiali (cibo, cavi, proiettore, badge…) 📅 -5
- [ ] Comprare o recuperare i materiali 📅 -2
- [ ] Promemoria agli iscritti 📅 -1

### Il giorno
- [ ] Allestire 📅 0
- [ ] Foto e video 📅 0
- [ ] Riordinare 📅 0

### Dopo
- [ ] Post con le foto 📅 +2
- [ ] Ringraziamenti e richiesta di feedback 📅 +3
- [ ] Cosa è andato bene, cosa migliorare 📅 +3

## Note

"""


def skip(iid):
    return iid.startswith(SKIP_PREFIXES)


def parse_date(s):
    s = (s or "").strip()[:10]
    if not DATE_RE.match(s):
        return None
    try:
        return dt.date.fromisoformat(s)
    except ValueError:
        return None


def note_title(rel):
    name = rel.rsplit("/", 1)[-1]
    name = name[:-3] if name.lower().endswith(".md") else name
    return re.sub(r"^\d{4}-\d{2}-\d{2}\s+", "", name) or name  # "2026-10-31 Festa" -> "Festa"


def all_events(con):
    """{id: evento} per tutte le note con tipo: evento e una data valida."""
    rows = con.execute(
        "SELECT p.id, lower(p.key) AS k, p.value FROM props p "
        "WHERE p.origin='note' AND p.id IN (SELECT id FROM props WHERE origin='note' AND lower(key)='tipo' "
        "AND lower(trim(value))='evento') AND lower(p.key) IN ('data','ora','luogo','stato','titolo')").fetchall()
    ev = {}
    for r in rows:
        if skip(r["id"]):
            continue
        ev.setdefault(r["id"], {})[r["k"]] = r["value"]
    out = {}
    for iid, p in ev.items():
        d = parse_date(p.get("data"))
        if not d:
            continue
        rel = iid[2:]
        out[iid] = {"id": iid, "title": (p.get("titolo") or "").strip() or note_title(rel), "date": d.isoformat(),
                    "ora": (p.get("ora") or "").strip(), "luogo": (p.get("luogo") or "").strip(),
                    "stato": (p.get("stato") or "").strip().lower(), "done": 0, "total": 0}
    if out:
        q = ",".join("?" * len(out))
        for r in con.execute("SELECT id, count(*) AS n, sum(done) AS d FROM tasks WHERE id IN (%s) GROUP BY id" % q,
                             list(out)):
            out[r["id"]]["total"] = r["n"]
            out[r["id"]]["done"] = r["d"] or 0
    return out


def task_rows(con, events, where, args):
    rows = con.execute("SELECT t.id, t.line, t.text, t.done, t.due, i.rel FROM tasks t JOIN items i ON i.id=t.id "
                       "WHERE " + where, args).fetchall()
    out = []
    for r in rows:
        if skip(r["id"]):
            continue
        ev = events.get(r["id"])
        due = r["due"] or (ev["date"] if ev else None)  # nelle note evento, senza 📅 vale la data dell'evento
        out.append({"id": r["id"], "line": r["line"], "text": r["text"], "done": bool(r["done"]), "due": due,
                    "explicit_due": bool(r["due"]), "note": ev["title"] if ev else note_title(r["rel"]),
                    "event": bool(ev), "event_date": ev["date"] if ev else None})
    return out


@router.get("/api/agenda")
def agenda(start: str, end: str, con=Depends(get_con)):
    a, b = parse_date(start), parse_date(end)
    if not a or not b or b < a or (b - a).days > 400:
        raise HTTPException(400, "intervallo di date non valido")
    events = all_events(con)
    in_range = [e for e in events.values() if a.isoformat() <= e["date"] <= b.isoformat()]
    tasks = [t for t in task_rows(con, events, "t.due IS NOT NULL OR t.id IN (%s)" % ",".join("?" * len(events))
                                  if events else "t.due IS NOT NULL", list(events))
             if t["due"] and a.isoformat() <= t["due"] <= b.isoformat()]
    in_range.sort(key=lambda e: (e["date"], e["ora"], e["title"].lower()))
    tasks.sort(key=lambda t: (t["due"], t["done"], t["note"].lower(), t["line"]))
    return {"events": in_range, "tasks": tasks}


@router.get("/api/tasks")
def open_tasks(done: bool = False, con=Depends(get_con)):
    """Todo da fare: tutte quelle con una scadenza e tutte quelle delle note evento."""
    events = all_events(con)
    where = "(t.due IS NOT NULL%s)" % (" OR t.id IN (%s)" % ",".join("?" * len(events)) if events else "")
    if not done:
        where += " AND t.done=0"
    items = [t for t in task_rows(con, events, where, list(events)) if t["due"]]
    items.sort(key=lambda t: (t["due"], t["note"].lower(), t["line"]))
    return {"items": items, "today": dt.date.today().isoformat()}


class Toggle(BaseModel):
    id: str
    line: int
    done: bool
    text: str = ""  # per controllare che la riga sia ancora quella giusta


@router.post("/api/task/toggle")
def toggle(body: Toggle, con=Depends(get_con)):
    if not body.id.startswith("n:"):
        raise HTTPException(400, "solo le note del vault hanno todo")
    p = os.path.join(VAULT_ROOT, body.id[2:])
    try:
        with open(p, encoding="utf-8") as f:
            text = f.read()
    except FileNotFoundError:
        raise HTTPException(404, "nota non trovata")
    line = body.line
    if body.text:  # se la nota è cambiata e la todo si è spostata, la ritrovo dal testo
        found = [ln for ln, _d, t, _due in notes.parse_tasks(text) if t == body.text]
        if found and line not in found:
            line = min(found, key=lambda x: abs(x - line))
        elif not found:
            raise HTTPException(409, "la todo è cambiata nella nota: ricarica l'agenda")
    new = notes.toggle_task(text, line, body.done)
    if new is None:
        raise HTTPException(409, "la todo non è più in quella riga: ricarica l'agenda")
    HOOKS["write"](p, new)
    HOOKS["register"](con, body.id[2:])
    HOOKS["index_note"](body.id, new)
    return {"ok": True, "mtime": os.stat(p).st_mtime}


class EventIn(BaseModel):
    name: str
    date: str
    ora: str = ""
    luogo: str = ""


def template_text():
    p = os.path.join(VAULT_ROOT, TEMPLATE_REL)
    try:
        with open(p, encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        HOOKS["write"](p, DEFAULT_TEMPLATE)
        return DEFAULT_TEMPLATE


def fill(template, name, date, ora, luogo):
    def rel_due(m):
        return "📅 " + (date + dt.timedelta(days=int(m.group(1)))).isoformat()

    t = template.replace("{{titolo}}", name).replace("{{data}}", date.isoformat())
    t = t.replace("{{ora}}", ora).replace("{{luogo}}", luogo.replace('"', "'"))
    t = re.sub(r'^(ora|luogo): ""\s*\n', "", t, flags=re.M)  # campi lasciati vuoti
    t = re.sub(r"^Le scadenze con 📅 -N.*\n(Questo è il modello.*\n)?\n?", "", t, flags=re.M)
    lines = []
    for line in t.split("\n"):  # le scadenze relative solo nelle righe delle todo
        lines.append(REL_DUE_RE.sub(rel_due, line) if notes.TASK_RE.match(line) else line)
    return "\n".join(lines)


@router.post("/api/event/create")
def event_create(body: EventIn, con=Depends(get_con)):
    d = parse_date(body.date)
    if not d:
        raise HTTPException(400, "data non valida")
    name = re.sub(r'[\\/:*?"<>|#^\[\]]', " ", body.name).strip() or "Evento"
    ora = body.ora.strip()
    if ora and not re.match(r"^\d{1,2}[:.]\d{2}$", ora):
        raise HTTPException(400, "ora non valida (es. 19:00)")
    base = "%s/%s %s" % (EVENT_DIR, d.isoformat(), name)
    rel, n = base + ".md", 1
    while os.path.exists(os.path.join(VAULT_ROOT, rel)):
        n += 1
        rel = "%s %d.md" % (base, n)
    text = fill(template_text(), name, d, ora.replace(".", ":"), body.luogo.strip())
    HOOKS["write"](os.path.join(VAULT_ROOT, rel), text)
    iid, _ = HOOKS["register"](con, rel)
    HOOKS["index_note"](iid, text)
    HOOKS["resolve_links"]()
    return {"id": iid}


class TaskIn(BaseModel):
    text: str
    due: str = ""


def append_task(text, line):
    """Aggiunge la riga in fondo a Da fare.md (creandolo se serve) e restituisce il testo nuovo."""
    if not text.strip():
        text = INBOX_HEAD
    if not text.endswith("\n"):
        text += "\n"
    return text + line + "\n"


def task_line(body: TaskIn):
    t = re.sub(r"\s+", " ", body.text).strip()
    if not t:
        raise HTTPException(400, "scrivi cosa c'è da fare")
    t = notes.DUE_RE.sub("", t).strip()
    due = ""
    if body.due:
        d = parse_date(body.due)
        if not d:
            raise HTTPException(400, "data non valida")
        due = " 📅 " + d.isoformat()
    return "- [ ] " + t[:400] + due


@router.post("/api/task/add")
def task_add(body: TaskIn, con=Depends(get_con)):
    line = task_line(body)
    p = os.path.join(VAULT_ROOT, INBOX_REL)
    try:
        with open(p, encoding="utf-8") as f:
            text = f.read()
    except FileNotFoundError:
        text = ""
    new = append_task(text, line)
    HOOKS["write"](p, new)
    iid, _ = HOOKS["register"](con, INBOX_REL)
    HOOKS["index_note"](iid, new)
    return {"id": iid, "mtime": os.stat(p).st_mtime}


@router.get("/api/sync/manifest")
def manifest():
    """Tutti i file del vault con data di modifica e dimensione (per la copia offline sul Mac)."""
    out = []
    for root, dirs, files in os.walk(VAULT_ROOT):
        rel_root = os.path.relpath(root, VAULT_ROOT)
        rel_root = "" if rel_root == "." else rel_root.replace(os.sep, "/")
        dirs[:] = [d for d in dirs if not (rel_root == "" and d in SYNC_SKIP) and not d.startswith(".")]
        for f in files:
            if f.startswith(".") or f.endswith(".atlante-tmp"):
                continue
            rel = (rel_root + "/" if rel_root else "") + f
            try:
                st = os.stat(os.path.join(root, f))
            except OSError:
                continue
            out.append({"rel": rel, "mtime": st.st_mtime, "size": st.st_size})
    return {"files": out}


def reindex_tasks_once(index_note):
    """Prima volta con l'agenda: rilegge tutte le note per trovare le todo già scritte."""
    con = db.connect()
    try:
        if db.get_state(con, "tasks_v1"):
            return
        ids = [r[0] for r in con.execute("SELECT id FROM items WHERE src='n' AND kind='note'")]
        for iid in ids:
            index_note(iid)
        with db.writing(con):
            db.set_state(con, "tasks_v1", "1")
    finally:
        con.close()
