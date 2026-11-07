// Viste del pannello centrale: nota, file del server, cartella.
import { api, rawUrl, thumbUrl, download, ApiError, sourceName } from "./api.js";
import { createEditor } from "./editor.js";
import { createRenderer, enhanceTasks, splitFrontmatter, withFrontmatter, linkTarget } from "./markdown.js";
import {
  h, icon, kindLabel, fmtSize, fmtDate, displayName, debounce, toast, linkFor, YEAR_SRC,
} from "./util.js";

const PREVIEW_IMG = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif"]);

function breadcrumb(item, ctx) {
  const parts = item.rel.split("/");
  const root = item.src === "n" ? "Note" : sourceName();
  const crumbs = [h("button", { class: "crumb", onclick: () => ctx.revealInTree(item.src + ":") }, root)];
  parts.slice(0, -1).forEach((p, i) => {
    const id = item.src + ":" + parts.slice(0, i + 1).join("/");
    crumbs.push(h("span", { class: "crumb-sep", "aria-hidden": "true" }, "/"),
      h("button", { class: "crumb", onclick: () => ctx.open(id) }, p));
  });
  return h("nav", { class: "breadcrumb", "aria-label": "Percorso" }, crumbs);
}

function resolverFor(item) {
  const map = new Map();
  (item?.outgoing || []).forEach((o) => {
    if (o.target_id) map.set(o.target_raw, { id: o.target_id, kind: o.target_kind, name: o.name });
  });
  return (target) => map.get(target) || null;
}

// ------------------------------------------------------------------ embed

async function renderEmbeds(root, ctx, depth = 0) {
  for (const el of root.querySelectorAll("span.embed")) {
    const id = el.dataset.id;
    const kind = el.dataset.kind;
    const target = el.dataset.target;
    if (!id) {
      el.replaceWith(h("span", { class: "embed-missing" }, `Non trovato: ${target}`));
      continue;
    }
    const open = () => ctx.open(id);
    const ext = id.split(".").pop().toLowerCase();
    let node;
    if (kind === "image" && PREVIEW_IMG.has(ext)) {
      node = h("img", { class: "embed-img", src: rawUrl(id), alt: el.dataset.alias || target, loading: "lazy", ondblclick: open });
    } else if (kind === "pdf") {
      node = h("iframe", { class: "embed-pdf", src: rawUrl(id), title: target });
    } else if (kind === "video") {
      node = h("video", { class: "embed-media", src: rawUrl(id), controls: true, preload: "metadata" });
    } else if (kind === "audio") {
      node = h("audio", { src: rawUrl(id), controls: true, preload: "metadata" });
    } else if (kind === "note" && depth < 2) {
      node = h("div", { class: "embed-note" },
        h("button", { class: "embed-note-title", onclick: open }, target.split("/").pop()),
        h("div", { class: "embed-note-body" }, "…"));
      try {
        const [n, meta] = await Promise.all([api("/note", { params: { id } }), api("/item", { params: { id } })]);
        const body = node.querySelector(".embed-note-body");
        body.innerHTML = createRenderer(resolverFor(meta))(n.text);
        enhanceTasks(body);
        await renderEmbeds(body, ctx, depth + 1);
      } catch { /* resta il titolo */ }
    } else {
      node = h("button", { class: "embed-card", onclick: open },
        h("span", { class: "kind-dot", style: { background: `var(--k-${kind === "markdown" ? "note" : kind})` } }),
        h("span", {}, target.split("/").pop()), h("span", { class: "muted" }, kindLabel(kind)));
    }
    el.replaceWith(node);
  }
}

function wireLinks(root, ctx, onUnresolved) {
  root.addEventListener("click", (e) => {
    const a = e.target.closest("a.wikilink, a.hashtag");
    if (!a) return;
    e.preventDefault();
    if (a.classList.contains("hashtag")) { ctx.searchTag(a.dataset.tag); return; }
    if (a.dataset.id) ctx.open(a.dataset.id, { newTab: e.metaKey || e.ctrlKey });
    else onUnresolved(a.dataset.target);
  });
}

// ------------------------------------------------------------------ nota

export class NoteView {
  constructor(container, id, ctx) {
    this.id = id;
    this.ctx = ctx;
    this.mode = localStorage.getItem("atlante-note-mode") || "edit";
    this.el = h("div", { class: "view note-view" });
    container.append(this.el);
    this.save = debounce(() => this.doSave(), 700);
    this.refreshMeta = debounce(() => this.loadMeta(), 900);
    this.load();
  }

  get title() { return this.item ? displayName(this.item) : "Nota"; }

