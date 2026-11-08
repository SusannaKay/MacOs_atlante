"""Quali entità meritano una pagina della wiki, e cosa fare delle altre.

La regola (uguale per tutto l'archivio, senza eccezioni per cartella):
  un'entità ha una pagina sua se ha almeno 2 fonti con testo vero (note, documenti, PDF),
  oppure 1 fonte con testo vero e fonti in almeno 2 posti diversi dell'archivio.

Un file "solo nome" (una ROM, un film, un'immagine) dice poco: cento ROM nella stessa cartella
non sono cento argomenti, sono una collezione. Le entità che non passano la regola finiscono in
wiki_skip e, se sono tante nella stessa cartella, in una pagina di collezione (wiki/collezioni).
Si ricontrollano da sole quando compaiono in file nuovi.

All'avvio, una volta:
  - calcola quanto testo ha ogni file (items.textlen), leggendo l'indice di ricerca una volta sola
  - unisce i doppioni («Kayed Susanna» = «Susanna Kayed», o il nome di una pagina che è alias di un'altra)
  - sposta nel cestino del vault (.trash) le pagine scritte da Atlante che non passano la regola,
    con una riga in log.md per ognuna. Le pagine bloccate o scritte a mano non si toccano.
"""
import collections
import json
import logging
import os
import threading
import time

from . import db
from .ai import ENTITY_ALIAS, entity_key, generated_sql
from .config import STORAGE_LABEL, VAULT_LABEL, VAULT_ROOT
from . import wiki

log = logging.getLogger("atlante.wiki")

TEXT_KINDS = ("note", "pdf", "text", "markdown")
MIN_TEXT = 200            # caratteri di testo estratto perché un file conti come "con testo"
MIN_COLLECTION = 5        # entità nella stessa cartella per fare una pagina di collezione
COLL_DIR = "wiki/collezioni"
# ultime cartelle che non dicono niente: «mastersystem/images» è la collezione «mastersystem»
GENERIC_DIRS = {"images", "image", "img", "imgs", "covers", "cover", "boxart", "boxarts", "snaps", "snap",
                "screenshots", "screens", "manuals", "manual", "media", "thumbnails", "thumbs", "art", "artwork",
                "foto", "scans", "scan", "titles", "videos", "marquees", "wheel", "fanart", "3dboxes"}
COLL_EVERY = 600          # secondi minimi tra due riscritture delle collezioni
CLEANUP_VERSION = "1"     # cambiandolo, la pulizia all'avvio si rifà

STATE = {"ready": False, "coll_dirty": False, "coll_at": 0.0}
GEN = generated_sql("i.id")


def get_state(con, key):
    r = con.execute("SELECT value FROM wiki_state WHERE key=?", (key,)).fetchone()
    return r[0] if r else None


def set_state(con, key, value):
    with db.writing(con):
        con.execute("INSERT OR REPLACE INTO wiki_state(key, value) VALUES(?,?)", (key, str(value)))


# ---------------------------------------------------------------- la regola

def place(src, rel):
    """Il "posto" di un file: le prime due cartelle del percorso (per le note, la prima)."""
    parts = rel.split("/")[:-1]
    if src == "n":
        return "Note/" + (parts[0] if parts else "")
    return "/".join(parts[:2]) or "(radice)"


def collection_folder(src, rel):
    parts = rel.split("/")[:-1]
    while parts and parts[-1].lower() in GENERIC_DIRS:
        parts.pop()
    return "%s:%s" % (src, "/".join(parts))


def has_text(r):
    if r["kind"] not in TEXT_KINDS:
        return False
    # textlen ancora da calcolare (file non ancora letto): nel dubbio conta come testo
    return r["textlen"] is None or r["textlen"] > MIN_TEXT


def pick_count(con, entity):
    """Fonti contate come in wiki.PICK (file con riassunto aggiornato): serve a capire quando ricontrollare."""
    return con.execute("SELECT count(*) FROM ai_entities e JOIN items i ON i.id=e.id "
                       "JOIN ai_profiles p ON p.id=e.id AND p.mtime=i.mtime "
                       "WHERE e.entity=? AND p.summary<>'' AND NOT " + GEN, (entity,)).fetchone()[0]


def judge(con, entity):
    """(merita una pagina?, quante fonti, cartella dominante dei file "solo nome")"""
    rows = con.execute("SELECT i.src, i.rel, i.kind, i.textlen FROM ai_entities e JOIN items i ON i.id=e.id "
                       "WHERE e.entity=? AND NOT " + GEN, (entity,)).fetchall()
    text = sum(1 for r in rows if has_text(r))
    places = {place(r["src"], r["rel"]) for r in rows}
    ok = text >= 2 or (text >= 1 and len(places) >= 2)
    folders = collections.Counter(collection_folder(r["src"], r["rel"]) for r in rows if not has_text(r))
    folder = folders.most_common(1)[0][0] if folders else None
    return ok or not STATE["ready"], len(rows), folder


