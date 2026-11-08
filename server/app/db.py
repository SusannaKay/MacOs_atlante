"""Database SQLite dell'indice (con ricerca full-text FTS5)."""
import os
import sqlite3
import threading
from contextlib import contextmanager

from .config import DATA_DIR

DB_PATH = os.path.join(DATA_DIR, "atlante.db")
WRITE_LOCK = threading.RLock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
    id        TEXT PRIMARY KEY,      -- 's:<rel>' file del server, 'n:<rel>' file del vault
    src       TEXT NOT NULL,         -- 's' oppure 'n'
    rel       TEXT NOT NULL,
    name      TEXT NOT NULL,
    stem      TEXT NOT NULL,         -- nome senza estensione (minuscolo)
    parent    TEXT,                  -- id della cartella che lo contiene
    is_dir    INTEGER NOT NULL DEFAULT 0,
    ext       TEXT,
    kind      TEXT,
    size      INTEGER,
    mtime     REAL,
    year      INTEGER,
    year_src  TEXT,
    meta_year INTEGER,               -- anno dai metadati (PDF/EXIF/frontmatter)
    seen      INTEGER,
    enriched  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS items_parent ON items(parent);
CREATE INDEX IF NOT EXISTS items_stem ON items(stem);
CREATE INDEX IF NOT EXISTS items_year ON items(year);
CREATE INDEX IF NOT EXISTS items_enriched ON items(enriched);

CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
    id UNINDEXED, name, rel, body, tokenize = 'unicode61 remove_diacritics 2'
);

-- tag: origin 'user' (messi dall'app su un file) o 'note' (scritti dentro una nota)
CREATE TABLE IF NOT EXISTS tags (
    id TEXT NOT NULL, tag TEXT NOT NULL, origin TEXT NOT NULL,
    PRIMARY KEY (id, tag, origin)
);
CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag);

CREATE TABLE IF NOT EXISTS props (
    id TEXT NOT NULL, key TEXT NOT NULL, value TEXT, origin TEXT NOT NULL,
    PRIMARY KEY (id, key, origin)
);
CREATE INDEX IF NOT EXISTS props_key ON props(key);

CREATE TABLE IF NOT EXISTS links (
    src TEXT NOT NULL, target_raw TEXT NOT NULL, target_id TEXT,
    kind TEXT NOT NULL DEFAULT 'link'           -- 'link' oppure 'embed'
);
CREATE INDEX IF NOT EXISTS links_src ON links(src);
CREATE INDEX IF NOT EXISTS links_target ON links(target_id);

CREATE TABLE IF NOT EXISTS bookmarks (
    id TEXT PRIMARY KEY, created REAL
);

CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT);

-- analisi con l'LLM (fatta dall'app sul Mac con Ollama)
CREATE TABLE IF NOT EXISTS ai_profiles (
    id TEXT PRIMARY KEY, summary TEXT, model TEXT, created REAL, mtime REAL
);
CREATE TABLE IF NOT EXISTS ai_entities (id TEXT NOT NULL, entity TEXT NOT NULL, PRIMARY KEY (id, entity));
CREATE INDEX IF NOT EXISTS ai_entities_entity ON ai_entities(entity);
CREATE TABLE IF NOT EXISTS ai_match (id TEXT PRIMARY KEY, model TEXT, created REAL);
-- collegamenti proposti: a < b, una sola proposta per coppia
CREATE TABLE IF NOT EXISTS suggestions (
    sid INTEGER PRIMARY KEY AUTOINCREMENT,
    a TEXT NOT NULL, b TEXT NOT NULL,
    reason TEXT, confidence REAL, model TEXT,
    status TEXT NOT NULL DEFAULT 'pending',   -- pending | accepted | rejected
    created REAL, decided REAL,
    UNIQUE (a, b)
);
CREATE INDEX IF NOT EXISTS suggestions_a ON suggestions(a);
CREATE INDEX IF NOT EXISTS suggestions_b ON suggestions(b);
CREATE INDEX IF NOT EXISTS suggestions_status ON suggestions(status);

