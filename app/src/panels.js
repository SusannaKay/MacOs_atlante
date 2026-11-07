// Pannelli laterali: esplora, cerca, tag, segnalibri (sinistra) e informazioni (destra).
import { api, thumbUrl } from "./api.js";
import { GraphView } from "./graph.js";
import {
  h, icon, kindLabel, displayName, linkFor, toast, contextMenu, prompt, confirmBox, debounce, YEAR_SRC,
} from "./util.js";

const kindDot = (k) => h("span", { class: "kind-dot", style: { background: `var(--k-${k === "markdown" ? "note" : k})` } });

// ================================================================== Esplora
export class Explorer {
  constructor(ctx) {
    this.ctx = ctx;
    this.open = new Set(JSON.parse(localStorage.getItem("atlante-tree-open") || '["n:","s:"]'));
    this.el = h("div", { class: "panel explorer" });
    const head = h("div", { class: "panel-head" },
      h("h2", {}, "Esplora"),
      h("div", { class: "panel-actions" },
        h("button", { class: "icon-btn", title: "Nuova nota", "aria-label": "Nuova nota", onclick: () => ctx.newNote() }, icon("plus")),
        h("button", { class: "icon-btn", title: "Nuova cartella", "aria-label": "Nuova cartella", onclick: () => this.newFolder("n:") }, icon("folderPlus")),
        h("button", { class: "icon-btn", title: "Aggiorna", "aria-label": "Aggiorna l'elenco", onclick: () => this.refresh() }, icon("refresh"))));
    this.tree = h("div", { class: "tree", role: "tree", "aria-label": "File" });
    this.el.append(head, this.tree);
    this.refresh();
  }

  saveOpen() { localStorage.setItem("atlante-tree-open", JSON.stringify([...this.open])); }

  async refresh() {
    const roots = [
      { id: "n:", name: "Note", is_dir: true, kind: "dir", src: "n", rel: "" },
      { id: "s:", name: "Server", is_dir: true, kind: "dir", src: "s", rel: "" },
    ];
    const frag = h("div", {});
    for (const r of roots) frag.append(await this.node(r, 0));
    this.tree.replaceChildren(...frag.childNodes);
    this.highlight(this.ctx.activeId());
  }

