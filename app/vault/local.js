// Atlante — "motore locale": risponde alle stesse richieste del motore sul server, ma leggendo e
// scrivendo la copia del vault sul Mac. Si usa quando il server non è raggiungibile.
const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const { DEFAULT_TEMPLATE } = require("./template");

const KINDS = {
  text: "txt log csv tsv json yaml yml toml ini conf xml srt vtt py js ts c h cpp sh html css sql go rs java rb php",
  pdf: "pdf",
  image: "jpg jpeg png gif webp bmp tif tiff heic heif svg avif",
  video: "mp4 mkv avi mov m4v webm wmv flv mpg mpeg m2ts",
  audio: "mp3 flac m4a aac ogg opus wav wma m4b",
  ebook: "epub mobi azw azw3 fb2 djvu cbz cbr cb7",
  doc: "doc docx odt rtf pages xls xlsx ods numbers ppt pptx odp key",
  archive: "zip rar 7z tar gz tgz bz2 xz zst iso dmg",
};
const EXT_KIND = {};
for (const [k, list] of Object.entries(KINDS)) list.split(" ").forEach((e) => { EXT_KIND[e] = k; });

const FM_RE = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;
const FENCE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const WIKI_RE = /(!?)\[\[([^[\]\n]+?)\]\]/g;
const TAG_RE = /(?<![\p{L}\p{N}_/#&])#([\p{L}_][\p{L}\p{N}_/-]*|\d+[\p{L}_][\p{L}\p{N}_/-]*)/gu;
const TASK_RE = /^(\s*[-*+]\s+\[)( |x|X)(\]\s+)(.*)$/;
const DUE_RE = /\s*📅\s*(\d{4}-\d{2}-\d{2})/;
const DUE_RE_G = /\s*📅\s*(\d{4}-\d{2}-\d{2})/g;
const FENCE_LINE_RE = /^\s*(```|~~~)/;
const REL_DUE_RE = /📅\s*([+-]?\d{1,3})(?![\d-])/g;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SKIP_TOP = new Set([".trash", ".atlante"]);
const EVENT_DIR = "eventi";
const TEMPLATE_REL = "_modelli/evento.md";
const INBOX_REL = "Da fare.md";
const INBOX_HEAD = "# Da fare\n\nTodo veloci, senza evento. Le aggiunge l'Agenda; puoi scriverle anche a mano.\n\n";
const AGENDA_SKIP = ["_modelli/", ".trash/", "wiki/"];

class LocalError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const offline = (what) => new LocalError(503, `Sei offline: ${what} è disponibile solo quando il server è raggiungibile.`);

// ------------------------------------------------------------------ note

function splitName(name) {
  const i = name.lastIndexOf(".");
  if (i <= 0) return { stem: name.toLowerCase(), ext: "" };
  return { stem: name.slice(0, i).toLowerCase(), ext: name.slice(i + 1).toLowerCase() };
}

function isoDay(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function propValue(v) {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(String).join(", ");
  if (v instanceof Date) return isNaN(v) ? "" : v.toISOString().slice(0, 10);
  return String(v);
}

function splitFrontmatter(text) {
  const m = FM_RE.exec(text);
  if (!m) return { fm: {}, body: text };
  let fm = {};
  try {
    fm = YAML.parse(m[1]) || {};
    if (typeof fm !== "object" || Array.isArray(fm)) fm = {};
  } catch { fm = {}; }
  return { fm, body: text.slice(m[0].length) };
}

function linkTarget(raw) {
  return raw.split("|", 1)[0].split("#", 1)[0].trim();
}

function parseTasks(text) {
  const out = [];
  let fence = false;
  let inFm = text.startsWith("---");
  text.split("\n").forEach((line, n) => {
    if (inFm) { if (n > 0 && line.trim() === "---") inFm = false; return; }
    if (FENCE_LINE_RE.test(line)) { fence = !fence; return; }
    if (fence) return;
    const m = TASK_RE.exec(line);
    if (!m) return;
    const d = DUE_RE.exec(m[4]);
    const label = m[4].replace(DUE_RE_G, "").trim();
    if (label) out.push({ line: n, done: m[2].toLowerCase() === "x", text: label.slice(0, 500), due: d ? d[1] : null });
  });
  return out;
}

function toggleTask(text, line, done) {
  const lines = text.split("\n");
  if (line < 0 || line >= lines.length) return null;
  const m = TASK_RE.exec(lines[line]);
  if (!m) return null;
  lines[line] = m[1] + (done ? "x" : " ") + m[3] + m[4];
  return lines.join("\n");
}

function parseNote(text) {
  const { fm, body } = splitFrontmatter(text);
  const clean = body.replace(FENCE_RE, " ").replace(INLINE_CODE_RE, " ");
  const tags = new Set();
  const fmTags = fm.tags ?? fm.tag;
  (Array.isArray(fmTags) ? fmTags : String(fmTags ?? "").split(/[,\s]+/))
    .map((t) => String(t).replace(/^#/, "").trim()).filter(Boolean).forEach((t) => tags.add(t.toLowerCase()));
  for (const m of clean.matchAll(TAG_RE)) tags.add(m[1].toLowerCase().replace(/\/$/, ""));
  const links = [];
  for (const m of clean.matchAll(WIKI_RE)) {
    const t = linkTarget(m[2]);
    if (t) links.push({ raw: t, kind: m[1] ? "embed" : "link" });
  }
  const props = {};
  for (const [k, v] of Object.entries(fm)) {
    if (["tags", "tag"].includes(String(k).toLowerCase())) continue;
    props[k] = propValue(v);
  }
  return { tags: [...tags].sort(), links, props, body, tasks: parseTasks(text) };
}

// ------------------------------------------------------------------ motore locale

class LocalVault {
  constructor(root) {
    this.root = root;
    this.cache = new Map(); // rel -> { mtime, info }
  }

  abs(rel) {
    const p = path.resolve(this.root, rel);
    if (p !== this.root && !p.startsWith(this.root + path.sep)) throw new LocalError(400, "percorso non valido");
    return p;
  }

  relOf(id) {
    if (!id || !id.startsWith("n:")) {
      if (id?.startsWith("s:")) throw offline("il file del server");
      throw new LocalError(400, "id non valido");
    }
    return id.slice(2);
  }

  item(rel, st) {
    st = st || fs.statSync(this.abs(rel));
    const name = rel ? path.posix.basename(rel) : "";
    const isDir = st.isDirectory();
    const { ext } = isDir ? { ext: "" } : splitName(name);
    const parent = rel.includes("/") ? "n:" + rel.slice(0, rel.lastIndexOf("/")) : "n:";
    const kind = isDir ? "dir" : ["md", "markdown"].includes(ext) ? "note" : EXT_KIND[ext] || "other";
    return {
      id: "n:" + rel, src: "n", rel, name, parent, is_dir: isDir, ext, kind,
      size: isDir ? 0 : st.size, mtime: st.mtimeMs / 1000, year: null, year_src: null,
    };
  }

  /** Tutti i file del vault (rel relativi, con "/"), escluse le cartelle nascoste. */
  walk(dir = "", out = []) {
    let entries = [];
    try { entries = fs.readdirSync(this.abs(dir), { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      if (e.name.startsWith(".") || (dir === "" && SKIP_TOP.has(e.name))) continue;
      const rel = dir ? dir + "/" + e.name : e.name;
      if (e.isDirectory()) this.walk(rel, out);
      else if (e.isFile() && !e.name.endsWith(".atlante-tmp")) out.push(rel);
    }
    return out;
  }

  notes() {
    const out = [];
    for (const rel of this.walk()) {
      if (!/\.(md|markdown)$/i.test(rel)) continue;
      let st;
      try { st = fs.statSync(this.abs(rel)); } catch { continue; }
      let c = this.cache.get(rel);
      if (!c || c.mtime !== st.mtimeMs) {
        const text = fs.readFileSync(this.abs(rel), "utf8");
        c = { mtime: st.mtimeMs, info: parseNote(text), st };
        this.cache.set(rel, c);
      }
      out.push({ rel, st, info: c.info });
    }
    return out;
  }

  resolve(target, all) {
    const t = target.trim();
    if (t.startsWith("/")) {
      const rel = t.replace(/^\/+/, "");
      const { ext } = splitName(path.posix.basename(rel));
      return { id: "s:" + rel, name: path.posix.basename(rel), kind: EXT_KIND[ext] || "other" };
    }
    const lower = t.toLowerCase();
    const byRel = all.find((n) => n.rel.toLowerCase() === lower || n.rel.toLowerCase() === lower + ".md");
    if (byRel) return { id: "n:" + byRel.rel, name: path.posix.basename(byRel.rel), kind: "note" };
    const base = lower.split("/").pop().replace(/\.md$/, "");
    const byStem = all.filter((n) => path.posix.basename(n.rel).toLowerCase().replace(/\.(md|markdown)$/, "") === base)
      .sort((a, b) => a.rel.length - b.rel.length)[0];
    if (byStem) return { id: "n:" + byStem.rel, name: path.posix.basename(byStem.rel), kind: "note" };
    for (const rel of this.walk()) {
      if (path.posix.basename(rel).toLowerCase() === lower.split("/").pop()) {
        return { id: "n:" + rel, name: path.posix.basename(rel), kind: this.item(rel).kind };
      }
    }
    return null;
  }

  write(rel, text) {
    const p = this.abs(rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + ".atlante-tmp";
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, p);
    return fs.statSync(p).mtimeMs / 1000;
  }

  read(rel) {
    try { return fs.readFileSync(this.abs(rel), "utf8"); } catch { throw new LocalError(404, "nota non trovata nella copia sul Mac"); }
  }

  // ---------------------------------------------------------------- richieste

  handle(p, method, params, body, sync) {
    const route = `${method} ${p}`;
    switch (route) {
      case "GET /status": return { version: "copia sul Mac", items: { s: 0, n: this.walk().length }, offline: true };
      case "GET /health": return { ok: true, version: "copia sul Mac" };
      case "GET /tree": return this.tree(params.id || "s:");
      case "GET /item": return this.itemFull(params.id);
      case "GET /note": return this.noteGet(params.id);
      case "PUT /note": return this.notePut(body, sync);
      case "POST /note/create": return this.noteCreate(body);
      case "POST /folder/create": {
        const rel = this.relOf(body.id.startsWith("n:") ? body.id : "n:" + body.id).replace(/^\/+|\/+$/g, "");
        fs.mkdirSync(this.abs(rel), { recursive: true });
        return { id: "n:" + rel };
      }
      case "GET /quick": return this.quick(params.q || "", Number(params.limit) || 30);
      case "GET /search": return this.search(params);
      case "GET /tags": return this.tags();
      case "GET /props/keys": return this.propKeys();
      case "GET /bookmarks": return [];
      case "GET /unlinked": return [];
      case "GET /suggestions": return { total: 0, items: [] };
      case "GET /agenda": return this.agenda(params.start, params.end);
      case "GET /tasks": return this.openTasks(params.done === "true");
      case "POST /task/toggle": return this.toggle(body);
      case "POST /task/add": return this.taskAdd(body);
      case "POST /event/create": return this.eventCreate(body);
      case "POST /note/rename": return this.rename(body);
      case "POST /note/delete": return this.remove(body);
      case "POST /item/tags": case "POST /item/props":
        if (String(body.id || "").startsWith("n:")) throw offline("modificare tag e proprietà dal pannello (scrivili nel frontmatter della nota)");
        throw offline("il file del server");
      case "GET /graph": case "GET /years": case "GET /years/items": throw offline("il grafo");
      default: throw offline("questa funzione");
    }
  }

  tree(id) {
    if (id === "s:" || id.startsWith("s:")) return [];
    const rel = id === "n:" ? "" : this.relOf(id);
    let entries = [];
    try { entries = fs.readdirSync(this.abs(rel), { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name.endsWith(".atlante-tmp") || (rel === "" && SKIP_TOP.has(e.name))) continue;
      const r = rel ? rel + "/" + e.name : e.name;
      try {
        const it = this.item(r);
        if (it.is_dir) it.children = fs.readdirSync(this.abs(r)).filter((n) => !n.startsWith(".")).length;
        out.push(it);
      } catch { /* niente */ }
    }
    return out.sort((a, b) => (b.is_dir - a.is_dir) || a.name.localeCompare(b.name, "it", { sensitivity: "base" }));
  }

  itemFull(id) {
    const rel = this.relOf(id);
    let it;
    try { it = this.item(rel); } catch { throw new LocalError(404, "elemento non trovato nella copia sul Mac"); }
    Object.assign(it, { tags: [], props: [], bookmarked: false, outgoing: [], backlinks: [],
      ai_summary: null, ai_entities: [], related: [], suggested: [] });
    if (it.kind !== "note" && !it.is_dir) return it;
    const all = this.notes();
    const me = all.find((n) => n.rel === rel);
    if (me) {
      it.tags = me.info.tags.map((tag) => ({ tag, origin: "note" }));
      it.props = Object.entries(me.info.props).map(([key, value]) => ({ key, value, origin: "note" }));
      it.outgoing = me.info.links.map((l) => {
        const r = this.resolve(l.raw, all);
        return { target_raw: l.raw, target_id: r ? r.id : null, kind: l.kind, name: r ? r.name : null, target_kind: r ? r.kind : null };
      });
    }
    for (const n of all) {
      if (n.rel === rel) continue;
      if (n.info.links.some((l) => this.resolve(l.raw, all)?.id === id)) {
        it.backlinks.push({ id: "n:" + n.rel, name: path.posix.basename(n.rel), kind: "note" });
      }
    }
    return it;
  }

  noteGet(id) {
    const rel = this.relOf(id);
    const text = this.read(rel);
    return { id, text, mtime: fs.statSync(this.abs(rel)).mtimeMs / 1000 };
  }

  notePut({ id, text, base_mtime: base }, sync) {
    const rel = this.relOf(id);
    const p = this.abs(rel);
    if (base != null && fs.existsSync(p)) {
      const cur = fs.statSync(p).mtimeMs / 1000;
      // vale anche la data del server, se la copia sul Mac è ancora quella scaricata
      const ok = Math.abs(cur - base) < 1e-3 || sync?.isPristine(rel, base);
      if (!ok) throw new LocalError(409, "la nota è stata modificata altrove");
    }
    const mtime = this.write(rel, text);
    return { id, mtime };
  }

  noteCreate({ folder = "", name = "", text = "" }) {
    folder = String(folder).replace(/^\/+|\/+$/g, "");
    let n = String(name).replace(/[\\/:*?"<>|#^[\]]/g, " ").trim() || "Senza titolo";
    if (n.toLowerCase().endsWith(".md")) n = n.slice(0, -3);
    const base = (folder ? folder + "/" : "") + n;
    let rel = base + ".md";
    for (let i = 2; fs.existsSync(this.abs(rel)); i++) rel = `${base} ${i}.md`;
    this.write(rel, text || "");
    return { id: "n:" + rel };
  }

  /** Rinomina o sposta una nota o una cartella e aggiorna i [[link]] delle altre note.
   *  Al ritorno online la sincronizzazione lo vede come «vecchio tolto, nuovo aggiunto». */
  rename({ id, new_rel: newRel }) {
    const oldRel = this.relOf(id);
    let it;
    try { it = this.item(oldRel); } catch { throw new LocalError(404, "elemento non trovato nella copia sul Mac"); }
    newRel = String(newRel || "").trim().replace(/^\/+|\/+$/g, "");
    if (!newRel || newRel.split("/").some((p) => !p || p === "." || p === "..")) throw new LocalError(400, "percorso non valido");
    if (it.kind === "note" && !/\.md$/i.test(newRel)) newRel += ".md";
    if (fs.existsSync(this.abs(newRel))) throw new LocalError(409, "esiste già un elemento con questo nome");
    const all = this.notes();
    const moved = it.is_dir ? all.filter((n) => n.rel.startsWith(oldRel + "/")).map((n) => n.rel) : [oldRel];
    const movedIds = new Set(moved.map((r) => "n:" + r));
    // chi punta agli elementi spostati, e con quali parole
    const referers = [];
    for (const n of all) {
      const raws = n.info.links.filter((l) => movedIds.has(this.resolve(l.raw, all)?.id))
        .map((l) => ({ raw: l.raw, target: this.resolve(l.raw, all).id }));
      if (raws.length) referers.push({ rel: n.rel, raws });
    }
    fs.mkdirSync(path.dirname(this.abs(newRel)), { recursive: true });
    fs.renameSync(this.abs(oldRel), this.abs(newRel));
    const mapRel = (r) => (r === oldRel ? newRel : r.startsWith(oldRel + "/") ? newRel + r.slice(oldRel.length) : r);
    const after = this.notes();
    const linkName = (rel) => {
      const stem = path.posix.basename(rel).replace(/\.(md|markdown)$/i, "");
      const dup = after.filter((n) => path.posix.basename(n.rel).replace(/\.(md|markdown)$/i, "").toLowerCase() === stem.toLowerCase()).length;
      return dup <= 1 ? stem : rel.replace(/\.(md|markdown)$/i, "");
    };
    for (const ref of referers) {
      const rel = mapRel(ref.rel);
      let text = this.read(rel);
      const before = text;
      for (const { raw, target } of ref.raws) {
        const to = linkName(mapRel(target.slice(2)));
        const esc = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        text = text.replace(new RegExp("(!?)\\[\\[" + esc + "((?:#[^\\]|]*)?(?:\\|[^\\]]*)?)\\]\\]", "g"), (_m, bang, rest) => `${bang}[[${to}${rest}]]`);
      }
      if (text !== before) this.write(rel, text);
    }
    return { id: "n:" + newRel };
  }

  /** Sposta nel cestino della copia sul Mac; al ritorno online finisce nel cestino del server. */
  remove({ id }) {
    const rel = this.relOf(id);
    if (!fs.existsSync(this.abs(rel))) throw new LocalError(404, "elemento non trovato nella copia sul Mac");
    const d = new Date();
    const stamp = d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const dest = path.join(this.root, ".trash", stamp, path.posix.basename(rel));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(this.abs(rel), dest);
    return { ok: true };
  }

  quick(q, limit) {
    q = q.trim().toLowerCase();
    const files = this.walk();
    const items = (q ? files.filter((r) => path.posix.basename(r).toLowerCase().includes(q)) : files.filter((r) => r.endsWith(".md")))
      .map((r) => this.item(r));
    items.sort((a, b) => (q
      ? (b.kind === "note") - (a.kind === "note") || b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q) || a.name.length - b.name.length
      : b.mtime - a.mtime));
    return items.slice(0, limit);
  }

  search({ q = "", tag = "", kind = "", src = "", limit = 60, offset = 0 }) {
    if (src === "s") return { results: [], total: 0 };
    q = String(q).trim().toLowerCase();
    tag = String(tag).trim().toLowerCase().replace(/^#/, "");
    const words = q.split(/\s+/).filter(Boolean);
    const hits = [];
    for (const n of this.notes()) {
      if (kind && kind !== "note") continue;
      if (tag && !n.info.tags.some((t) => t === tag || t.startsWith(tag + "/"))) continue;
      const hay = (n.rel + "\n" + n.info.body).toLowerCase();
      if (words.length && !words.every((w) => hay.includes(w))) continue;
      const it = this.item(n.rel, n.st);
      if (words.length) {
        const body = n.info.body;
        const i = body.toLowerCase().indexOf(words[0]);
        if (i >= 0) {
          const a = Math.max(0, i - 60);
          it.snippet = (a ? "…" : "") + body.slice(a, i) + "«" + body.slice(i, i + words[0].length) + "»" + body.slice(i + words[0].length, i + 120) + "…";
        }
      }
      hits.push(it);
    }
    hits.sort((a, b) => b.mtime - a.mtime);
    return { results: hits.slice(Number(offset) || 0, (Number(offset) || 0) + (Number(limit) || 60)), total: hits.length };
  }

  tags() {
    const count = new Map();
    for (const n of this.notes()) for (const t of n.info.tags) count.set(t, (count.get(t) || 0) + 1);
    return [...count].sort((a, b) => a[0].localeCompare(b[0])).map(([tag, c]) => ({ tag, count: c }));
  }

  propKeys() {
    const count = new Map();
    for (const n of this.notes()) for (const k of Object.keys(n.info.props)) count.set(k, (count.get(k) || 0) + 1);
    return [...count].sort((a, b) => b[1] - a[1]).map(([key, c]) => ({ key, count: c }));
  }

  // ---------------------------------------------------------------- agenda

  events(all) {
    const out = {};
    for (const n of all) {
      if (AGENDA_SKIP.some((s) => n.rel.startsWith(s))) continue;
      const p = Object.fromEntries(Object.entries(n.info.props).map(([k, v]) => [k.toLowerCase(), v]));
      if (String(p.tipo || "").trim().toLowerCase() !== "evento") continue;
      const date = String(p.data || "").trim().slice(0, 10);
      if (!DATE_RE.test(date)) continue;
      const name = path.posix.basename(n.rel).replace(/\.(md|markdown)$/i, "");
      const done = n.info.tasks.filter((t) => t.done).length;
      out["n:" + n.rel] = {
        id: "n:" + n.rel, title: String(p.titolo || "").trim() || name.replace(/^\d{4}-\d{2}-\d{2}\s+/, "") || name,
        date, ora: String(p.ora || "").trim(), luogo: String(p.luogo || "").trim(),
        stato: String(p.stato || "").trim().toLowerCase(), done, total: n.info.tasks.length,
      };
    }
    return out;
  }

  allTasks(all, events) {
    const out = [];
    for (const n of all) {
      if (AGENDA_SKIP.some((s) => n.rel.startsWith(s))) continue;
      const id = "n:" + n.rel;
      const ev = events[id];
      for (const t of n.info.tasks) {
        const due = t.due || (ev ? ev.date : null);
        if (!due) continue;
        out.push({ id, line: t.line, text: t.text, done: t.done, due, explicit_due: Boolean(t.due),
          note: ev ? ev.title : path.posix.basename(n.rel).replace(/\.(md|markdown)$/i, "").replace(/^\d{4}-\d{2}-\d{2}\s+/, ""),
          event: Boolean(ev), event_date: ev ? ev.date : null });
      }
    }
    return out;
  }

  agenda(start, end) {
    if (!DATE_RE.test(start || "") || !DATE_RE.test(end || "") || end < start) throw new LocalError(400, "intervallo di date non valido");
    const all = this.notes();
    const events = this.events(all);
    const evs = Object.values(events).filter((e) => e.date >= start && e.date <= end)
      .sort((a, b) => a.date.localeCompare(b.date) || a.ora.localeCompare(b.ora) || a.title.localeCompare(b.title));
    const tasks = this.allTasks(all, events).filter((t) => t.due >= start && t.due <= end)
      .sort((a, b) => a.due.localeCompare(b.due) || a.done - b.done || a.note.localeCompare(b.note) || a.line - b.line);
    return { events: evs, tasks };
  }

  openTasks(done) {
    const all = this.notes();
    const items = this.allTasks(all, this.events(all)).filter((t) => done || !t.done)
      .sort((a, b) => a.due.localeCompare(b.due) || a.note.localeCompare(b.note) || a.line - b.line);
    return { items, today: isoDay(new Date()) };
  }

  toggle({ id, line, done, text: label = "" }) {
    const rel = this.relOf(id);
    const text = this.read(rel);
    if (label) {
      const found = parseTasks(text).filter((t) => t.text === label).map((t) => t.line);
      if (!found.length) throw new LocalError(409, "la todo è cambiata nella nota: ricarica l'agenda");
      if (!found.includes(line)) line = found.reduce((a, b) => (Math.abs(b - line) < Math.abs(a - line) ? b : a));
    }
    const next = toggleTask(text, line, done);
    if (next === null) throw new LocalError(409, "la todo non è più in quella riga: ricarica l'agenda");
    return { ok: true, mtime: this.write(rel, next) };
  }

  taskAdd({ text = "", due = "" }) {
    const t = String(text).replace(/\s+/g, " ").replace(DUE_RE_G, "").trim();
    if (!t) throw new LocalError(400, "scrivi cosa c'è da fare");
    if (due && !DATE_RE.test(due)) throw new LocalError(400, "data non valida");
    const line = "- [ ] " + t.slice(0, 400) + (due ? " 📅 " + due : "");
    let cur = "";
    try { cur = fs.readFileSync(this.abs(INBOX_REL), "utf8"); } catch { /* niente */ }
    if (!cur.trim()) cur = INBOX_HEAD;
    if (!cur.endsWith("\n")) cur += "\n";
    const mtime = this.write(INBOX_REL, cur + line + "\n");
    return { id: "n:" + INBOX_REL, mtime };
  }

  eventCreate({ name = "", date = "", ora = "", luogo = "" }) {
    if (!DATE_RE.test(date)) throw new LocalError(400, "data non valida");
    const n = String(name).replace(/[\\/:*?"<>|#^[\]]/g, " ").trim() || "Evento";
    ora = String(ora).trim();
    if (ora && !/^\d{1,2}[:.]\d{2}$/.test(ora)) throw new LocalError(400, "ora non valida (es. 19:00)");
    ora = ora.replace(".", ":");
    let tpl;
    try { tpl = fs.readFileSync(this.abs(TEMPLATE_REL), "utf8"); } catch { tpl = DEFAULT_TEMPLATE; this.write(TEMPLATE_REL, tpl); }
    const [y, m, d] = date.split("-").map(Number);
    const relDue = (_all, k) => "📅 " + isoDay(new Date(y, m - 1, d + Number(k)));
    let t = tpl.replaceAll("{{titolo}}", n).replaceAll("{{data}}", date).replaceAll("{{ora}}", ora)
      .replaceAll("{{luogo}}", String(luogo).trim().replace(/"/g, "'"));
    t = t.replace(/^(ora|luogo): ""\s*\n/gm, "");
    t = t.replace(/^Le scadenze con 📅 -N.*\n(Questo è il modello.*\n)?\n?/m, "");
    t = t.split("\n").map((line) => (TASK_RE.test(line) ? line.replace(REL_DUE_RE, relDue) : line)).join("\n");
    const base = `${EVENT_DIR}/${date} ${n}`;
    let rel = base + ".md";
    for (let i = 2; fs.existsSync(this.abs(rel)); i++) rel = `${base} ${i}.md`;
    this.write(rel, t);
    return { id: "n:" + rel };
  }
}

module.exports = { LocalVault, LocalError, parseTasks, parseNote };