def skip(con, entity, n, folder, title=None):
    with db.writing(con):
        con.execute("INSERT INTO wiki_skip(entity, sources, title, folder, at) VALUES(?,?,?,?,?) "
                    "ON CONFLICT(entity) DO UPDATE SET sources=excluded.sources, folder=excluded.folder, "
                    "title=coalesce(excluded.title, wiki_skip.title), at=excluded.at",
                    (entity, n, title, folder, time.time()))
    STATE["coll_dirty"] = True


# ---------------------------------------------------------------- collezioni

def nice(entity):
    return " ".join(w if w.isupper() else w[:1].upper() + w[1:] for w in entity.split())


def coll_slug(con, folder):
    r = con.execute("SELECT slug FROM wiki_collections WHERE folder=?", (folder,)).fetchone()
    if r:
        return r[0]
    parts = [p for p in folder.split(":", 1)[1].split("/") if p]
    base = wiki.slug_for(" ".join(parts[-2:]) or "archivio")
    slug, n = base, 1
    while con.execute("SELECT 1 FROM wiki_collections WHERE slug=?", (slug,)).fetchone() \
            or not wiki.touchable("%s/%s.md" % (COLL_DIR, slug)):
        n += 1
        slug = "%s-%d" % (base, n)
    return slug


def render_collection(con, folder, members):
    src, _, path = folder.partition(":")
    label = (VAULT_LABEL if src == "n" else STORAGE_LABEL) + "/" + path
    name = path.rsplit("/", 1)[-1] or path or "Archivio"
    title = "Collezione: " + name
    fm = {"titolo": title, "tipo": "collezione", "descrizione": "%d elementi nella cartella %s" % (len(members), label),
          "cartella": label, "tag": ["wiki", "collezione"], "aggiornato": wiki.now_local().date().isoformat(),
          "generato": "atlante"}
    out = ["---", wiki.yaml.safe_dump(fm, allow_unicode=True, sort_keys=False, width=1000).strip(), "---", "",
           "# " + title, "",
           "File della cartella `%s` che parlano ognuno di una cosa sola e non hanno abbastanza testo per una "
           "pagina propria. Se uno di questi compare in altri documenti o note, Atlante gli scrive una pagina." % label,
           ""]
    for m in sorted(members, key=lambda m: (m["title"] or m["entity"]).lower()):
        files = con.execute("SELECT i.id, i.name FROM ai_entities e JOIN items i ON i.id=e.id "
                            "WHERE e.entity=? AND NOT " + GEN + " ORDER BY i.name LIMIT 4", (m["entity"],)).fetchall()
        links = []
        for f in files:
            target = wiki.HOOKS["link_name"](con, f["id"])
            label_f = f["name"].replace("|", " ").replace("]", " ")
            links.append("[[%s|%s]]" % (target, label_f) if target != label_f else "[[%s]]" % target)
        out.append("- **%s**%s" % (m["title"] or nice(m["entity"]), (" — " + ", ".join(links)) if links else ""))
    return "\n".join(out).rstrip() + "\n"


def rebuild_collections(con, force=False):
    if not force and (not STATE["coll_dirty"] or time.time() - STATE["coll_at"] < COLL_EVERY):
        return 0
    STATE["coll_dirty"], STATE["coll_at"] = False, time.time()
    groups = collections.defaultdict(list)
    for r in con.execute("SELECT entity, title, folder FROM wiki_skip WHERE folder IS NOT NULL"):
        groups[r["folder"]].append(dict(r))
    written = 0
    for folder, members in groups.items():
        if len(members) < MIN_COLLECTION:
            continue
        key = json.dumps(sorted(m["entity"] for m in members))
        old = con.execute("SELECT slug, members FROM wiki_collections WHERE folder=?", (folder,)).fetchone()
        if old and old["members"] == key:
            continue
        slug = coll_slug(con, folder)
        rel = "%s/%s.md" % (COLL_DIR, slug)
        if not wiki.touchable(rel):
            continue
        text = render_collection(con, folder, members)
        with db.writing(con):
            con.execute("INSERT INTO wiki_collections(slug, folder, title, members, updated) VALUES(?,?,?,?,?) "
                        "ON CONFLICT(slug) DO UPDATE SET members=excluded.members, updated=excluded.updated",
                        (slug, folder, text.split("\n# ", 1)[1].split("\n", 1)[0], key, time.time()))
        wiki.save_note(con, rel, text)
        wiki.log(con, "collezione", "%s «%s» (%d elementi)" % ("aggiornata" if old else "nuova",
                                                              folder.split(":", 1)[1], len(members)), rel)
        written += 1
    if written:
        wiki.write_index(con)
        wiki.HOOKS["resolve_links"]()
    return written