  async load() {
    try {
      const [note, item] = await Promise.all([
        api("/note", { params: { id: this.id } }),
        api("/item", { params: { id: this.id } }),
      ]);
      this.text = note.text;
      this.mtime = note.mtime;
      this.item = item;
      this.render();
      this.ctx.changed(this);
    } catch (e) {
      this.el.replaceChildren(h("div", { class: "empty" }, h("p", {}, e.message)));
    }
  }

  async loadMeta() {
    try {
      this.item = await api("/item", { params: { id: this.id } });
      this.ctx.changed(this);
      if (this.mode === "read") this.renderReading();
    } catch { /* niente */ }
  }

  render() {
    const titleInput = h("input", {
      class: "inline-title", value: this.title, "aria-label": "Titolo della nota", spellcheck: "false",
      onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } if (e.key === "Escape") { e.target.value = this.title; e.target.blur(); } },
      onblur: (e) => this.rename(e.target.value),
    });
    this.modeBtn = h("button", {
      class: "icon-btn", title: "Modifica / lettura (⌘E)", "aria-label": "Cambia tra modifica e lettura",
      onclick: () => this.toggleMode(),
    });
    this.banner = h("div", { class: "banner", hidden: true });
    this.body = h("div", { class: "note-body" });
    this.el.replaceChildren(
      h("header", { class: "view-head" }, breadcrumb(this.item, this.ctx), h("div", { class: "spacer" }), this.modeBtn),
      this.banner,
      h("div", { class: "note-title-wrap" }, titleInput),
      this.body);
    this.titleInput = titleInput;
    this.applyMode();
  }

  applyMode() {
    this.modeBtn.replaceChildren(icon(this.mode === "edit" ? "read" : "edit"));
    this.body.replaceChildren();
    this.editor?.destroy();
    this.editor = null;
    if (this.mode === "edit") {
      const host = h("div", { class: "editor-host" });
      this.body.append(host);
      this.editor = createEditor(host, {
        text: splitFrontmatter(this.text).body.replace(/^\n/, ""),
        onChange: (body) => {
          if (this._silent) return;
          const fm = splitFrontmatter(this.text).raw;
          this.text = fm ? fm + "\n" + body : body;
          this.dirty = true;
          this.save();
          this.ctx.status();
        },
        onFollowLink: (raw) => this.follow(linkTarget(raw)),
        onSaveNow: () => this.save.flush(),
      });
    } else {
      this.renderReading();
    }
  }

  renderReading() {
    if (this.mode !== "read") return;
    const html = createRenderer(resolverFor(this.item))(this.text);
    const art = h("article", { class: "reading", html });
    enhanceTasks(art);
    wireLinks(art, this.ctx, (t) => this.createFromLink(t));
    this.body.replaceChildren(art);
    renderEmbeds(art, this.ctx);
  }

  toggleMode() {
    this.mode = this.mode === "edit" ? "read" : "edit";
    localStorage.setItem("atlante-note-mode", this.mode);
    if (this.mode === "read") this.save.flush();
    this.applyMode();
    if (this.mode === "edit") this.editor.focus();
  }

  setText(next) {
    this.text = next;
    if (this.editor) {
      this._silent = true;
      this.editor.setText(splitFrontmatter(next).body.replace(/^\n/, ""));
      this._silent = false;
    }
    this.dirty = true;
    this.save();
    if (this.mode === "read") this.renderReading();
  }

  doSave(force = false) {
    // un salvataggio alla volta: il successivo parte quando il precedente ha aggiornato mtime
    this.saving = (this.saving || Promise.resolve()).then(() => this._save(force));
    return this.saving;
  }

  async _save(force) {
    if (!this.dirty) return;
    this.dirty = false;
    const text = this.text;
    try {
      const r = await api("/note", { method: "PUT", body: { id: this.id, text, base_mtime: force ? null : this.mtime } });
      this.mtime = r.mtime;
      this.banner.hidden = true;
      this.refreshMeta();
    } catch (e) {
      this.dirty = true;
      if (e instanceof ApiError && e.status === 409) this.showConflict();
      else toast("Nota non salvata: " + e.message, "error");
    }
  }

  showConflict() {
    this.banner.hidden = false;
    this.banner.replaceChildren(
      h("span", {}, "Questa nota è stata cambiata altrove mentre la modificavi."),
      h("button", { class: "btn ghost", onclick: () => { this.dirty = false; this.banner.hidden = true; this.load(); } }, "Carica la versione del server"),
      h("button", { class: "btn primary", onclick: () => { this.dirty = true; this.doSave(true); } }, "Tieni la mia versione"));
  }

  async follow(target) {
    const r = resolverFor(this.item)(target);
    if (r) { this.ctx.open(r.id); return; }
    await this.save.flush();
    await this.loadMeta();
    const r2 = resolverFor(this.item)(target);
    if (r2) this.ctx.open(r2.id);
    else this.createFromLink(target);
  }

  async createFromLink(target) {
    if (target.startsWith("/")) { toast(`Sul server non esiste ${target}.`, "error"); return; }
    try {
      const parts = target.split("/");
      const r = await api("/note/create", { method: "POST", body: { folder: parts.slice(0, -1).join("/"), name: parts.pop() } });
      this.ctx.treeChanged();
      this.ctx.open(r.id);
      this.refreshMeta();
    } catch (e) {
      toast(e.message, "error");
    }
  }

  async rename(newTitle) {
    newTitle = newTitle.trim();
    if (!newTitle || newTitle === this.title) { this.titleInput.value = this.title; return; }
    await this.save.flush();
    const folder = this.item.rel.split("/").slice(0, -1).join("/");
    try {
      const r = await api("/note/rename", { method: "POST", body: { id: this.id, new_rel: (folder ? folder + "/" : "") + newTitle } });
      this.ctx.replaceId(this.id, r.id);
      this.id = r.id;
      await this.load();
      this.ctx.treeChanged();
      toast("Nota rinominata. I link nelle altre note sono stati aggiornati.");
    } catch (e) {
      toast(e.message, "error");
      this.titleInput.value = this.title;
    }
  }

  // frontmatter (usato dal pannello Proprietà)
  frontmatter() { return splitFrontmatter(this.text).data; }
  updateFrontmatter(fn) {
    const data = { ...this.frontmatter() };
    fn(data);
    this.setText(withFrontmatter(this.text, data));
    this.save.flush();
  }

  insertLink(item) {
    const s = `[[${linkFor(item)}]]`;
    if (this.editor) this.editor.insertAtCursor(s);
    else this.setText(this.text + (this.text.endsWith("\n") ? "" : "\n") + s + "\n");
  }

  wordCount() {
    const body = splitFrontmatter(this.text || "").body;
    return (body.match(/[\p{L}\p{N}]+/gu) || []).length;
  }

  activate() { this.editor?.focus(); }
  async beforeClose() { await this.save.flush(); }
  destroy() { this.save.flush(); this.editor?.destroy(); this.el.remove(); }
}