-- wiki compilata dall'LLM: una pagina per entità, in vault/wiki/entita/<slug>.md
CREATE TABLE IF NOT EXISTS wiki_pages (
    entity TEXT PRIMARY KEY, slug TEXT UNIQUE, title TEXT NOT NULL DEFAULT '',
    descrizione TEXT, sintesi TEXT, dettagli TEXT, verificare TEXT,
    alias TEXT, tags TEXT, related TEXT,           -- liste in JSON
    model TEXT, created REAL, updated REAL,
    locked INTEGER NOT NULL DEFAULT 0             -- 1: da non toccare (bloccata, scritta a mano, scartata)
);
-- quali file sono già confluiti in quale pagina
CREATE TABLE IF NOT EXISTS wiki_sources (
    entity TEXT NOT NULL, id TEXT NOT NULL, added REAL, PRIMARY KEY (entity, id)
);
CREATE INDEX IF NOT EXISTS wiki_sources_id ON wiki_sources(id);

-- temi: pagine che raggruppano entità che compaiono negli stessi file (vault/wiki/temi/<slug>.md)
CREATE TABLE IF NOT EXISTS wiki_themes (
    slug TEXT PRIMARY KEY, title TEXT NOT NULL, descrizione TEXT, sintesi TEXT,
    members TEXT, model TEXT, created REAL, updated REAL, locked INTEGER NOT NULL DEFAULT 0
);
-- entità che non meritano una pagina (poche fonti con testo, tutte nello stesso posto):
-- finiscono nelle pagine di collezione; si ricontrollano quando arrivano nuove fonti
CREATE TABLE IF NOT EXISTS wiki_skip (
    entity TEXT PRIMARY KEY, sources INTEGER NOT NULL DEFAULT 0, title TEXT, folder TEXT, at REAL
);
-- doppioni uniti: «kayed susanna» -> «susanna kayed»
CREATE TABLE IF NOT EXISTS entity_alias (alias TEXT PRIMARY KEY, entity TEXT NOT NULL);
-- piccoli stati della wiki (es. pulizia già fatta)
CREATE TABLE IF NOT EXISTS wiki_state (key TEXT PRIMARY KEY, value TEXT);
-- pagine di collezione: una per cartella piena di file "solo nome" (ROM, film, ebook…)
CREATE TABLE IF NOT EXISTS wiki_collections (
    slug TEXT PRIMARY KEY, folder TEXT UNIQUE, title TEXT, members TEXT, updated REAL
);
-- entità già considerate come centro di un tema (o già finite in un tema)
CREATE TABLE IF NOT EXISTS wiki_theme_seen (entity TEXT PRIMARY KEY, at REAL);

-- todo delle note: "- [ ] cosa 📅 2026-10-25" (line = riga nel file, da 0)
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT NOT NULL, line INTEGER NOT NULL, text TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0, due TEXT,
    PRIMARY KEY (id, line)
);
CREATE INDEX IF NOT EXISTS tasks_due ON tasks(due);
"""


def connect() -> sqlite3.Connection:
    os.makedirs(DATA_DIR, exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    con.execute("PRAGMA busy_timeout=30000")
    con.execute("PRAGMA foreign_keys=OFF")
    return con


def init():
    con = connect()
    with WRITE_LOCK:
        con.executescript(SCHEMA)
        cols = {r[1] for r in con.execute("PRAGMA table_info(items)")}
        if "textlen" not in cols:  # lunghezza del testo estratto: serve alla wiki per distinguere i file "solo nome"
            con.execute("ALTER TABLE items ADD COLUMN textlen INTEGER")
        con.commit()
    con.close()


@contextmanager
def writing(con):
    """Una scrittura alla volta, con commit/rollback automatico."""
    with WRITE_LOCK:
        try:
            yield con
            con.commit()
        except Exception:
            con.rollback()
            raise


def get_state(con, k, default=None):
    r = con.execute("SELECT v FROM state WHERE k=?", (k,)).fetchone()
    return r["v"] if r else default


def set_state(con, k, v):
    con.execute("INSERT INTO state(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, str(v)))
