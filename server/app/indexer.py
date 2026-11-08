"""Indicizzazione: scansione delle cartelle, estrazione testo/anni, link tra note."""
import datetime as dt
import logging
import os
import re
import subprocess
import threading
import time

from . import db, notes
from .config import CFG, STORAGE_ROOT, VAULT_ROOT, is_excluded

log = logging.getLogger("atlante.indexer")

KINDS = {
    "markdown": {"md", "markdown"},
    "text": {"txt", "log", "csv", "tsv", "json", "yaml", "yml", "toml", "ini", "conf", "xml", "srt", "vtt",
             "py", "js", "ts", "c", "h", "cpp", "sh", "html", "css", "sql", "go", "rs", "java", "rb", "php"},
    "pdf": {"pdf"},
    "image": {"jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "svg", "avif"},
    "video": {"mp4", "mkv", "avi", "mov", "m4v", "webm", "wmv", "flv", "mpg", "mpeg", "ts", "m2ts"},
    "audio": {"mp3", "flac", "m4a", "aac", "ogg", "opus", "wav", "wma", "m4b"},
    "ebook": {"epub", "mobi", "azw", "azw3", "fb2", "djvu", "cbz", "cbr", "cb7"},
    "doc": {"doc", "docx", "odt", "rtf", "pages", "xls", "xlsx", "ods", "numbers", "ppt", "pptx", "odp", "key"},
    "archive": {"zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "iso", "dmg"},
}
EXT_KIND = {e: k for k, exts in KINDS.items() for e in exts}
# 'ts' è sia TypeScript che video: per i file grandi assumiamo video
TEXT_KINDS = {"markdown", "text", "note"}
ENRICH_KINDS = {"note", "markdown", "text", "pdf", "image"}

ROOTS = {"s": STORAGE_ROOT, "n": VAULT_ROOT}


def kind_for(src, ext, is_dir, size=0):
    if is_dir:
        return "dir"
    if src == "n" and ext in ("md", "markdown"):
        return "note"
    if ext == "ts" and size > 2_000_000:
        return "video"
    return EXT_KIND.get(ext, "other")


def split_name(name):
    stem, dot, ext = name.rpartition(".")
    if not dot or not stem:
        return name.lower(), ""
    return stem.lower(), ext.lower()


def item_id(src, rel):
    return "%s:%s" % (src, rel)


def abs_path(iid: str):
    """Percorso reale di un id, verificando che resti dentro la sua radice."""
    src, _, rel = iid.partition(":")
    root = ROOTS.get(src)
    if root is None:
        raise ValueError("id non valido")
    p = os.path.realpath(os.path.join(root, rel))
    rr = os.path.realpath(root)
    if p != rr and not p.startswith(rr + os.sep):
        raise ValueError("percorso fuori dalla radice")
    return p


def parent_of(src, rel):
    if "/" not in rel:
        return item_id(src, "")
    return item_id(src, rel.rsplit("/", 1)[0])


# ---------------------------------------------------------------- anni

THIS_YEAR = dt.date.today().year
# date nel nome del file: IMG_20150615_151633, 2015-06-15, Screenshot 2019.08.25 …
NAME_DATE_RE = re.compile(r"(?<!\d)(19[89]\d|20[0-4]\d)[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?!\d)")
# una cartella che è un anno: foto/2015/06/…
PATH_YEAR_RE = re.compile(r"(?:^|/)(19[89]\d|20[0-4]\d)(?=/)")


def plausible(year, lo=1900):
    return year if year and lo <= year <= THIS_YEAR + 1 else None


def year_of_ts(ts):
    """Anno della data di modifica; scarta date impossibili (es. 1901 da timestamp corrotti)."""
    try:
        return plausible(dt.datetime.fromtimestamp(ts).year, lo=1980)
    except (OverflowError, OSError, ValueError, TypeError):
        return None


def year_from_name(rel):
    name = rel.rsplit("/", 1)[-1]
    m = NAME_DATE_RE.search(name)
    if m:
        return plausible(int(m.group(1)), lo=1980)
    m = None
    for m in PATH_YEAR_RE.finditer(rel):
        pass  # l'ultima cartella-anno del percorso è la più specifica
    return plausible(int(m.group(1)), lo=1980) if m else None


def recompute_year(con, iid):
    """Anno di un elemento: proprietà 'anno' > metadati (PDF/EXIF/frontmatter) > nome o cartella > data di modifica."""
    r = con.execute("SELECT rel, mtime, meta_year, kind FROM items WHERE id=?", (iid,)).fetchone()
    if not r:
        return
    year, src = None, None
    p = con.execute(
        "SELECT value FROM props WHERE id=? AND lower(key) IN ('anno','year') ORDER BY origin='user' DESC LIMIT 1",
        (iid,)).fetchone()
    if p:
        year = notes.year_from_value(p["value"])
        src = "proprietà" if year else None
    if year is None and plausible(r["meta_year"]):
        year, src = r["meta_year"], ("nota" if r["kind"] == "note" else "metadati")
    if year is None and r["kind"] != "note":
        year = year_from_name(r["rel"])
        src = "nome" if year else None
    if year is None and r["mtime"]:
        year = year_of_ts(r["mtime"])
        src = "modifica" if year else None
    con.execute("UPDATE items SET year=?, year_src=? WHERE id=?", (year, src, iid))


# ---------------------------------------------------------------- scansione

class Indexer:
    def __init__(self):
        self.con = db.connect()
        self.status = {"scanning": None, "last_scan": {}, "scanned": 0, "errors": 0}
        self._wake = threading.Event()
        self._enrich_wake = threading.Event()
        self._stop = False
        self._rescan_storage = True

    # -- thread principale
    def start(self):
        threading.Thread(target=self._loop, name="indexer", daemon=True).start()
        threading.Thread(target=self._enrich_loop, name="enricher", daemon=True).start()

    def request_rescan(self):
        self._rescan_storage = True
        self._wake.set()

    def _loop(self):
        try:
            os.nice(5)
        except OSError:
            pass
        last_storage = 0
        try:
            self.migrate()
        except Exception:
            log.exception("errore nell'aggiornamento dell'indice")
        while not self._stop:
            try:
                self.scan("n")
                due = time.time() - last_storage > CFG["rescan_minutes"] * 60
                if self._rescan_storage or due:
                    self._rescan_storage = False
                    self.scan("s")
                    last_storage = time.time()
            except Exception:
                log.exception("errore durante la scansione")
            self._wake.wait(CFG["vault_rescan_seconds"])
            self._wake.clear()

    def migrate(self):
        """Aggiorna l'indice quando cambiano le regole per gli anni (senza riscansionare tutto)."""
        con = self.con
        ver = int(db.get_state(con, "year_rules", "1"))
        if ver >= 2:
            return
        log.info("aggiorno gli anni con le nuove regole…")
        with db.writing(con):
            con.execute("UPDATE items SET enriched=0 WHERE kind='image' AND ext IN ('heic','heif')")
        ids = [r["id"] for r in con.execute("SELECT id FROM items WHERE is_dir=0")]
        for i in range(0, len(ids), 2000):
            with db.writing(con):
                for iid in ids[i:i + 2000]:
                    recompute_year(con, iid)
        with db.writing(con):
            db.set_state(con, "year_rules", 2)
        log.info("anni aggiornati per %d elementi", len(ids))

    def scan(self, src):
        root = ROOTS[src]
        patterns = CFG["exclude"] if src == "s" else CFG["vault_exclude"]
        con = self.con
        gen = int(time.time() * 1000)
        self.status["scanning"] = src
        self.status["scanned"] = 0
        t0 = time.time()

        known = {r["id"]: (r["size"], r["mtime"], r["is_dir"]) for r in
                 con.execute("SELECT id,size,mtime,is_dir FROM items WHERE src=?", (src,))}
        prev_count = len(known)
        seen_ids = []
        batch_new = []
        changed = 0
        changed_notes = []

        if not os.path.isdir(root):
            log.warning("radice %s non disponibile, salto", root)
            self.status["scanning"] = None
            return

        stack = [""]
        count = 0
        while stack:
            rel_dir = stack.pop()
            try:
                it = os.scandir(os.path.join(root, rel_dir) if rel_dir else root)
            except OSError:
                self.status["errors"] += 1
                continue
            with it:
                for e in it:
                    rel = e.name if not rel_dir else rel_dir + "/" + e.name
                    if is_excluded(rel, e.name, patterns):
                        continue
                    try:
                        if e.is_symlink():
                            continue
                        is_dir = e.is_dir(follow_symlinks=False)
                        st = e.stat(follow_symlinks=False)
                    except OSError:
                        self.status["errors"] += 1
                        continue
                    iid = item_id(src, rel)
                    size = 0 if is_dir else st.st_size
                    mtime = st.st_mtime
                    seen_ids.append(iid)
                    count += 1
                    old = known.get(iid)
                    if old is None or (not is_dir and (old[0] != size or abs((old[1] or 0) - mtime) > 1e-3)):
                        stem, ext = split_name(e.name)
                        if is_dir:
                            stem, ext = e.name.lower(), ""
                        kind = kind_for(src, ext, is_dir, size)
                        changed += 1
                        batch_new.append((iid, src, rel, e.name, stem, parent_of(src, rel), int(is_dir),
                                          ext, kind, size, mtime))
                        if kind == "note":
                            changed_notes.append(iid)
                    if is_dir:
                        stack.append(rel)
                    if len(batch_new) >= 2000:
                        self._flush(batch_new)
                        batch_new = []
                    self.status["scanned"] = count
        self._flush(batch_new)

        # file spariti: se ne mancano troppi probabilmente il disco è scollegato -> non cancello nulla
        seen = set(seen_ids)
        missing = [i for i in known if i not in seen]
        suspicious = src == "s" and prev_count > 100 and count < prev_count * 0.5
        if suspicious and count > 0:
            # metà dei file spariti: disco scollegato o cancellazione voluta? Se dopo 3 controlli
            # di fila il numero resta basso, la considero voluta e aggiorno l'indice.
            self._suspicious = getattr(self, "_suspicious", 0) + 1
            if self._suspicious >= 3:
                suspicious = False
        elif src == "s":
            self._suspicious = 0
        if src == "s" and count == 0 and prev_count > 0:
            suspicious = True  # disco vuoto o non montato: non tocco nulla
        if suspicious:
            log.warning("trovati %d elementi su %d: il disco sembra scollegato, non rimuovo nulla", count, prev_count)
            missing = []
        elif missing:
            with db.writing(con):
                for i in range(0, len(missing), 500):
                    chunk = missing[i:i + 500]
                    q = ",".join("?" * len(chunk))
                    con.execute("DELETE FROM items WHERE id IN (%s)" % q, chunk)
                    con.execute("DELETE FROM items_fts WHERE id IN (%s)" % q, chunk)
                    # le note eliminate perdono i propri link/tag/proprietà;
                    # tag e proprietà messi a mano sui file del server restano (se il file torna, li ritrova)
                    con.execute("DELETE FROM links WHERE src IN (%s)" % q, chunk)
                    con.execute("DELETE FROM tags WHERE origin='note' AND id IN (%s)" % q, chunk)
                    con.execute("DELETE FROM props WHERE origin='note' AND id IN (%s)" % q, chunk)
                    con.execute("DELETE FROM tasks WHERE id IN (%s)" % q, chunk)
                    for t in ("ai_profiles", "ai_entities", "ai_match"):
                        con.execute("DELETE FROM %s WHERE id IN (%s)" % (t, q), chunk)
                    con.execute("DELETE FROM suggestions WHERE status='pending' AND (a IN (%s) OR b IN (%s))"
                                % (q, q), chunk + chunk)

        for nid in changed_notes:
            self.index_note(nid)
        if changed_notes or missing or changed:
            self.resolve_links()

        self.status["last_scan"][src] = {"at": time.time(), "items": count, "seconds": round(time.time() - t0, 1),
                                         "changed": changed, "removed": len(missing)}
        self.status["scanning"] = None
        self._wake_enricher()
        log.info("scansione %s: %d elementi in %.1fs", src, count, time.time() - t0)

    def _flush(self, rows):
        if not rows:
            return
        con = self.con
        with db.writing(con):
            con.executemany(
                """INSERT INTO items(id,src,rel,name,stem,parent,is_dir,ext,kind,size,mtime,enriched)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,0)
                   ON CONFLICT(id) DO UPDATE SET name=excluded.name, stem=excluded.stem, parent=excluded.parent,
                     is_dir=excluded.is_dir, ext=excluded.ext, kind=excluded.kind, size=excluded.size,
                     mtime=excluded.mtime, enriched=0""", rows)
            ids = [r[0] for r in rows]
            for i in range(0, len(ids), 500):
                chunk = ids[i:i + 500]
                con.execute("DELETE FROM items_fts WHERE id IN (%s)" % ",".join("?" * len(chunk)), chunk)
            con.executemany("INSERT INTO items_fts(id,name,rel,body) VALUES(?,?,?,'')",
                            [(r[0], r[3], r[2]) for r in rows])
            for r in rows:
                if not r[6]:
                    recompute_year(con, r[0])

    # -- note

    def index_note(self, nid, text=None):
        con = self.con
        if text is None:
            try:
                with open(abs_path(nid), encoding="utf-8", errors="replace") as f:
                    text = f.read(CFG["text_max_chars"] * 2)
            except OSError:
                return
        info = notes.parse(text)
        with db.writing(con):
            con.execute("DELETE FROM links WHERE src=?", (nid,))
            con.execute("DELETE FROM tags WHERE id=? AND origin='note'", (nid,))
            con.execute("DELETE FROM props WHERE id=? AND origin='note'", (nid,))
            con.execute("DELETE FROM tasks WHERE id=?", (nid,))
            con.executemany("INSERT OR REPLACE INTO tasks(id,line,text,done,due) VALUES(?,?,?,?,?)",
                            [(nid, ln, t, int(d), due) for ln, d, t, due in info["tasks"]])
            con.executemany("INSERT INTO links(src,target_raw,kind) VALUES(?,?,?)",
                            [(nid, t, k) for t, k in info["links"]])
            con.executemany("INSERT OR IGNORE INTO tags(id,tag,origin) VALUES(?,?,'note')",
                            [(nid, t) for t in info["tags"]])
            con.executemany("INSERT OR REPLACE INTO props(id,key,value,origin) VALUES(?,?,?,'note')",
                            [(nid, k, v) for k, v in info["props"].items()])
            r = con.execute("SELECT name, rel FROM items WHERE id=?", (nid,)).fetchone()
            con.execute("DELETE FROM items_fts WHERE id=?", (nid,))
            if r:
                con.execute("INSERT INTO items_fts(id,name,rel,body) VALUES(?,?,?,?)",
                            (nid, r["name"], r["rel"], info["body"][:CFG["text_max_chars"]]))
            con.execute("UPDATE items SET textlen=? WHERE id=?", (len(info["body"].strip()), nid))
            con.execute("UPDATE items SET meta_year=?, enriched=1 WHERE id=?", (info["year"], nid))
            recompute_year(con, nid)

    def resolve(self, target, con=None):
        """Trova l'elemento a cui punta [[target]]."""
        con = con or self.con
        t = target.strip()
        if t.startswith("/"):  # percorso esplicito sul server: [[/books/libro.epub]]
            r = con.execute("SELECT id FROM items WHERE id=?", ("s:" + t.strip("/"),)).fetchone()
            return r["id"] if r else None
        for cand in (t, t + ".md"):
            r = con.execute("SELECT id FROM items WHERE src='n' AND rel=? COLLATE NOCASE", (cand,)).fetchone()
            if r:
                return r["id"]
        base = t.rsplit("/", 1)[-1].lower()
        r = con.execute("SELECT id FROM items WHERE src='n' AND kind='note' AND stem=? ORDER BY length(rel) LIMIT 1",
                        (base[:-3] if base.endswith(".md") else base,)).fetchone()
        if r:
            return r["id"]
        r = con.execute("SELECT id FROM items WHERE src='n' AND lower(name)=? ORDER BY length(rel) LIMIT 1",
                        (base,)).fetchone()
        if r:
            return r["id"]
        r = con.execute("SELECT id FROM items WHERE src='s' AND rel=? COLLATE NOCASE", (t,)).fetchone()
        if r:
            return r["id"]
        r = con.execute("SELECT id FROM items WHERE src='s' AND lower(name)=? ORDER BY length(rel) LIMIT 1",
                        (base,)).fetchone()
        return r["id"] if r else None

    def resolve_links(self):
        # connessione propria: la chiamano anche le richieste e la wiki da altri thread,
        # mentre la scansione usa self.con (sqlite non vuole due thread sulla stessa connessione)
        con = db.connect()
        try:
            rows = con.execute("SELECT DISTINCT target_raw FROM links").fetchall()
            mapping = {r["target_raw"]: self.resolve(r["target_raw"], con) for r in rows}
            with db.writing(con):
                con.executemany("UPDATE links SET target_id=? WHERE target_raw=?",
                                [(v, k) for k, v in mapping.items()])
        finally:
            con.close()

    # -- arricchimento in background (testo dei PDF, anni dai metadati)

    def _wake_enricher(self):
        self._enrich_wake.set()

    def _enrich_loop(self):
        try:
            os.nice(10)
        except OSError:
            pass
        con = db.connect()
        kinds = tuple(ENRICH_KINDS - {"note"})
        q = "SELECT id, kind, size FROM items WHERE enriched=0 AND is_dir=0 AND kind IN (%s) LIMIT 50" % \
            ",".join("?" * len(kinds))
        while not self._stop:
            rows = con.execute(q, kinds).fetchall()
            if not rows:
                with db.writing(con):  # tutto il resto non ha nulla da estrarre
                    con.execute("UPDATE items SET enriched=1 WHERE enriched=0 AND kind NOT IN ('note')")
                self._enrich_wake.wait(60)
                self._enrich_wake.clear()
                continue
            for r in rows:
                body, year = "", None
                try:
                    body, year = extract(r["id"], r["kind"], r["size"] or 0)
                except Exception:
                    log.debug("estrazione fallita per %s", r["id"], exc_info=True)
                with db.writing(con):
                    con.execute("UPDATE items SET enriched=1, meta_year=?, textlen=? WHERE id=?",
                                (year, len((body or "").strip()), r["id"]))
                    if body:
                        row = con.execute("SELECT name, rel FROM items WHERE id=?", (r["id"],)).fetchone()
                        con.execute("DELETE FROM items_fts WHERE id=?", (r["id"],))
                        con.execute("INSERT INTO items_fts(id,name,rel,body) VALUES(?,?,?,?)",
                                    (r["id"], row["name"], row["rel"], body))
                    recompute_year(con, r["id"])


PDF_DATE_RE = re.compile(r"^CreationDate:\s+(.*)$", re.M)


def extract(iid, kind, size):
    path = abs_path(iid)
    maxc = CFG["text_max_chars"]
    if kind in ("markdown", "text"):
        if size > 5_000_000:
            return "", None
        with open(path, encoding="utf-8", errors="ignore") as f:
            text = f.read(maxc)
        y = None
        if kind == "markdown":
            y = notes.parse(text)["year"]
        return text, y
    if kind == "pdf":
        year = None
        try:
            info = subprocess.run(["pdfinfo", path], capture_output=True, text=True, timeout=20).stdout
            m = PDF_DATE_RE.search(info)
            if m:
                year = notes.year_from_value(m.group(1))
        except (subprocess.SubprocessError, OSError):
            pass
        text = ""
        if size <= CFG["text_max_mb"] * 1024 * 1024:
            try:
                text = subprocess.run(["pdftotext", "-l", "300", "-enc", "UTF-8", "-q", path, "-"],
                                      capture_output=True, timeout=120).stdout.decode("utf-8", "ignore")[:maxc]
            except (subprocess.SubprocessError, OSError):
                pass
        return text, year
    if kind == "image":
        try:
            from PIL import Image
            if path.lower().endswith((".heic", ".heif")):
                from pillow_heif import register_heif_opener
                register_heif_opener()
            with Image.open(path) as im:
                ex = im.getexif()
                v = ex.get_ifd(0x8769).get(36867) or ex.get(306)
                return "", notes.year_from_value(v)
        except Exception:
            return "", None
    return "", None