// ------------------------------------------------------------------ file del server

export class FileView {
  constructor(container, id, ctx) {
    this.id = id;
    this.ctx = ctx;
    this.el = h("div", { class: "view file-view" });
    container.append(this.el);
    this.load();
  }

  get title() { return this.item ? displayName(this.item) : "File"; }

  async load() {
    try {
      this.item = await api("/item", { params: { id: this.id } });
      this.render();
      this.ctx.changed(this);
    } catch (e) {
      this.el.replaceChildren(h("div", { class: "empty" }, h("p", {}, e.message)));
    }
  }

  async loadMeta() { await this.load(); }

  render() {
    const it = this.item;
    const facts = h("dl", { class: "facts" },
      h("dt", {}, "Tipo"), h("dd", {}, kindLabel(it.kind) + (it.ext ? ` (.${it.ext})` : "")),
      h("dt", {}, "Dimensione"), h("dd", {}, fmtSize(it.size)),
      h("dt", {}, "Modificato"), h("dd", {}, fmtDate(it.mtime)),
      h("dt", {}, "Anno"), h("dd", {}, it.year ? `${it.year} ` : "—", it.year_src ? h("span", { class: "muted" }, YEAR_SRC[it.year_src] || "") : null));
    const actions = h("div", { class: "file-actions" },
      h("button", { class: "btn", onclick: () => download(it.id) }, icon("download", 16), "Scarica"),
      h("button", { class: "btn", onclick: () => this.noteAbout() }, icon("note", 16), "Crea una nota su questo file"),
      h("button", { class: "btn ghost", onclick: () => this.ctx.openLocalGraph(it.id) }, icon("graph", 16), "Grafo locale"));
    this.el.replaceChildren(
      h("header", { class: "view-head" }, breadcrumb(it, this.ctx)),
      h("div", { class: "file-wrap" },
        h("h1", { class: "file-title" }, it.name),
        actions,
        this.preview(it),
        facts));
  }