# ---------------------------------------------------------------- pulizia all'avvio

def backfill_textlen(con):
    if not con.execute("SELECT 1 FROM items WHERE textlen IS NULL AND kind IN (%s) LIMIT 1"
                       % ",".join("?" * len(TEXT_KINDS)), TEXT_KINDS).fetchone():
        return
    log.info("wiki: calcolo quanto testo hanno i file (una volta sola)…")
    lens = {}
    for iid, n in con.execute("SELECT id, length(trim(body)) FROM items_fts"):  # una lettura sola: id non ha indice
        lens[iid] = n or 0
    todo = [r[0] for r in con.execute("SELECT id FROM items WHERE textlen IS NULL AND (enriched=1 OR kind='note')")]
    for i in range(0, len(todo), 2000):
        with db.writing(con):
            con.executemany("UPDATE items SET textlen=? WHERE id=?", [(lens.get(x, 0), x) for x in todo[i:i + 2000]])


def trash_page(con, rel, why):
    """Sposta una pagina generata nel cestino del vault e la toglie dall'indice."""
    p = os.path.join(VAULT_ROOT, rel)
    if os.path.exists(p):
        dest = os.path.join(VAULT_ROOT, ".trash", time.strftime("%Y%m%d-%H%M%S"), rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        os.replace(p, dest)
    iid = "n:" + rel
    with db.writing(con):
        for sql in ("DELETE FROM items WHERE id=?", "DELETE FROM items_fts WHERE id=?", "DELETE FROM links WHERE src=?",
                    "DELETE FROM tags WHERE id=? AND origin='note'", "DELETE FROM props WHERE id=? AND origin='note'",
                    "DELETE FROM tasks WHERE id=?"):
            con.execute(sql, (iid,))
    wiki.log(con, "cestino", why, rel)


def merge_entity(con, loser, keeper):
    """Tutto quello che era di `loser` passa a `keeper`. La pagina di loser (se c'è) va nel cestino."""
    page = con.execute("SELECT * FROM wiki_pages WHERE entity=?", (loser,)).fetchone()
    kp = con.execute("SELECT * FROM wiki_pages WHERE entity=?", (keeper,)).fetchone()
    if page and page["slug"] and page["title"] and not wiki.touchable(wiki.page_rel(page["slug"])):
        return False  # pagina bloccata o scritta a mano: non la tocco
    with db.writing(con):
        con.execute("INSERT OR IGNORE INTO ai_entities(id, entity) SELECT id, ? FROM ai_entities WHERE entity=?",
                    (keeper, loser))
        con.execute("DELETE FROM ai_entities WHERE entity=?", (loser,))
        con.execute("DELETE FROM wiki_sources WHERE entity=?", (loser,))  # le sue fonti diventano nuove per keeper
        con.execute("DELETE FROM wiki_pages WHERE entity=?", (loser,))
        con.execute("DELETE FROM wiki_skip WHERE entity=?", (loser,))
        con.execute("INSERT OR REPLACE INTO entity_alias(alias, entity) VALUES(?,?)", (loser, keeper))
        con.execute("UPDATE entity_alias SET entity=? WHERE entity=?", (keeper, loser))
        if kp and page and page["title"]:  # il vecchio titolo diventa un alias della pagina che resta
            alias = list(dict.fromkeys(wiki.jl(kp["alias"]) + [page["title"]]))[:10]
            con.execute("UPDATE wiki_pages SET alias=? WHERE entity=?", (json.dumps(alias), keeper))
    ENTITY_ALIAS[loser] = keeper
    for k, v in list(ENTITY_ALIAS.items()):
        if v == loser:
            ENTITY_ALIAS[k] = keeper
    if page and page["slug"] and page["title"]:
        trash_page(con, wiki.page_rel(page["slug"]), "doppione: «%s» unita a «%s»" % (page["title"], keeper))
    return True


def file_count(con, entity):
    return con.execute("SELECT count(*) FROM ai_entities WHERE entity=?", (entity,)).fetchone()[0]


def source_count(con, entity):
    return con.execute("SELECT count(*) FROM wiki_sources WHERE entity=?", (entity,)).fetchone()[0]


def dedupe(con):
    merged = 0
    # 1) stesse parole (dopo la nuova normalizzazione), in qualunque ordine
    groups = collections.defaultdict(list)
    for (e,) in con.execute("SELECT DISTINCT entity FROM ai_entities"):
        groups[entity_key(e)].append(e)
    has_page = {r[0] for r in con.execute("SELECT entity FROM wiki_pages WHERE title<>''")}
    for key, ents in groups.items():
        if not key:  # numerazioni («volume 1»): non sono argomenti
            for e in ents:
                with db.writing(con):
                    con.execute("DELETE FROM ai_entities WHERE entity=?", (e,))
            continue
        if len(ents) == 1:
            continue
        # resta quella con la pagina, poi quella nei più file
        ents.sort(key=lambda e: (e not in has_page, -file_count(con, e), -source_count(con, e), e))
        keeper = ents[0]
        for e in ents:
            if e != keeper and merge_entity(con, e, keeper):
                merged += 1
    # 2) il nome di una pagina è l'alias di un'altra (es. «Susanna» dentro «Susanna Kayed»)
    pages = {r["entity"]: r for r in con.execute("SELECT entity, title, alias FROM wiki_pages WHERE locked=0 AND title<>''")}
    by_key = {entity_key(e): e for e in pages}
    for e, r in list(pages.items()):
        if e not in pages:
            continue
        for a in wiki.jl(r["alias"]) + [r["title"]]:
            other = by_key.get(entity_key(a))
            if not other or other == e or other not in pages or len(entity_key(a)) < 4:
                continue
            a_n, b_n = file_count(con, e), file_count(con, other)
            keeper, loser = (e, other) if a_n >= b_n else (other, e)
            if merge_entity(con, loser, keeper):
                merged += 1
                pages.pop(loser, None)
            if loser == e:
                break
    return merged


def prune(con):
    gone = 0
    for p in con.execute("SELECT entity, slug, title FROM wiki_pages WHERE locked=0 AND title<>''").fetchall():
        ok, n, folder = judge(con, p["entity"])
        if ok or not p["slug"] or not wiki.touchable(wiki.page_rel(p["slug"])):
            continue
        with db.writing(con):
            con.execute("DELETE FROM wiki_pages WHERE entity=?", (p["entity"],))
            con.execute("DELETE FROM wiki_sources WHERE entity=?", (p["entity"],))
        skip(con, p["entity"], pick_count(con, p["entity"]), folder, p["title"])
        trash_page(con, wiki.page_rel(p["slug"]), "«%s»: solo nomi di file, %s" % (
            p["title"], "va nella collezione" if folder else "troppo poco testo"))
        gone += 1
    return gone


def rerender_all(con):
    """Riscrive pagine e temi dal database: toglie i link alle pagine sparite, aggiunge «Temi»."""
    from . import wikiq
    for t in con.execute("SELECT * FROM wiki_themes WHERE locked=0").fetchall():
        members = [m for m in wiki.jl(t["members"])
                   if con.execute("SELECT 1 FROM wiki_pages WHERE entity=? AND title<>''", (m,)).fetchone()]
        with db.writing(con):
            con.execute("UPDATE wiki_themes SET members=? WHERE slug=?", (json.dumps(members), t["slug"]))
        rel = wikiq.theme_rel(t["slug"])
        if wiki.touchable(rel):
            wiki.save_note(con, rel, wikiq.render_theme(con, dict(t), members))
    for (e,) in con.execute("SELECT entity FROM wiki_pages WHERE locked=0 AND title<>''").fetchall():
        wiki.rerender(con, e)


def load_aliases(con):
    ENTITY_ALIAS.clear()
    ENTITY_ALIAS.update({r[0]: r[1] for r in con.execute("SELECT alias, entity FROM entity_alias")})


def startup_cleanup():
    con = db.connect()
    try:
        load_aliases(con)
        backfill_textlen(con)
        STATE["ready"] = True
        if get_state(con, "cleanup") == CLEANUP_VERSION:
            STATE["coll_dirty"] = True
            return
        log.info("wiki: unisco i doppioni e tolgo le pagine che non passano la regola…")
        merged = dedupe(con)
        gone = prune(con)
        rebuild_collections(con, force=True)
        rerender_all(con)
        # i temi si rifanno guardando la wiki ripulita (es. Gohonzon e Soka Gakkai sotto «Buddismo»)
        with db.writing(con):
            con.execute("DELETE FROM wiki_theme_seen")
        wiki.write_index(con)
        wiki.log(con, "pulizia", "regola nuova: %d doppioni uniti, %d pagine nel cestino" % (merged, gone), "—")
        wiki.HOOKS["resolve_links"]()
        set_state(con, "cleanup", CLEANUP_VERSION)
        log.info("wiki: %d doppioni uniti, %d pagine nel cestino", merged, gone)
    except Exception:  # noqa: BLE001
        log.exception("wiki: pulizia non riuscita (riprovo al prossimo avvio)")
        STATE["ready"] = True
    finally:
        con.close()


def start():
    threading.Thread(target=startup_cleanup, daemon=True, name="wiki-cleanup").start()
