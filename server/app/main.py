"""Atlante — il motore sul server. API usata dall'app per Mac."""
import hashlib
import hmac
import logging
import os
import re
import subprocess
import time
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel

from . import ai, db, notes, wiki
from .config import CFG, DATA_DIR, TOKEN, VAULT_ROOT
from .indexer import Indexer, abs_path, item_id, kind_for, parent_of, recompute_year, split_name

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("atlante")

VERSION = "1.3.0"


@asynccontextmanager
async def lifespan(_app):
    startup()
    yield


app = FastAPI(title="Atlante", version=VERSION, lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.include_router(ai.router)
app.include_router(wiki.router)

INDEXER: Indexer | None = None
THUMB_DIR = os.path.join(DATA_DIR, "thumbs")


def startup():
    global INDEXER
    if not TOKEN or len(TOKEN) < 16:
        raise RuntimeError("ATLANTE_TOKEN mancante o troppo corto (minimo 16 caratteri)")
    db.init()
    os.makedirs(THUMB_DIR, exist_ok=True)
    os.makedirs(VAULT_ROOT, exist_ok=True)
    INDEXER = Indexer()
    INDEXER.start()
    wiki.HOOKS.update(register=register_vault_file, index_note=INDEXER.index_note,
                      resolve_links=INDEXER.resolve_links, link_name=link_name_for)


@app.middleware("http")
async def auth(request: Request, call_next):
    if request.method == "OPTIONS" or request.url.path == "/api/health":
        return await call_next(request)
    given = ""
    h = request.headers.get("authorization", "")
    if h.lower().startswith("bearer "):
        given = h[7:].strip()
    else:
        given = request.query_params.get("token", "")
    if not TOKEN or not hmac.compare_digest(given.encode(), TOKEN.encode()):
        return JSONResponse({"detail": "token non valido"}, status_code=401)
    return await call_next(request)


def get_con():
    con = db.connect()
    try:
        yield con
    finally:
        con.close()


# ---------------------------------------------------------------- helper

ITEM_COLS = "id, src, rel, name, parent, is_dir, ext, kind, size, mtime, year, year_src"


def row_item(r):
    d = dict(r)
    d["is_dir"] = bool(d.get("is_dir"))
    return d


def get_item(con, iid):
    r = con.execute("SELECT %s FROM items WHERE id=?" % ITEM_COLS, (iid,)).fetchone()
    if not r:
        raise HTTPException(404, "elemento non trovato")
    return r


def tags_of(con, iid):
    return [{"tag": r["tag"], "origin": r["origin"]} for r in
            con.execute("SELECT tag, origin FROM tags WHERE id=? ORDER BY tag", (iid,))]


def props_of(con, iid):
    return [{"key": r["key"], "value": r["value"], "origin": r["origin"]} for r in
            con.execute("SELECT key, value, origin FROM props WHERE id=? ORDER BY origin, key", (iid,))]


def fts_query(q: str):
    toks = [t for t in re.findall(r"[\w\-]+", q, re.U) if t]
    if not toks:
        return None
    return " ".join('"%s"*' % t.replace('"', "") for t in toks)


# ---------------------------------------------------------------- stato

@app.get("/api/health")
def health():
    return {"ok": True, "version": VERSION}


@app.get("/api/status")
def status(con=Depends(get_con)):
    counts = {r["src"]: r["n"] for r in con.execute("SELECT src, count(*) n FROM items GROUP BY src")}
    pending = con.execute("SELECT count(*) FROM items WHERE enriched=0 AND is_dir=0 "
                          "AND kind IN ('pdf','image','text','markdown')").fetchone()[0]
    return {"version": VERSION, "items": counts, "pending_enrich": pending, **(INDEXER.status if INDEXER else {})}


@app.post("/api/rescan")
def rescan():
    INDEXER.request_rescan()
    return {"ok": True}


# ---------------------------------------------------------------- navigazione

@app.get("/api/tree")
def tree(id: str = Query("s:"), con=Depends(get_con)):
    rows = con.execute(
        "SELECT %s, (SELECT count(*) FROM items c WHERE c.parent=items.id) AS children FROM items "
        "WHERE parent=? ORDER BY is_dir DESC, name COLLATE NOCASE" % ITEM_COLS, (id,)).fetchall()
    return [row_item(r) for r in rows]


@app.get("/api/item")
def item(id: str, con=Depends(get_con)):
    it = row_item(get_item(con, id))
    it["tags"] = tags_of(con, id)
    it["props"] = props_of(con, id)
    it["bookmarked"] = con.execute("SELECT 1 FROM bookmarks WHERE id=?", (id,)).fetchone() is not None
    it["outgoing"] = [dict(r) for r in con.execute(
        "SELECT l.target_raw, l.target_id, l.kind, i.name, i.kind AS target_kind FROM links l "
        "LEFT JOIN items i ON i.id=l.target_id WHERE l.src=? ORDER BY l.rowid", (id,))]
    it["backlinks"] = [dict(r) for r in con.execute(
        "SELECT DISTINCT l.src AS id, i.name, i.kind FROM links l JOIN items i ON i.id=l.src "
        "WHERE l.target_id=? ORDER BY i.name COLLATE NOCASE", (id,))]
    it.update(ai.item_extras(con, id))
    return it


@app.get("/api/quick")
def quick(q: str = "", limit: int = 30, con=Depends(get_con)):
    """Ricerca veloce per nome (⌘O): note prima, poi file del server."""
    q = q.strip().lower()
    if not q:
        rows = con.execute("SELECT %s FROM items WHERE kind='note' ORDER BY mtime DESC LIMIT ?" % ITEM_COLS,
                           (limit,)).fetchall()
        return [row_item(r) for r in rows]
    like = "%" + q.replace("%", "").replace("_", "\\_") + "%"
    rows = con.execute(
        "SELECT %s FROM items WHERE lower(name) LIKE ? ESCAPE '\\' "
        "ORDER BY (kind='note') DESC, (lower(name) LIKE ? ESCAPE '\\') DESC, is_dir, length(name) LIMIT ?"
        % ITEM_COLS, (like, q + "%", limit)).fetchall()
    return [row_item(r) for r in rows]


@app.get("/api/search")
def search(q: str = "", kind: str = "", tag: str = "", year: int | None = None, src: str = "",
           under: str = "", prop: str = "", limit: int = 100, offset: int = 0, con=Depends(get_con)):
    """Ricerca nel testo + filtri (tipo, tag, anno, cartella, proprietà chiave=valore)."""
    where, args = ["i.is_dir=0"], []
    join = ""
    fq = fts_query(q) if q else None
    if q and not fq:
        return {"results": [], "total": 0}
    if fq:
        join = "JOIN items_fts f ON f.id=i.id"
        where.append("items_fts MATCH ?")
        args.append(fq)
    if kind:
        ks = kind.split(",")
        where.append("i.kind IN (%s)" % ",".join("?" * len(ks)))
        args += ks
    if tag:
        for t in tag.lower().split(","):
            where.append("EXISTS (SELECT 1 FROM tags t WHERE t.id=i.id AND (t.tag=? OR t.tag LIKE ?))")
            args += [t.lstrip("#"), t.lstrip("#") + "/%"]
    if year is not None:
        where.append("i.year=?")
        args.append(year)
    if src in ("s", "n"):
        where.append("i.src=?")
        args.append(src)
    if under:
        where.append("i.id LIKE ? ESCAPE '\\'")
        args.append(under.rstrip("/").replace("%", "\\%").replace("_", "\\_") + "/%")
    if prop:
        k, _, v = prop.partition("=")
        if v:
            where.append("EXISTS (SELECT 1 FROM props p WHERE p.id=i.id AND lower(p.key)=lower(?) AND p.value LIKE ?)")
            args += [k, "%" + v + "%"]
        else:
            where.append("EXISTS (SELECT 1 FROM props p WHERE p.id=i.id AND lower(p.key)=lower(?))")
            args.append(k)
    w = " AND ".join(where)
    cols = ", ".join("i." + c.strip() for c in ITEM_COLS.split(","))
    if fq:
        sel = "SELECT %s, snippet(items_fts, 3, '«', '»', '…', 12) AS snippet FROM items i %s WHERE %s " \
              "ORDER BY bm25(items_fts, 0, 8.0, 2.0, 1.0) LIMIT ? OFFSET ?" % (cols, join, w)
    else:
        sel = "SELECT %s, NULL AS snippet FROM items i WHERE %s ORDER BY i.mtime DESC LIMIT ? OFFSET ?" % (cols, w)
    rows = con.execute(sel, args + [limit, offset]).fetchall()
    total = con.execute("SELECT count(*) FROM items i %s WHERE %s" % (join, w), args).fetchone()[0]
    return {"results": [row_item(r) for r in rows], "total": total}


@app.get("/api/unlinked")
def unlinked(id: str, con=Depends(get_con)):
    """Note che nominano questo elemento senza linkarlo."""
    it = get_item(con, id)
    stem = it["name"].rsplit(".", 1)[0] if not it["is_dir"] else it["name"]
    toks = re.findall(r"[\w\-]+", stem, re.U)
    if not toks or len(stem) < 3:
        return []
    phrase = '"%s"' % " ".join(toks)
    rows = con.execute(
        "SELECT i.id, i.name, snippet(items_fts, 3, '«', '»', '…', 12) AS snippet FROM items_fts f "
        "JOIN items i ON i.id=f.id WHERE items_fts MATCH ? AND i.kind='note' AND i.id<>? "
        "AND NOT EXISTS (SELECT 1 FROM links l WHERE l.src=i.id AND l.target_id=?) LIMIT 50",
        ("body:" + phrase, id, id)).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------- file

@app.get("/api/raw")
def raw(id: str):
    try:
        p = abs_path(id)
    except ValueError:
        raise HTTPException(400, "id non valido")
    if not os.path.isfile(p):
        raise HTTPException(404, "file non trovato")
    return FileResponse(p, filename=os.path.basename(p), content_disposition_type="inline")


IMG_THUMB = {"jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff"}


@app.get("/api/thumb")
def thumb(id: str, size: int = 320, con=Depends(get_con)):
    it = get_item(con, id)
    size = max(64, min(size, 800))
    key = hashlib.sha1(("%s|%s|%s" % (id, it["mtime"], size)).encode()).hexdigest()
    out = os.path.join(THUMB_DIR, key[:2], key + ".webp")
    if not os.path.exists(out):
        os.makedirs(os.path.dirname(out), exist_ok=True)
        p = abs_path(id)
        try:
            from PIL import Image
            if it["ext"] in IMG_THUMB:
                with Image.open(p) as im:
                    im.thumbnail((size, size))
                    im.convert("RGB").save(out, "WEBP", quality=80)
            elif it["kind"] == "pdf":
                tmp = out + ".tmp"
                subprocess.run(["pdftoppm", "-f", "1", "-l", "1", "-singlefile", "-scale-to", str(size),
                                "-png", p, tmp], capture_output=True, timeout=60, check=True)
                with Image.open(tmp + ".png") as im:
                    im.convert("RGB").save(out, "WEBP", quality=80)
                os.remove(tmp + ".png")
            else:
                raise HTTPException(404, "nessuna anteprima per questo tipo")
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(404, "anteprima non disponibile")
    return FileResponse(out, media_type="image/webp", headers={"Cache-Control": "max-age=86400"})


# ---------------------------------------------------------------- note (vault)

class NoteSave(BaseModel):
    id: str
    text: str
    base_mtime: float | None = None


class NoteCreate(BaseModel):
    folder: str = ""
    name: str = "Senza titolo"
    text: str = ""


class Rename(BaseModel):
    id: str
    new_rel: str


class IdOnly(BaseModel):
    id: str


def vault_id_check(iid):
    if not iid.startswith("n:"):
        raise HTTPException(400, "si possono modificare solo le note del vault: i file del server sono in sola lettura")


def write_atomic(path, text):
    tmp = path + ".atlante-tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def register_vault_file(con, rel):
    """Aggiunge/aggiorna subito un file del vault nell'indice (senza aspettare la scansione)."""
    p = os.path.join(VAULT_ROOT, rel)
    st = os.stat(p)
    is_dir = os.path.isdir(p)
    name = os.path.basename(rel)
    stem, ext = (name.lower(), "") if is_dir else split_name(name)
    iid = item_id("n", rel)
    kind = kind_for("n", ext, is_dir, st.st_size)
    # crea anche le cartelle intermedie
    parts = rel.split("/")[:-1]
    with db.writing(con):
        for i in range(len(parts)):
            drel = "/".join(parts[:i + 1])
            con.execute("INSERT OR IGNORE INTO items(id,src,rel,name,stem,parent,is_dir,kind,size,mtime,enriched) "
                        "VALUES(?,?,?,?,?,?,1,'dir',0,?,1)",
                        (item_id("n", drel), "n", drel, parts[i], parts[i].lower(), parent_of("n", drel), time.time()))
        con.execute(
            "INSERT INTO items(id,src,rel,name,stem,parent,is_dir,ext,kind,size,mtime,enriched) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET size=excluded.size, mtime=excluded.mtime",
            (iid, "n", rel, name, stem, parent_of("n", rel), int(is_dir), ext, "dir" if is_dir else kind,
             0 if is_dir else st.st_size, st.st_mtime))
        con.execute("DELETE FROM items_fts WHERE id=?", (iid,))
        con.execute("INSERT INTO items_fts(id,name,rel,body) VALUES(?,?,?,'')", (iid, name, rel))
        if not is_dir:
            recompute_year(con, iid)
    return iid, kind


def safe_rel(rel: str):
    rel = rel.strip().strip("/")
    if not rel or any(part in ("", ".", "..") for part in rel.split("/")):
        raise HTTPException(400, "percorso non valido")
    if rel.split("/")[0] in (".trash", ".atlante"):
        raise HTTPException(400, "cartella riservata")
    return rel


@app.get("/api/note")
def note_get(id: str, con=Depends(get_con)):
    vault_id_check(id)
    p = abs_path(id)
    try:
        with open(p, encoding="utf-8", errors="replace") as f:
            text = f.read()
    except FileNotFoundError:
        raise HTTPException(404, "nota non trovata")
    return {"id": id, "text": text, "mtime": os.stat(p).st_mtime}


@app.put("/api/note")
def note_save(body: NoteSave, con=Depends(get_con)):
    vault_id_check(body.id)
    p = abs_path(body.id)
    if body.base_mtime is not None and os.path.exists(p):
        cur = os.stat(p).st_mtime
        if abs(cur - body.base_mtime) > 1e-3:
            raise HTTPException(409, "la nota è stata modificata altrove")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    write_atomic(p, body.text)
    rel = body.id[2:]
    register_vault_file(con, rel)
    INDEXER.index_note(body.id, body.text)
    INDEXER.resolve_links()
    return {"id": body.id, "mtime": os.stat(p).st_mtime}


@app.post("/api/note/create")
def note_create(body: NoteCreate, con=Depends(get_con)):
    folder = body.folder.strip().strip("/")
    if folder:
        folder = safe_rel(folder)
    name = re.sub(r'[\\/:*?"<>|#^\[\]]', " ", body.name).strip() or "Senza titolo"
    if name.lower().endswith(".md"):
        name = name[:-3]
    base = (folder + "/" if folder else "") + name
    rel, n = base + ".md", 1
    while os.path.exists(os.path.join(VAULT_ROOT, rel)):
        n += 1
        rel = "%s %d.md" % (base, n)
    p = os.path.join(VAULT_ROOT, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "x", encoding="utf-8") as f:
        f.write(body.text)
    iid, _ = register_vault_file(con, rel)
    INDEXER.index_note(iid, body.text)
    INDEXER.resolve_links()
    return {"id": iid}


@app.post("/api/folder/create")
def folder_create(body: IdOnly, con=Depends(get_con)):
    rel = safe_rel(body.id[2:] if body.id.startswith("n:") else body.id)
    os.makedirs(os.path.join(VAULT_ROOT, rel), exist_ok=True)
    iid, _ = register_vault_file(con, rel)
    return {"id": iid}


def link_name_for(con, iid):
    """Come scrivere un link a questo elemento: nome della nota se unico, altrimenti percorso."""
    it = get_item(con, iid)
    if it["src"] == "s":
        return "/" + it["rel"]
    if it["kind"] == "note":
        stem = it["name"][:-3] if it["name"].lower().endswith(".md") else it["name"]
        dup = con.execute("SELECT count(*) FROM items WHERE kind='note' AND stem=?", (stem.lower(),)).fetchone()[0]
        return stem if dup <= 1 else it["rel"][:-3]
    return it["rel"]


@app.post("/api/note/rename")
def note_rename(body: Rename, con=Depends(get_con)):
    """Rinomina/sposta un file o una cartella del vault e aggiorna i [[link]] nelle altre note."""
    vault_id_check(body.id)
    old = get_item(con, body.id)
    new_rel = safe_rel(body.new_rel)
    if old["kind"] == "note" and not new_rel.lower().endswith(".md"):
        new_rel += ".md"
    src_p, dst_p = abs_path(body.id), os.path.join(VAULT_ROOT, new_rel)
    if os.path.exists(dst_p):
        raise HTTPException(409, "esiste già un elemento con questo nome")

    # elementi coinvolti (la cartella e tutto il suo contenuto)
    if old["is_dir"]:
        moved = [r["id"] for r in con.execute("SELECT id FROM items WHERE id=? OR substr(id,1,?)=?",
                                              (body.id, len(body.id) + 1, body.id + "/"))]
    else:
        moved = [body.id]
    # note che puntano agli elementi spostati: ricordo come li chiamavano
    referers = {}
    for mid in moved:
        for r in con.execute("SELECT src, target_raw FROM links WHERE target_id=?", (mid,)):
            referers.setdefault(r["src"], {}).setdefault(mid, set()).add(r["target_raw"])

    os.makedirs(os.path.dirname(dst_p), exist_ok=True)
    os.rename(src_p, dst_p)

    old_rel = old["rel"]
    with db.writing(con):
        for mid in moved:
            mrel = mid[2:]
            nrel = new_rel + mrel[len(old_rel):]
            nid = item_id("n", nrel)
            name = os.path.basename(nrel)
            stem, ext = (name.lower(), "") if mid == body.id and old["is_dir"] else split_name(name)
            con.execute("UPDATE items SET id=?, rel=?, name=?, stem=?, parent=? WHERE id=?",
                        (nid, nrel, name, stem, parent_of("n", nrel), mid))
            for t in ("tags", "props", "bookmarks"):
                con.execute("UPDATE %s SET id=? WHERE id=?" % t, (nid, mid))
            con.execute("UPDATE links SET src=? WHERE src=?", (nid, mid))
            con.execute("UPDATE links SET target_id=? WHERE target_id=?", (nid, mid))
            con.execute("UPDATE items_fts SET id=?, name=?, rel=? WHERE id=?", (nid, name, nrel, mid))
            ai.rename_ids(con, mid, nid)

    # riscrivo i link nelle note che puntavano agli elementi spostati
    for ref, targets in referers.items():
        ref_new = ref
        if ref in moved:
            ref_new = item_id("n", new_rel + ref[2:][len(old_rel):])
        p = abs_path(ref_new)
        try:
            with open(p, encoding="utf-8") as f:
                text = f.read()
        except OSError:
            continue
        new_text = text
        for mid, raws in targets.items():
            nid = item_id("n", new_rel + mid[2:][len(old_rel):])
            new_text = notes.rewrite_links(new_text, raws, link_name_for(con, nid))
        if new_text != text:
            write_atomic(p, new_text)
            INDEXER.index_note(ref_new, new_text)
    INDEXER.resolve_links()
    return {"id": item_id("n", new_rel)}


@app.post("/api/note/delete")
def note_delete(body: IdOnly, con=Depends(get_con)):
    """Sposta nel cestino del vault (.trash), non cancella davvero."""
    vault_id_check(body.id)
    it = get_item(con, body.id)
    src_p = abs_path(body.id)
    trash = os.path.join(VAULT_ROOT, ".trash", time.strftime("%Y%m%d-%H%M%S"))
    os.makedirs(trash, exist_ok=True)
    os.rename(src_p, os.path.join(trash, it["name"]))
    with db.writing(con):
        ids = [r["id"] for r in con.execute("SELECT id FROM items WHERE id=? OR substr(id,1,?)=?",
                                            (body.id, len(body.id) + 1, body.id + "/"))]
        for i in ids:
            con.execute("DELETE FROM items WHERE id=?", (i,))
            con.execute("DELETE FROM items_fts WHERE id=?", (i,))
            con.execute("DELETE FROM links WHERE src=?", (i,))
            con.execute("DELETE FROM tags WHERE id=? AND origin='note'", (i,))
            con.execute("DELETE FROM props WHERE id=? AND origin='note'", (i,))
            for t in ("ai_profiles", "ai_entities", "ai_match"):
                con.execute("DELETE FROM %s WHERE id=?" % t, (i,))
            con.execute("DELETE FROM suggestions WHERE a=? OR b=?", (i, i))
    INDEXER.resolve_links()
    return {"ok": True}


@app.get("/api/linkname")
def linkname(id: str, con=Depends(get_con)):
    return {"link": link_name_for(con, id)}


# ---------------------------------------------------------------- tag, proprietà, segnalibri

class TagsBody(BaseModel):
    id: str
    tags: list[str]


class PropsBody(BaseModel):
    id: str
    props: dict[str, str]


class Bookmark(BaseModel):
    id: str
    on: bool = True


@app.post("/api/item/tags")
def set_tags(body: TagsBody, con=Depends(get_con)):
    it = get_item(con, body.id)
    if it["kind"] == "note":
        raise HTTPException(400, "i tag delle note si scrivono dentro la nota")
    clean = sorted({t.strip().lstrip("#").lower() for t in body.tags if t.strip().lstrip("#")})
    with db.writing(con):
        con.execute("DELETE FROM tags WHERE id=? AND origin='user'", (body.id,))
        con.executemany("INSERT INTO tags(id,tag,origin) VALUES(?,?,'user')", [(body.id, t) for t in clean])
    return {"tags": tags_of(con, body.id)}


@app.post("/api/item/props")
def set_props(body: PropsBody, con=Depends(get_con)):
    it = get_item(con, body.id)
    if it["kind"] == "note":
        raise HTTPException(400, "le proprietà delle note si scrivono dentro la nota")
    with db.writing(con):
        con.execute("DELETE FROM props WHERE id=? AND origin='user'", (body.id,))
        con.executemany("INSERT INTO props(id,key,value,origin) VALUES(?,?,?,'user')",
                        [(body.id, k.strip(), v) for k, v in body.props.items() if k.strip()])
        recompute_year(con, body.id)
    return {"props": props_of(con, body.id), "year": get_item(con, body.id)["year"]}


@app.get("/api/tags")
def all_tags(con=Depends(get_con)):
    return [dict(r) for r in con.execute(
        "SELECT t.tag, count(DISTINCT t.id) AS count FROM tags t JOIN items i ON i.id=t.id "
        "GROUP BY t.tag ORDER BY t.tag")]


@app.get("/api/props/keys")
def prop_keys(con=Depends(get_con)):
    return [dict(r) for r in con.execute(
        "SELECT key, count(DISTINCT id) AS count FROM props GROUP BY lower(key) ORDER BY count DESC")]


@app.get("/api/bookmarks")
def bookmarks(con=Depends(get_con)):
    rows = con.execute("SELECT %s FROM items JOIN bookmarks b USING(id) ORDER BY b.created" %
                       ", ".join("items." + c.strip() for c in ITEM_COLS.split(","))).fetchall()
    return [row_item(r) for r in rows]


@app.post("/api/bookmarks")
def set_bookmark(body: Bookmark, con=Depends(get_con)):
    get_item(con, body.id)
    with db.writing(con):
        if body.on:
            con.execute("INSERT OR IGNORE INTO bookmarks(id, created) VALUES(?,?)", (body.id, time.time()))
        else:
            con.execute("DELETE FROM bookmarks WHERE id=?", (body.id,))
    return {"ok": True}


# ---------------------------------------------------------------- grafo e anni

def node(r, degree=0):
    return {"id": r["id"], "name": r["name"], "kind": r["kind"], "src": r["src"], "year": r["year"],
            "year_src": r["year_src"], "degree": degree}


@app.get("/api/graph")
def graph(scope: str = "global", id: str = "", depth: int = 1, tags: bool = False,
          orphans: bool = True, suggest: bool = False, con=Depends(get_con)):
    """Grafo dei collegamenti. scope=global: tutte le note + tutto ciò che è linkato, taggato o nei segnalibri.
    scope=local: l'elemento `id` e i vicini fino a `depth` passi."""
    edges = [(r["src"], r["target_id"]) for r in
             con.execute("SELECT DISTINCT src, target_id FROM links WHERE target_id IS NOT NULL AND src<>target_id")]
    tag_edges = []
    if tags:
        tag_edges = [(r["id"], "tag:" + r["tag"]) for r in
                     con.execute("SELECT DISTINCT t.id, t.tag FROM tags t JOIN items i ON i.id=t.id")]
    ai_edges = ai.graph_edges(con, suggest)
    edge_type = {(a, b): t for a, b, t in ai_edges}
    all_edges = edges + tag_edges + [(a, b) for a, b, _ in ai_edges]

    if scope == "local":
        if not id:
            raise HTTPException(400, "serve id")
        adj = {}
        for a, b in all_edges:
            adj.setdefault(a, set()).add(b)
            adj.setdefault(b, set()).add(a)
        keep, frontier = {id}, {id}
        for _ in range(max(1, min(depth, 4))):
            nxt = set()
            for n in frontier:
                nxt |= adj.get(n, set())
            nxt -= keep
            keep |= nxt
            frontier = nxt
        ids = keep
    else:
        ids = {a for a, b in all_edges} | {b for a, b in all_edges}
        if orphans:
            ids |= {r["id"] for r in con.execute("SELECT id FROM items WHERE kind='note'")}
            ids |= {r["id"] for r in con.execute("SELECT id FROM bookmarks")}
            ids |= {r["id"] for r in con.execute("SELECT DISTINCT id FROM tags WHERE origin='user'")}
            ids |= {r["id"] for r in con.execute("SELECT DISTINCT id FROM props WHERE origin='user'")}

    item_ids = [i for i in ids if not i.startswith("tag:")]
    rows = {}
    for k in range(0, len(item_ids), 500):
        chunk = item_ids[k:k + 500]
        for r in con.execute("SELECT %s FROM items WHERE id IN (%s)" % (ITEM_COLS, ",".join("?" * len(chunk))), chunk):
            rows[r["id"]] = r
    deg = {}
    out_edges = []
    for a, b in all_edges:
        if (a in rows or a.startswith("tag:")) and (b in rows or b.startswith("tag:")) and a in ids and b in ids:
            out_edges.append({"source": a, "target": b,
                              "type": "tag" if b.startswith("tag:") else edge_type.get((a, b), "link")})
            deg[a] = deg.get(a, 0) + 1
            deg[b] = deg.get(b, 0) + 1
    nodes = [node(r, deg.get(i, 0)) for i, r in rows.items()]
    nodes += [{"id": t, "name": "#" + t[4:], "kind": "tag", "src": "t", "year": None, "degree": deg.get(t, 0)}
              for t in ids if t.startswith("tag:")]
    return {"nodes": nodes, "edges": out_edges}


@app.get("/api/years")
def years(src: str = "", con=Depends(get_con)):
    """Quanti elementi per anno e per tipo (panoramica per anni)."""
    w, a = "is_dir=0 AND year IS NOT NULL", []
    if src in ("s", "n"):
        w += " AND src=?"
        a.append(src)
    rows = con.execute("SELECT year, kind, count(*) AS count FROM items WHERE %s GROUP BY year, kind "
                       "ORDER BY year" % w, a).fetchall()
    return [dict(r) for r in rows]


@app.get("/api/years/items")
def year_items(year: int, kind: str = "", limit: int = 300, con=Depends(get_con)):
    """Elementi di un anno: prima quelli organizzati (note, linkati, taggati), poi i più recenti."""
    w, a = ["is_dir=0", "year=?"], [year]
    if kind:
        ks = kind.split(",")
        w.append("kind IN (%s)" % ",".join("?" * len(ks)))
        a += ks
    rows = con.execute(
        "SELECT %s, ((kind='note') + EXISTS(SELECT 1 FROM links l WHERE l.target_id=items.id) "
        "+ EXISTS(SELECT 1 FROM tags t WHERE t.id=items.id)) AS score FROM items WHERE %s "
        "ORDER BY score DESC, mtime DESC LIMIT ?" % (ITEM_COLS, " AND ".join(w)), a + [min(limit, 2000)]).fetchall()
    return [row_item(r) for r in rows]