  preview(it) {
    const url = rawUrl(it.id);
    if (it.kind === "image" && PREVIEW_IMG.has(it.ext)) return h("div", { class: "preview" }, h("img", { src: url, alt: it.name }));
    if (it.kind === "pdf") return h("iframe", { class: "preview-pdf", src: url, title: it.name });
    if (it.kind === "video") {
      const v = h("video", { class: "preview-media", src: url, controls: true, preload: "metadata" });
      v.addEventListener("error", () => v.replaceWith(h("p", { class: "muted preview-note" },
        "Questo formato video non si riproduce nell'app. Aprilo con Jellyfin o scaricalo.")));
      return v;
    }
    if (it.kind === "audio") return h("audio", { class: "preview-audio", src: url, controls: true, preload: "metadata" });
    if ((it.kind === "text" || it.kind === "markdown") && it.size < 2_000_000) {
      const box = h("div", { class: "preview-text" }, "Caricamento…");
      fetch(url).then((r) => r.text()).then((t) => {
        if (it.kind === "markdown") {
          const art = h("article", { class: "reading", html: createRenderer(() => null)(t) });
          box.replaceChildren(art);
        } else {
          box.replaceChildren(h("pre", {}, t));
        }
      }).catch(() => { box.textContent = "Impossibile leggere il file."; });
      return box;
    }
    return h("div", { class: "preview-none" },
      h("p", {}, `Per i file ${kindLabel(it.kind).toLowerCase()} non c'è un'anteprima.`),
      h("p", { class: "muted" }, "Puoi comunque taggarlo, collegarlo alle note e scaricarlo."));
  }

  async noteAbout() {
    const name = displayName(this.item);
    try {
      const r = await api("/note/create", {
        method: "POST",
        body: { name, text: `[[${linkFor(this.item)}]]\n\n` },
      });
      this.ctx.treeChanged();
      this.ctx.open(r.id);
    } catch (e) {
      toast(e.message, "error");
    }
  }

  activate() {}
  destroy() { this.el.remove(); }
}

// ------------------------------------------------------------------ cartella

export class FolderView {
  constructor(container, id, ctx) {
    this.id = id;
    this.ctx = ctx;
    this.el = h("div", { class: "view folder-view" });
    container.append(this.el);
    this.load();
  }

  get title() {
    if (this.id === "s:") return sourceName();
    if (this.id === "n:") return "Note";
    return this.id.split("/").pop().replace(/^[sn]:/, "");
  }

  async load() {
    try {
      const [children, item] = await Promise.all([
        api("/tree", { params: { id: this.id } }),
        this.id.endsWith(":") ? Promise.resolve(null) : api("/item", { params: { id: this.id } }),
      ]);
      this.item = item;
      this.render(children);
      this.ctx.changed(this);
    } catch (e) {
      this.el.replaceChildren(h("div", { class: "empty" }, h("p", {}, e.message)));
    }
  }

  async loadMeta() { await this.load(); }

  render(children) {
    const dirs = children.filter((c) => c.is_dir).length;
    const grid = h("div", { class: "folder-grid" }, children.map((c) => {
      const thumb = (c.kind === "image" && PREVIEW_IMG.has(c.ext) && c.ext !== "svg") || c.kind === "pdf";
      return h("button", {
        class: "tile", title: c.name,
        onclick: (e) => this.ctx.open(c.id, { newTab: e.metaKey || e.ctrlKey }),
        draggable: "true",
        ondragstart: (e) => e.dataTransfer.setData("text/plain", `[[${linkFor(c)}]]`),
      },
      h("span", { class: "tile-visual", style: { "--kc": `var(--k-${c.kind === "markdown" ? "note" : c.kind})` } },
        thumb ? h("img", { src: thumbUrl(c.id, 240), alt: "", loading: "lazy", onerror: (e) => e.target.remove() })
          : h("span", { class: "tile-kind" }, c.is_dir ? `${c.children}` : (c.ext || "").slice(0, 5))),
      h("span", { class: "tile-name" }, displayName(c)),
      h("span", { class: "tile-meta" }, c.is_dir ? "cartella" : `${fmtSize(c.size)}${c.year ? " · " + c.year : ""}`));
    }));
    const head = this.item ? breadcrumb(this.item, this.ctx) : h("nav", { class: "breadcrumb" }, this.title);
    this.el.replaceChildren(
      h("header", { class: "view-head" }, head),
      h("div", { class: "folder-wrap" },
        h("h1", { class: "file-title" }, this.title),
        h("p", { class: "muted" }, `${dirs} cartelle, ${children.length - dirs} file`),
        children.length ? grid : h("p", { class: "empty-inline" }, "Questa cartella è vuota.")));
  }

  activate() {}
  destroy() { this.el.remove(); }
}