  async node(item, depth) {
    const isOpen = item.is_dir && this.open.has(item.id);
    const row = h("div", {
      class: "tree-row" + (item.is_dir ? " dir" : "") + (depth === 0 ? " root" : ""),
      role: "treeitem", tabindex: "0", "data-id": item.id,
      "aria-expanded": item.is_dir ? String(isOpen) : undefined,
      style: { paddingLeft: 8 + depth * 14 + "px" },
      draggable: depth > 0 ? "true" : undefined,
    },
    item.is_dir ? h("span", { class: "twisty" + (isOpen ? " open" : "") }, icon("chevron", 12)) : kindDot(item.kind),
    h("span", { class: "tree-name" }, displayName(item)),
    item.is_dir && depth > 0 && item.children ? h("span", { class: "tree-count" }, item.children) : null);
    const wrap = h("div", { class: "tree-node" }, row);
    const kids = h("div", { class: "tree-kids", role: "group" });
    wrap.append(kids);

    const toggle = async () => {
      if (this.open.has(item.id)) { this.open.delete(item.id); kids.replaceChildren(); }
      else { this.open.add(item.id); await this.fill(kids, item, depth); }
      row.setAttribute("aria-expanded", String(this.open.has(item.id)));
      row.querySelector(".twisty")?.classList.toggle("open", this.open.has(item.id));
      this.saveOpen();
    };
    row.addEventListener("click", (e) => {
      if (item.is_dir) { toggle(); return; }
      this.ctx.open(item.id, { newTab: e.metaKey || e.ctrlKey });
    });
    row.addEventListener("dblclick", () => { if (item.is_dir && depth > 0) this.ctx.open(item.id); });
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); item.is_dir ? toggle() : this.ctx.open(item.id); }
      if (e.key === "ArrowRight" && item.is_dir && !this.open.has(item.id)) toggle();
      if (e.key === "ArrowLeft" && item.is_dir && this.open.has(item.id)) toggle();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const rows = [...this.tree.querySelectorAll(".tree-row")];
        const i = rows.indexOf(row);
        rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
      }
    });
    row.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", `[[${linkFor(item)}]]`);
      e.dataTransfer.setData("application/x-atlante-id", item.id);
    });
    if (item.src === "n" && item.is_dir) {
      row.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("application/x-atlante-id")) { e.preventDefault(); row.classList.add("drop"); } });
      row.addEventListener("dragleave", () => row.classList.remove("drop"));
      row.addEventListener("drop", (e) => {
        row.classList.remove("drop");
        const id = e.dataTransfer.getData("application/x-atlante-id");
        if (!id?.startsWith("n:") || id === item.id) return;
        e.preventDefault();
        this.move(id, item.rel);
      });
    }
    row.addEventListener("contextmenu", (e) => contextMenu(e, this.menuFor(item, depth)));
    if (isOpen) await this.fill(kids, item, depth);
    return wrap;
  }

  async fill(kids, item, depth) {
    try {
      const children = await api("/tree", { params: { id: item.id } });
      const nodes = [];
      const limit = 500;
      for (const c of children.slice(0, limit)) nodes.push(await this.node(c, depth + 1));
      if (children.length > limit) {
        nodes.push(h("button", { class: "tree-more", style: { paddingLeft: 22 + depth * 14 + "px" }, onclick: () => this.ctx.open(item.id) },
          `Altri ${children.length - limit} elementi: apri la cartella`));
      }
      if (!children.length && item.id === "n:") {
        nodes.push(h("p", { class: "tree-empty" }, "Nessuna nota. Creane una con ⌘N."));
      }
      kids.replaceChildren(...nodes);
      this.highlight(this.ctx.activeId());
    } catch (e) {
      kids.replaceChildren(h("p", { class: "tree-empty" }, e.message));
    }
  }

  menuFor(item, depth) {
    const ctx = this.ctx;
    const inVault = item.src === "n";
    const entries = [];
    if (!item.is_dir || depth > 0) entries.push({ label: "Apri in una nuova scheda", action: () => ctx.open(item.id, { newTab: true }) });
    if (inVault && item.is_dir) {
      entries.push({ label: "Nuova nota qui", action: () => ctx.newNote(item.rel) });
      entries.push({ label: "Nuova cartella qui", action: () => this.newFolder(item.id) });
    }
    if (depth > 0) {
      entries.push({ label: "Copia il link", action: () => { navigator.clipboard.writeText(`[[${linkFor(item)}]]`); toast("Link copiato."); } });
      entries.push({ label: "Inserisci il link nella nota aperta", action: () => ctx.insertLinkInActive(item) });
      entries.push({ label: "Segnalibro", action: () => ctx.toggleBookmark(item.id) });
      entries.push({ label: "Mostra nel grafo locale", action: () => ctx.openLocalGraph(item.id) });
    }
    if (inVault && depth > 0) {
      entries.push("-");
      entries.push({ label: "Rinomina…", action: () => this.rename(item) });
      entries.push({ label: "Sposta nel cestino", danger: true, action: () => this.remove(item) });
    }
    return entries;
  }

  async newFolder(parentId) {
    const name = await prompt("Nuova cartella", "", { okLabel: "Crea cartella" });
    if (!name) return;
    const base = parentId === "n:" ? "" : parentId.slice(2) + "/";
    try {
      await api("/folder/create", { method: "POST", body: { id: "n:" + base + name } });
      this.open.add(parentId);
      this.refresh();
    } catch (e) { toast(e.message, "error"); }
  }

  async rename(item) {
    const parts = item.rel.split("/");
    const cur = displayName(item);
    const name = await prompt("Rinomina", cur, { okLabel: "Rinomina", hint: "I link nelle altre note verranno aggiornati." });
    if (!name || name === cur) return;
    const nr = [...parts.slice(0, -1), name].join("/");
    try {
      const r = await api("/note/rename", { method: "POST", body: { id: item.id, new_rel: nr } });
      this.ctx.replaceId(item.id, r.id);
      this.refresh();
      this.ctx.reloadAll();
    } catch (e) { toast(e.message, "error"); }
  }

  async move(id, folderRel) {
    const name = id.split("/").pop().replace(/^n:/, "");
    const nr = (folderRel ? folderRel + "/" : "") + name.replace(/\.md$/i, "");
    try {
      const r = await api("/note/rename", { method: "POST", body: { id, new_rel: nr } });
      this.ctx.replaceId(id, r.id);
      this.refresh();
      this.ctx.reloadAll();
    } catch (e) { toast(e.message, "error"); }
  }

  async remove(item) {
    const ok = await confirmBox("Spostare nel cestino?",
      `«${displayName(item)}» andrà nella cartella .trash del vault: potrai recuperarlo da lì.`, "Sposta nel cestino", true);
    if (!ok) return;
    try {
      await api("/note/delete", { method: "POST", body: { id: item.id } });
      this.ctx.closeId(item.id);
      this.refresh();
    } catch (e) { toast(e.message, "error"); }
  }

  highlight(id) {
    this.tree.querySelectorAll(".tree-row.active").forEach((r) => r.classList.remove("active"));
    if (id) this.tree.querySelector(`.tree-row[data-id="${CSS.escape(id)}"]`)?.classList.add("active");
  }

  async reveal(id) {
    if (!id) return;
    const src = id.slice(0, 2);
    const parts = id.slice(2).split("/");
    this.open.add(src);
    for (let i = 1; i < parts.length; i++) this.open.add(src + parts.slice(0, i).join("/"));
    this.saveOpen();
    await this.refresh();
    this.tree.querySelector(`.tree-row[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "center" });
  }
}

// ================================================================== Cerca
export class SearchPanel {
  constructor(ctx) {
    this.ctx = ctx;
    this.el = h("div", { class: "panel search" });
    this.q = h("input", { type: "search", placeholder: "Cerca nei nomi e nel testo…", "aria-label": "Cerca" });
    this.kind = h("select", { "aria-label": "Tipo" },
      h("option", { value: "" }, "Ogni tipo"),
      ["note", "pdf", "image", "video", "audio", "ebook", "text", "markdown", "doc", "archive", "other"]
        .map((k) => h("option", { value: k }, kindLabel(k))));
    this.where = h("select", { "aria-label": "Dove" },
      h("option", { value: "" }, "Ovunque"), h("option", { value: "n" }, "Solo note"), h("option", { value: "s" }, "Solo server"));
    this.year = h("input", { type: "number", min: 1900, max: 2200, placeholder: "Anno", "aria-label": "Anno" });
    this.tag = h("input", { type: "text", placeholder: "Tag", "aria-label": "Tag", list: "atlante-tags" });
    this.prop = h("input", { type: "text", placeholder: "Proprietà (es. stato=da leggere)", "aria-label": "Proprietà" });
    this.results = h("div", { class: "results", role: "list" });
    this.count = h("p", { class: "muted results-count" });
    const run = debounce(() => this.run(), 250);
    [this.q, this.year, this.tag, this.prop].forEach((i) => i.addEventListener("input", run));
    [this.kind, this.where].forEach((i) => i.addEventListener("change", run));
    this.el.append(
      h("div", { class: "panel-head" }, h("h2", {}, "Cerca")),
      h("div", { class: "search-form" }, this.q,
        h("div", { class: "row" }, this.kind, this.where),
        h("div", { class: "row" }, this.year, this.tag),
        this.prop),
      this.count, this.results);
  }

  focus() { this.q.focus(); this.q.select(); }

  set({ q, tag, year, kind, prop } = {}) {
    if (q !== undefined) this.q.value = q;
    if (tag !== undefined) this.tag.value = tag;
    if (year !== undefined) this.year.value = year;
    if (kind !== undefined) this.kind.value = kind;
    if (prop !== undefined) this.prop.value = prop;
    this.run();
  }

  async run(append = false) {
    const params = {
      q: this.q.value.trim(), kind: this.kind.value, src: this.where.value,
      year: this.year.value, tag: this.tag.value.trim(), prop: this.prop.value.trim(),
      limit: 60, offset: append ? this.shown : 0,
    };
    if (!params.q && !params.kind && !params.year && !params.tag && !params.prop && !params.src) {
      this.results.replaceChildren();
      this.count.textContent = "Scrivi qualcosa o scegli un filtro.";
      return;
    }
    try {
      const r = await api("/search", { params });
      if (!append) { this.results.replaceChildren(); this.shown = 0; }
      this.shown += r.results.length;
      this.count.textContent = r.total === 1 ? "1 risultato" : `${r.total.toLocaleString("it-IT")} risultati`;
      this.results.querySelector(".more")?.remove();
      for (const it of r.results) {
        this.results.append(h("button", {
          class: "result", role: "listitem",
          onclick: (e) => this.ctx.open(it.id, { newTab: e.metaKey || e.ctrlKey }),
          draggable: "true",
          ondragstart: (e) => e.dataTransfer.setData("text/plain", `[[${linkFor(it)}]]`),
        },
        h("span", { class: "result-title" }, kindDot(it.kind), displayName(it)),
        h("span", { class: "result-path" }, (it.src === "n" ? "Note/" : "Server/") + it.rel.split("/").slice(0, -1).join("/") + (it.year ? `  ·  ${it.year}` : "")),
        it.snippet ? h("span", { class: "result-snippet" }, ...highlightSnippet(it.snippet)) : null));
      }
      if (this.shown < r.total) {
        this.results.append(h("button", { class: "btn ghost more", onclick: () => this.run(true) }, "Mostra altri risultati"));
      }
    } catch (e) {
      this.count.textContent = e.message;
    }
  }
}

function highlightSnippet(s) {
  return s.split(/(«[^»]*»)/).map((part) =>
    part.startsWith("«") ? h("mark", {}, part.slice(1, -1)) : part.replace(/\s+/g, " "));
}

// ================================================================== Tag
export class TagsPanel {
  constructor(ctx) {
    this.ctx = ctx;
    this.el = h("div", { class: "panel tags" });
    this.list = h("div", { class: "tag-tree" });
    this.el.append(h("div", { class: "panel-head" }, h("h2", {}, "Tag"),
      h("button", { class: "icon-btn", title: "Aggiorna", "aria-label": "Aggiorna i tag", onclick: () => this.refresh() }, icon("refresh"))), this.list);
    this.refresh();
  }

  async refresh() {
    try {
      const tags = await api("/tags");
      const dl = document.getElementById("atlante-tags");
      dl?.replaceChildren(...tags.map((t) => h("option", { value: t.tag })));
      if (!tags.length) {
        this.list.replaceChildren(h("p", { class: "tree-empty" },
          "Ancora nessun tag. Scrivi #tag in una nota, o aggiungilo a un file dal pannello a destra."));
        return;
      }
      this.list.replaceChildren(...tags.map((t) => {
        const depth = t.tag.split("/").length - 1;
        return h("button", {
          class: "tag-row", style: { paddingLeft: 10 + depth * 14 + "px" },
          onclick: () => this.ctx.searchTag(t.tag),
        }, h("span", {}, "#" + (depth ? t.tag.split("/").pop() : t.tag)), h("span", { class: "tree-count" }, t.count));
      }));
    } catch (e) {
      this.list.replaceChildren(h("p", { class: "tree-empty" }, e.message));
    }
  }
}

// ================================================================== Segnalibri
export class BookmarksPanel {
  constructor(ctx) {
    this.ctx = ctx;
    this.el = h("div", { class: "panel bookmarks" });
    this.list = h("div", {});
    this.el.append(h("div", { class: "panel-head" }, h("h2", {}, "Segnalibri")), this.list);
    this.refresh();
  }

  async refresh() {
    try {
      const items = await api("/bookmarks");
      if (!items.length) {
        this.list.replaceChildren(h("p", { class: "tree-empty" }, "Nessun segnalibro. Aggiungili dal menu con il tasto destro o dal pannello a destra."));
        return;
      }
      this.list.replaceChildren(...items.map((it) => h("button", {
        class: "result", onclick: (e) => this.ctx.open(it.id, { newTab: e.metaKey || e.ctrlKey }),
        oncontextmenu: (e) => contextMenu(e, [{ label: "Togli dai segnalibri", action: () => this.ctx.toggleBookmark(it.id) }]),
      }, h("span", { class: "result-title" }, kindDot(it.kind), displayName(it)),
      h("span", { class: "result-path" }, (it.src === "n" ? "Note/" : "Server/") + it.rel))));
    } catch (e) {
      this.list.replaceChildren(h("p", { class: "tree-empty" }, e.message));
    }
  }
}

// ================================================================== Suggerimenti (LLM)
export class SuggestionsPanel {
  constructor(ctx) {
    this.ctx = ctx;
    this.el = h("div", { class: "panel suggestions" });
    this.count = h("p", { class: "muted results-count" });
    this.list = h("div", { class: "results" });
    this.bulk = h("button", { class: "btn ghost small", onclick: () => this.acceptConfident() }, icon("check", 14), "Accetta quelli dal 70% in su");
    this.el.append(
      h("div", { class: "panel-head" }, h("h2", {}, "Suggerimenti"),
        h("button", { class: "icon-btn", title: "Aggiorna", "aria-label": "Aggiorna i suggerimenti", onclick: () => this.refresh() }, icon("refresh"))),
      h("p", { class: "panel-intro" }, "Collegamenti proposti dall'LLM sul tuo Mac. Quelli con fiducia dall'80% in su diventano link da soli; qui restano quelli da decidere tu."),
      h("div", { class: "panel-tools" }, this.bulk),
      this.count, this.list);
    this.refresh();
  }

  async refresh(append = false) {
    try {
      const r = await api("/suggestions", { params: { status: "pending", limit: 50, offset: append ? this.shown : 0 } });
      if (!append) { this.list.replaceChildren(); this.shown = 0; }
      this.shown += r.items.length;
      this.total = r.total;
      this.count.textContent = r.total === 1 ? "1 da rivedere" : `${r.total.toLocaleString("it-IT")} da rivedere`;
      this.bulk.hidden = !r.total;
      this.list.querySelector(".more")?.remove();
      if (!r.total) {
        this.list.replaceChildren(h("p", { class: "tree-empty" },
          "Niente da rivedere. Attiva l'analisi con Ollama dalle Impostazioni: i suggerimenti compariranno qui."));
        return;
      }
      r.items.forEach((sg) => this.list.append(this.card(sg)));
      if (this.shown < r.total) this.list.append(h("button", { class: "btn ghost more", onclick: () => this.refresh(true) }, "Mostra altri"));
      this.ctx.suggestionsCount?.(r.total);
    } catch (e) {
      this.count.textContent = e.message;
    }
  }

  card(sg) {
    const side = (id, name, kind) => h("button", { class: "link", onclick: (e) => this.ctx.open(id, { newTab: e.metaKey || e.ctrlKey }) },
      kindDot(kind), name.replace(/\.md$/i, ""));
    const card = h("div", { class: "suggestion" },
      side(sg.a, sg.a_name, sg.a_kind),
      h("span", { class: "sg-arrow", "aria-hidden": "true" }, "↕"),
      side(sg.b, sg.b_name, sg.b_kind),
      h("p", { class: "sg-reason" }, sg.reason || "Nessun motivo indicato", h("span", { class: "sg-conf" }, ` · ${Math.round((sg.confidence || 0) * 100)}%`)),
      h("div", { class: "row" },
        h("button", { class: "btn small primary", onclick: () => this.decide(sg, true, card) }, "Accetta"),
        h("button", { class: "btn small ghost", onclick: () => this.decide(sg, false, card) }, "Scarta")));
    return card;
  }

  async decide(sg, accept, card) {
    try {
      await api("/suggestions/decide", { method: "POST", body: { sid: sg.sid, accept } });
      card.remove();
      this.total -= 1;
      this.count.textContent = this.total === 1 ? "1 da rivedere" : `${this.total.toLocaleString("it-IT")} da rivedere`;
      this.ctx.suggestionsCount?.(this.total);
      this.ctx.reloadAll();
    } catch (e) { toast(e.message, "error"); }
  }

  async acceptConfident() {
    const ok = await confirmBox("Accettare i suggerimenti dal 70% in su?",
      "Tutti i suggerimenti in attesa con fiducia del 70% o più diventeranno collegamenti. Potrai sempre rimuoverli uno per uno.", "Accetta");
    if (!ok) return;
    try {
      const r = await api("/suggestions/decide_many", { method: "POST", body: { min_confidence: 0.7, accept: true } });
      toast(r.changed === 1 ? "1 collegamento accettato." : `${r.changed} collegamenti accettati.`);
      this.refresh();
      this.ctx.reloadAll();
    } catch (e) { toast(e.message, "error"); }
  }
}

// ================================================================== Informazioni (destra)
export class InfoPanel {
  constructor(ctx) {
    this.ctx = ctx;
    this.el = h("aside", { class: "info", "aria-label": "Informazioni sull'elemento" });
    this.content = h("div", { class: "info-content" });
    this.graphBox = h("section", { class: "info-sec local-graph" });
    this.el.append(this.content, this.graphBox);
    this.showEmpty();
  }

  showEmpty() {
    this.view = null;
    this.content.replaceChildren(h("p", { class: "info-empty" }, "Apri una nota o un file per vederne proprietà, tag e collegamenti."));
    this.graphBox.hidden = true;
  }

  async update(view) {
    // non ridisegno mentre si sta scrivendo nel pannello: aspetto che il fuoco esca
    if (view && view === this.view && this.el.contains(document.activeElement)) {
      this.pending = view;
      if (!this._waiting) {
        this._waiting = true;
        this.el.addEventListener("focusout", (e) => {
          this._waiting = false;
          const v = this.pending;
          if (!v || v !== this.view) return; // nel frattempo è stato aperto altro
          if (this.el.contains(e.relatedTarget)) { this.update(v); return; }
          this.pending = null;
          setTimeout(() => this.update(v), 0);
        }, { once: true });
      }
      return;
    }
    this.pending = null;
    this.view = view;
    const it = view?.item;
    if (!it || it.is_dir) { this.showEmpty(); return; }
    const isNote = it.kind === "note";
    const sections = [];

    // ---- riassunto dell'LLM
    if (it.ai_summary) {
      sections.push(h("section", { class: "info-sec ai-summary" },
        h("h3", {}, icon("spark", 13), " Riassunto"),
        h("p", {}, it.ai_summary),
        it.ai_entities?.length ? h("p", { class: "muted small" }, it.ai_entities.join(" · ")) : null));
    }

    // ---- proprietà
    const props = isNote
      ? Object.entries(view.frontmatter()).filter(([k]) => !["tags", "tag"].includes(k.toLowerCase()))
        .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "")])
      : it.props.filter((p) => p.origin === "user").map((p) => [p.key, p.value]);
    const rows = h("div", { class: "props" });
    const saveProps = async () => {
      const entries = [...rows.querySelectorAll(".prop-row")].map((r) => [r.querySelector(".pk").value.trim(), r.querySelector(".pv").value])
        .filter(([k]) => k);
      if (isNote) {
        view.updateFrontmatter((d) => {
          for (const k of Object.keys(d)) if (!["tags", "tag"].includes(k.toLowerCase())) delete d[k];
          for (const [k, v] of entries) d[k] = /^\d+$/.test(v) ? Number(v) : v;
        });
      } else {
        try {
          await api("/item/props", { method: "POST", body: { id: it.id, props: Object.fromEntries(entries) } });
          await view.loadMeta();
        } catch (e) { toast(e.message, "error"); }
      }
    };
    const addRow = (k = "", v = "") => {
      const row = h("div", { class: "prop-row" },
        h("input", { class: "pk", value: k, placeholder: "nome", "aria-label": "Nome della proprietà", list: "atlante-propkeys" }),
        h("input", { class: "pv", value: v, placeholder: "valore", "aria-label": "Valore" }),
        h("button", { class: "icon-btn small", "aria-label": "Rimuovi proprietà", onclick: () => { row.remove(); saveProps(); } }, icon("close", 14)));
      row.querySelectorAll("input").forEach((i) => i.addEventListener("change", saveProps));
      rows.append(row);
      return row;
    };
    props.forEach(([k, v]) => addRow(k, v));
    sections.push(h("section", { class: "info-sec" },
      h("h3", {}, "Proprietà"),
      h("p", { class: "year-line" }, h("strong", {}, it.year ?? "—"), " ",
        h("span", { class: "muted" }, it.year_src ? "anno " + (YEAR_SRC[it.year_src] || "") : "anno sconosciuto")),
      rows,
      h("button", { class: "btn ghost small", onclick: () => addRow().querySelector(".pk").focus() }, icon("plus", 14), "Aggiungi proprietà"),
      h("p", { class: "hint" }, "La proprietà «anno» decide in quale colonna appare nel grafo per anni.")));

    // ---- tag
    const userTags = isNote
      ? [].concat(view.frontmatter().tags || view.frontmatter().tag || []).flatMap((t) => String(t).split(/[,\s]+/)).filter(Boolean).map((t) => t.replace(/^#/, "").toLowerCase())
      : it.tags.filter((t) => t.origin === "user").map((t) => t.tag);
    const inline = isNote ? it.tags.filter((t) => t.origin === "note" && !userTags.includes(t.tag)).map((t) => t.tag) : [];
    const saveTags = async (list) => {
      if (isNote) {
        view.updateFrontmatter((d) => { delete d.tag; d.tags = list; });
      } else {
        try {
          await api("/item/tags", { method: "POST", body: { id: it.id, tags: list } });
          await view.loadMeta();
          this.ctx.tagsChanged();
        } catch (e) { toast(e.message, "error"); }
      }
    };
    const tagInput = h("input", {
      type: "text", placeholder: "Aggiungi tag…", "aria-label": "Aggiungi tag", list: "atlante-tags",
      onkeydown: (e) => {
        if (e.key === "Enter" && e.target.value.trim()) {
          const t = e.target.value.trim().replace(/^#/, "").toLowerCase();
          if (!userTags.includes(t)) saveTags([...userTags, t]);
          e.target.value = "";
        }
      },
    });
    sections.push(h("section", { class: "info-sec" },
      h("h3", {}, "Tag"),
      h("div", { class: "chips" },
        userTags.map((t) => h("span", { class: "chip" },
          h("button", { class: "chip-label", onclick: () => this.ctx.searchTag(t) }, "#" + t),
          h("button", { class: "chip-x", "aria-label": `Togli il tag ${t}`, onclick: () => saveTags(userTags.filter((x) => x !== t)) }, icon("close", 12)))),
        inline.map((t) => h("button", { class: "chip inline", title: "Scritto nel testo della nota", onclick: () => this.ctx.searchTag(t) }, "#" + t))),
      tagInput));

    // ---- segnalibro
    sections.push(h("div", { class: "info-row" },
      h("button", { class: "btn ghost small", "aria-pressed": String(it.bookmarked), onclick: () => this.ctx.toggleBookmark(it.id) },
        icon("bookmark", 14), it.bookmarked ? "Nei segnalibri" : "Aggiungi ai segnalibri")));

    // ---- collegamenti in entrata
    sections.push(h("section", { class: "info-sec" },
      h("h3", {}, `Collegamenti in entrata (${it.backlinks.length})`),
      it.backlinks.length
        ? h("div", { class: "link-list" }, it.backlinks.map((b) => this.linkBtn(b.id, b.name, b.kind)))
        : h("p", { class: "muted small" }, "Nessuna nota punta qui.")));

    // ---- collegamenti trovati dall'LLM
    const decide = async (sid, accept) => {
      try {
        await api("/suggestions/decide", { method: "POST", body: { sid, accept } });
        await view.loadMeta();
        this.ctx.suggestionsChanged?.();
      } catch (e) { toast(e.message, "error"); }
    };
    if (it.related?.length) {
      sections.push(h("section", { class: "info-sec" },
        h("h3", {}, `Collegamenti automatici (${it.related.length})`),
        h("div", { class: "link-list" }, it.related.map((r) => h("div", { class: "ai-link" },
          this.linkBtn(r.id, r.name, r.kind),
          h("p", { class: "sg-reason" }, r.reason),
          h("button", { class: "icon-btn small", title: "Rimuovi questo collegamento", "aria-label": "Rimuovi il collegamento", onclick: () => decide(r.sid, false) }, icon("close", 12)))))));
    }
    if (it.suggested?.length) {
      sections.push(h("section", { class: "info-sec suggested" },
        h("h3", {}, icon("spark", 13), ` Suggeriti (${it.suggested.length})`),
        it.suggested.map((r) => h("div", { class: "suggestion compact" },
          this.linkBtn(r.id, r.name, r.kind),
          h("p", { class: "sg-reason" }, r.reason, h("span", { class: "sg-conf" }, ` · ${Math.round((r.confidence || 0) * 100)}%`)),
          h("div", { class: "row" },
            h("button", { class: "btn small primary", onclick: () => decide(r.sid, true) }, "Accetta"),
            h("button", { class: "btn small ghost", onclick: () => decide(r.sid, false) }, "Scarta"))))));
    }

    // ---- collegamenti in uscita
    if (isNote) {
      const seen = new Set();
      const outs = it.outgoing.filter((o) => { const k = o.target_raw; if (seen.has(k)) return false; seen.add(k); return true; });
      sections.push(h("section", { class: "info-sec" },
        h("h3", {}, `Collegamenti in uscita (${outs.length})`),
        outs.length ? h("div", { class: "link-list" }, outs.map((o) => o.target_id
          ? this.linkBtn(o.target_id, o.name, o.target_kind)
          : h("span", { class: "link broken", title: "Non esiste ancora" }, o.target_raw)))
          : h("p", { class: "muted small" }, "Questa nota non collega nulla.")));
    }

    // ---- menzioni senza link
    const mentions = h("section", { class: "info-sec" }, h("h3", {}, "Menzioni senza link"), h("p", { class: "muted small" }, "…"));
    sections.push(mentions);
    this.content.replaceChildren(...sections);
    this.loadMentions(it, mentions);

    // ---- grafo locale
    const graphKey = [it.id, it.backlinks.length, (it.outgoing || []).length, (it.related || []).length].join("|");
    this.graphBox.hidden = false;
    if (!this.graph) {
      this.graphBox.replaceChildren(h("h3", {}, "Grafo locale"));
      this.graph = new GraphView(this.graphBox, {
        scope: "local", focusId: it.id, compact: true, depth: 1,
        onOpen: (n) => (n.kind === "tag" ? this.ctx.searchTag(n.id.slice(4)) : this.ctx.open(n.id)),
      });
    } else {
      this.graph.setFocus(it.id);
      if (this._lastGraphRefresh !== graphKey) this.graph.load();
    }
    this._lastGraphRefresh = graphKey;
  }

  linkBtn(id, name, kind) {
    return h("button", { class: "link", onclick: (e) => this.ctx.open(id, { newTab: e.metaKey || e.ctrlKey }) },
      kindDot(kind), name?.replace(/\.md$/i, "") || id);
  }

  async loadMentions(it, box) {
    try {
      const rows = await api("/unlinked", { params: { id: it.id } });
      const title = h("h3", {}, `Menzioni senza link (${rows.length})`);
      if (!rows.length) { box.replaceChildren(title, h("p", { class: "muted small" }, "Nessuna nota lo nomina senza collegarlo.")); return; }
      box.replaceChildren(title, ...rows.map((r) => h("div", { class: "mention" },
        h("button", { class: "link", onclick: () => this.ctx.open(r.id) }, kindDot("note"), r.name.replace(/\.md$/i, "")),
        h("p", { class: "result-snippet" }, ...highlightSnippet(r.snippet || "")),
        h("button", { class: "btn ghost small", onclick: () => this.linkMention(r.id, it) }, icon("link", 14), "Collega"))));
    } catch {
      box.remove();
    }
  }

  async linkMention(noteId, target) {
    try {
      const n = await api("/note", { params: { id: noteId } });
      const stem = target.kind === "note" ? displayName(target) : target.name.replace(/\.[^.]+$/, "");
      const link = linkFor(target);
      const re = new RegExp(`(?<!\\[\\[[^\\]]*)\\b(${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[\s_-]+/g, "[\\s_-]+")})\\b`, "iu");
      if (!re.test(n.text)) { toast("Non ho trovato la menzione nel testo.", "error"); return; }
      const text = n.text.replace(re, (m) => (link === m ? `[[${m}]]` : `[[${link}|${m}]]`));
      await api("/note", { method: "PUT", body: { id: noteId, text, base_mtime: n.mtime } });
      toast(`Collegato in «${noteId.split("/").pop().replace(/\.md$/i, "").replace(/^n:/, "")}».`);
      this.ctx.reloadAll();
    } catch (e) {
      toast(e.message, "error");
    }
  }
}

export { kindDot, thumbUrl };
