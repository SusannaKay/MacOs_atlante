// Atlante — struttura dell'app: barra laterale, schede, palette dei comandi, impostazioni.
import {
  api, loadConfig, saveConfig, config, isConfigured, hasBridge, isMacApp, onCommand,
  aiAvailable, aiStatus, aiModels, onAiStatus,
} from "./api.js";
import { NoteView, FileView, FolderView } from "./views.js";
import { Explorer, SearchPanel, TagsPanel, BookmarksPanel, SuggestionsPanel, InfoPanel, kindDot } from "./panels.js";
import { GraphView } from "./graph.js";
import { AgendaView, newEventDialog } from "./agenda.js";
import { h, icon, toast, modal, displayName, linkFor } from "./util.js";

const WS_KEY = "atlante-workspace";

class App {
  constructor() {
    this.tabs = [];
    this.active = null;
    this.ctx = this.makeCtx();
  }

  makeCtx() {
    const app = this;
    return {
      open: (id, o) => app.open(id, o),
      changed: (view) => app.viewChanged(view),
      status: () => app.updateWordCount(),
      searchTag: (t) => app.searchFor({ tag: t, q: "" }),
      revealInTree: (id) => { app.showPanel("files"); app.explorer.reveal(id); },
      treeChanged: () => app.explorer.refresh(),
      replaceId: (a, b) => app.replaceId(a, b),
      closeId: (id) => app.tabs.filter((t) => t.id === id || t.id?.startsWith(id + "/")).forEach((t) => app.closeTab(t)),
      reloadAll: () => app.tabs.forEach((t) => t.view.loadMeta?.()),
      newNote: (folder) => app.newNote(folder),
      toggleBookmark: (id) => app.toggleBookmark(id),
      openLocalGraph: (id) => app.openGraph("local", id),
      insertLinkInActive: (item) => app.insertLinkInActive(item),
      tagsChanged: () => app.tagsPanel?.refresh(),
      suggestionsChanged: () => app.suggestionsPanel?.refresh(),
      suggestionsCount: (n) => app.setSuggestionBadge(n),
      activeId: () => app.active?.id,
      noteChanged: (id) => app.reloadNote(id),
    };
  }

  // ------------------------------------------------------------ avvio
  async start() {
    await loadConfig();
    this.applyTheme();
    this.buildLayout();
    if (!isConfigured()) {
      this.showWelcome();
      this.openSettings(true);
      return;
    }
    this.boot();
  }

  boot() {
    this.explorer = new Explorer(this.ctx);
    this.searchPanel = new SearchPanel(this.ctx);
    this.tagsPanel = new TagsPanel(this.ctx);
    this.bookmarksPanel = new BookmarksPanel(this.ctx);
    this.suggestionsPanel = new SuggestionsPanel(this.ctx);
    this.panels = {
      files: this.explorer, search: this.searchPanel, tags: this.tagsPanel,
      bookmarks: this.bookmarksPanel, suggestions: this.suggestionsPanel,
    };
    if (aiAvailable()) {
      aiStatus().then((st) => this.showAi(st));
      onAiStatus((st) => this.showAi(st));
    }
    this.info = new InfoPanel(this.ctx);
    this.rightEl.replaceChildren(this.info.el);
    this.showPanel(localStorage.getItem("atlante-panel") || "files");
    api("/props/keys").then((keys) => this.propKeys.replaceChildren(...keys.map((k) => h("option", { value: k.key })))).catch(() => {});
    this.restoreWorkspace();
    this.pollStatus();
    clearInterval(this._poll);
    this._poll = setInterval(() => this.pollStatus(), 20_000);
  }

  applyTheme() {
    const t = config().theme || "auto";
    if (t === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.dataset.theme = t;
  }

  buildLayout() {
    const rb = (name, label, onclick) => h("button", { class: "rib-btn", "data-panel": name, title: label, "aria-label": label, onclick }, icon(name === "files" ? "files" : name, 20));
    this.ribbon = h("nav", { class: "ribbon", "aria-label": "Pannelli" },
      h("div", { class: "rib-top" },
        rb("files", "Esplora", () => this.showPanel("files")),
        rb("search", "Cerca (⇧⌘F)", () => this.showPanel("search", true)),
        rb("tag", "Tag", () => this.showPanel("tags")),
        rb("bookmark", "Segnalibri", () => this.showPanel("bookmarks")),
        this.sgBtn = h("button", {
          class: "rib-btn", "data-panel": "spark", title: "Suggerimenti", "aria-label": "Suggerimenti di collegamento",
          onclick: () => this.showPanel("suggestions"),
        }, icon("spark", 20), this.sgBadge = h("span", { class: "rib-badge", hidden: true })),
        h("span", { class: "rib-sep" }),
        h("button", { class: "rib-btn", title: "Grafo (⌘G)", "aria-label": "Apri il grafo", onclick: () => this.openGraph("global") }, icon("graph", 20)),
        h("button", { class: "rib-btn", title: "Grafo per anni", "aria-label": "Apri il grafo per anni", onclick: () => this.openGraph("global", null, "years") }, icon("years", 20)),
        h("button", { class: "rib-btn", title: "Agenda", "aria-label": "Apri l'agenda", onclick: () => this.openAgenda() }, icon("calendar", 20)),
        h("button", { class: "rib-btn", title: "Nuova nota (⌘N)", "aria-label": "Nuova nota", onclick: () => this.newNote() }, icon("note", 20))),
      h("div", { class: "rib-bottom" },
        h("button", { class: "rib-btn", title: "Impostazioni", "aria-label": "Impostazioni", onclick: () => this.openSettings() }, icon("settings", 20))));
    this.leftEl = h("div", { class: "left" });
    this.tabbar = h("div", { class: "tabbar", role: "tablist" });
    this.rightToggle = h("button", {
      class: "icon-btn", title: "Mostra/nascondi il pannello informazioni", "aria-label": "Pannello informazioni",
      onclick: () => this.toggleRight(),
    }, icon("panel"));
    this.stage = h("main", { class: "stage" });
    this.rightEl = h("div", { class: "right" });
    this.statusEl = h("footer", { class: "statusbar" }, h("span", { class: "st-conn" }), h("span", { class: "st-words" }),
      h("span", { class: "st-index" }),
      this.aiChip = h("button", { class: "st-ai", hidden: true, onclick: () => this.showPanel("suggestions") }));
    this.propKeys = h("datalist", { id: "atlante-propkeys" });
    document.body.replaceChildren(
      h("div", { class: "app" + (isMacApp() ? " mac" : "") },
        this.ribbon,
        this.leftEl,
        h("div", { class: "center" },
          h("div", { class: "tabbar-wrap" }, this.tabbar, h("div", { class: "spacer drag" }), this.rightToggle),
          this.stage),
        this.rightEl),
      this.statusEl,
      h("datalist", { id: "atlante-tags" }),
      this.propKeys);
    if (localStorage.getItem("atlante-right") === "0") document.body.classList.add("no-right");
    this.bindKeys();
  }

  showWelcome() {
    this.stage.replaceChildren(h("div", { class: "welcome" },
      h("h1", {}, "Atlante"),
      h("p", {}, "Collega l'app al motore sul tuo server per vedere e organizzare i tuoi file.")));
  }

  showPanel(name, focus = false) {
    if (!this.panels) return;
    this.panelName = name;
    localStorage.setItem("atlante-panel", name);
    this.leftEl.replaceChildren(this.panels[name].el);
    this.ribbon.querySelectorAll("[data-panel]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.panel === ({ tags: "tag", bookmarks: "bookmark", suggestions: "spark" }[name] || name))));
    if (name === "tags") this.tagsPanel.refresh();
    if (name === "bookmarks") this.bookmarksPanel.refresh();
    if (name === "suggestions") this.suggestionsPanel.refresh();
    if (focus && name === "search") this.searchPanel.focus();
  }

  toggleRight() {
    document.body.classList.toggle("no-right");
    localStorage.setItem("atlante-right", document.body.classList.contains("no-right") ? "0" : "1");
  }

  // ------------------------------------------------------------ schede
  async open(id, { newTab = false } = {}) {
    const existing = this.tabs.find((t) => t.id === id);
    if (existing) { this.activate(existing); return; }
    let type = "file";
    if (id === "s:" || id === "n:") type = "folder";
    else if (id.startsWith("n:") && id.toLowerCase().endsWith(".md")) type = "note";
    else {
      try {
        const it = await api("/item", { params: { id } });
        if (it.is_dir) type = "folder";
      } catch (e) { toast(e.message, "error"); return; }
    }
    const reuse = !newTab && this.active && !["graph", "agenda"].includes(this.active.type) ? this.active : null;
    const tab = reuse || this.createTab();
    if (reuse) { await reuse.view.beforeClose?.(); reuse.view.destroy(); }
    tab.id = id;
    tab.type = type;
    tab.host.replaceChildren();
    const V = type === "note" ? NoteView : type === "folder" ? FolderView : FileView;
    tab.view = new V(tab.host, id, this.ctx);
    this.activate(tab);
    this.saveWorkspace();
  }

  createTab() {
    const tab = { key: Math.random().toString(36).slice(2) };
    tab.host = h("div", { class: "tab-host" });
    tab.label = h("span", { class: "tab-label" });
    tab.el = h("div", { class: "tab", role: "tab", tabindex: "0" },
      tab.label,
      h("button", { class: "tab-x", "aria-label": "Chiudi scheda", onclick: (e) => { e.stopPropagation(); this.closeTab(tab); } }, icon("close", 12)));
    tab.el.addEventListener("click", () => this.activate(tab));
    tab.el.addEventListener("auxclick", (e) => { if (e.button === 1) this.closeTab(tab); });
    this.tabbar.append(tab.el);
    this.stage.querySelector(".welcome")?.remove();
    this.stage.append(tab.host);
    this.tabs.push(tab);
    return tab;
  }

  activate(tab) {
    this.active = tab;
    // nell'agenda il pannello informazioni non serve: lo nascondo senza toccare la tua preferenza
    document.body.classList.toggle("agenda-active", tab.type === "agenda");
    this.tabs.forEach((t) => {
      t.host.hidden = t !== tab;
      t.el.classList.toggle("active", t === tab);
      t.el.setAttribute("aria-selected", String(t === tab));
    });
    this.refreshTabLabel(tab);
    tab.view?.activate?.();
    tab.view?.graph?.resize?.();
    this.explorer?.highlight(tab.id);
    this.info?.update(["graph", "agenda"].includes(tab.type) ? null : tab.view);
    this.updateWordCount();
    this.saveWorkspace();
  }

  refreshTabLabel(tab) {
    const title = tab.view?.title || "…";
    const ic = { graph: "graph", agenda: "calendar" }[tab.type];
    tab.label.replaceChildren(...(ic ? [icon(ic, 13)] : []), title);
    tab.el.title = tab.id ? (tab.id.startsWith("n:") ? "Note/" : "Server/") + tab.id.slice(2) : title;
    if (tab === this.active) document.title = `${title} — Atlante`;
  }

  viewChanged(view) {
    const tab = this.tabs.find((t) => t.view === view);
    if (!tab) return;
    this.refreshTabLabel(tab);
    if (tab === this.active) { this.info?.update(view); this.updateWordCount(); }
  }

  async closeTab(tab) {
    await tab.view?.beforeClose?.();
    tab.view?.destroy();
    tab.el.remove();
    tab.host.remove();
    const i = this.tabs.indexOf(tab);
    this.tabs.splice(i, 1);
    if (this.active === tab) {
      const next = this.tabs[Math.min(i, this.tabs.length - 1)];
      if (next) this.activate(next);
      else { this.active = null; document.body.classList.remove("agenda-active"); this.info?.update(null); this.showEmpty(); }
    }
    this.saveWorkspace();
  }

  showEmpty() {
    this.stage.querySelector(".welcome")?.remove();
    const key = (k) => h("kbd", {}, k);
    this.stage.append(h("div", { class: "welcome" },
      h("h1", {}, "Atlante"),
      h("ul", { class: "welcome-actions" },
        h("li", {}, h("button", { class: "link-btn", onclick: () => this.quickOpen() }, "Apri una nota o un file"), key("⌘O")),
        h("li", {}, h("button", { class: "link-btn", onclick: () => this.newNote() }, "Crea una nota"), key("⌘N")),
        h("li", {}, h("button", { class: "link-btn", onclick: () => this.openGraph("global") }, "Guarda il grafo"), key("⌘G")),
        h("li", {}, h("button", { class: "link-btn", onclick: () => this.openGraph("global", null, "years") }, "Sfoglia per anni")),
        h("li", {}, h("button", { class: "link-btn", onclick: () => this.openAgenda() }, "Apri l'agenda")),
        h("li", {}, h("button", { class: "link-btn", onclick: () => this.palette() }, "Tutti i comandi"), key("⌘P")))));
  }

  replaceId(oldId, newId) {
    for (const t of this.tabs) {
      if (t.id === oldId) t.id = newId;
      else if (t.id?.startsWith(oldId.replace(/\.md$/i, "") + "/")) t.id = newId.replace(/\.md$/i, "") + t.id.slice(oldId.replace(/\.md$/i, "").length);
    }
    this.saveWorkspace();
  }

  openGraph(scope, id = null, mode = "links") {
    const gid = scope === "local" ? "graph:local:" + id : "graph:global";
    let tab = this.tabs.find((t) => t.id === gid);
    if (tab) {
      if (mode === "years" && tab.view.graph.mode !== "years") tab.view.graph.setMode("years");
      this.activate(tab);
      return;
    }
    tab = this.createTab();
    tab.id = gid;
    tab.type = "graph";
    const title = scope === "local" ? "Grafo: " + displayName({ name: id.split("/").pop(), kind: id.endsWith(".md") ? "note" : "" }) : "Grafo";
    const graph = new GraphView(tab.host, {
      scope, focusId: id, depth: 2, mode,
      onOpen: (n) => (n.kind === "tag" ? this.searchFor({ tag: n.id.slice(4), q: "" }) : this.open(n.id, { newTab: true })),
    });
    tab.view = { title, graph, destroy: () => graph.destroy(), activate: () => graph.resize(), loadMeta: () => graph.load() };
    this.activate(tab);
  }

  openAgenda() {
    let tab = this.tabs.find((t) => t.id === "agenda");
    if (tab) { this.activate(tab); return; }
    tab = this.createTab();
    tab.id = "agenda";
    tab.type = "agenda";
    tab.view = new AgendaView(tab.host, this.ctx);
    this.activate(tab);
  }

  async newEvent() {
    const id = await newEventDialog();
    if (!id) return;
    this.explorer.refresh();
    this.tabs.find((t) => t.type === "agenda")?.view.load();
    this.open(id, { newTab: true });
  }

  /** Una nota è stata cambiata da fuori (es. una todo spuntata dall'agenda): ricarico le schede aperte. */
  reloadNote(id) {
    for (const t of this.tabs) {
      if (t.id !== id || !(t.view instanceof NoteView)) continue;
      if (!t.view.dirty) t.view.load(); // se la stai modificando, al salvataggio compare l'avviso di conflitto
    }
  }

  saveWorkspace() {
    const ws = {
      tabs: this.tabs.map((t) => ({ id: t.id, type: t.type, mode: t.view?.graph?.mode })),
      active: this.tabs.indexOf(this.active),
    };
    try { localStorage.setItem(WS_KEY, JSON.stringify(ws)); } catch { /* niente */ }
  }

  async restoreWorkspace() {
    let ws = null;
    try { ws = JSON.parse(localStorage.getItem(WS_KEY) || "null"); } catch { /* niente */ }
    if (!ws?.tabs?.length) { this.showEmpty(); return; }
    for (const t of ws.tabs) {
      if (!t.id) continue;
      if (t.type === "agenda") { this.openAgenda(); continue; }
      if (t.type === "graph") {
        if (t.id === "graph:global") this.openGraph("global", null, t.mode || "links");
        else this.openGraph("local", t.id.slice("graph:local:".length));
      } else {
        await this.open(t.id, { newTab: true });
      }
    }
    const a = this.tabs[ws.active] || this.tabs[0];
    if (a) this.activate(a); else this.showEmpty();
  }

  // ------------------------------------------------------------ azioni
  async newNote(folder = "") {
    try {
      const r = await api("/note/create", { method: "POST", body: { folder, name: "Senza titolo" } });
      this.explorer.refresh();
      await this.open(r.id);
      setTimeout(() => {
        const t = this.active?.view?.titleInput;
        if (t) { t.focus(); t.select(); }
      }, 300);
    } catch (e) { toast(e.message, "error"); }
  }

  async toggleBookmark(id) {
    try {
      const it = await api("/item", { params: { id } });
      await api("/bookmarks", { method: "POST", body: { id, on: !it.bookmarked } });
      toast(it.bookmarked ? "Tolto dai segnalibri." : "Aggiunto ai segnalibri.");
      this.bookmarksPanel.refresh();
      this.tabs.filter((t) => t.id === id).forEach((t) => t.view.loadMeta?.());
    } catch (e) { toast(e.message, "error"); }
  }

  insertLinkInActive(item) {
    const v = this.active?.view;
    if (!(v instanceof NoteView)) { toast("Apri prima una nota in cui inserire il link.", "error"); return; }
    v.insertLink(item);
  }

  searchFor(params) {
    this.showPanel("search");
    this.searchPanel.set({ q: "", kind: "", year: "", prop: "", tag: "", ...params });
  }

  setSuggestionBadge(n) {
    if (!this.sgBadge) return;
    this.sgBadge.hidden = !n;
    this.sgBadge.textContent = n > 99 ? "99+" : String(n);
  }

  showAi(st) {
    if (!st || !this.aiChip) return;
    this.aiStatusLast = st;
    const on = st.state !== "off";
    this.aiChip.hidden = !on;
    if (on) {
      const s = st.stats;
      const progress = s ? ` · ${s.profiled.toLocaleString("it-IT")}/${s.total.toLocaleString("it-IT")} letti` : "";
      this.aiChip.className = "st-ai " + st.state;
      this.aiChip.replaceChildren(icon("spark", 12), ` ${st.message}${progress}`);
      this.aiChip.title = "Analisi con Ollama: apri i suggerimenti";
      if (s) this.setSuggestionBadge(s.pending);
    }
    this.settingsAi?.(st);
  }

  updateWordCount() {
    const v = this.active?.view;
    const el = this.statusEl.querySelector(".st-words");
    if (v instanceof NoteView && v.text != null) {
      const n = v.wordCount();
      el.textContent = n === 1 ? "1 parola" : `${n.toLocaleString("it-IT")} parole`;
    } else el.textContent = "";
  }

  async pollStatus() {
    const conn = this.statusEl.querySelector(".st-conn");
    const idx = this.statusEl.querySelector(".st-index");
    try {
      const s = await api("/status");
      conn.className = "st-conn ok";
      conn.textContent = `${(s.items.s || 0).toLocaleString("it-IT")} file sul server · ${(s.items.n || 0).toLocaleString("it-IT")} nel vault`;
      if (s.scanning) idx.textContent = `Indicizzazione in corso: ${s.scanned.toLocaleString("it-IT")} elementi letti`;
      else if (s.pending_enrich) idx.textContent = `Lettura del testo: ${s.pending_enrich.toLocaleString("it-IT")} file in coda`;
      else idx.textContent = "";
    } catch (e) {
      conn.className = "st-conn err";
      conn.textContent = e.message;
      idx.textContent = "";
    }
  }

  // ------------------------------------------------------------ tastiera
  bindKeys() {
    const run = (cmd) => this.command(cmd);
    onCommand(run);
    document.addEventListener("keydown", (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (hasBridge()) return; // nell'app Mac le scorciatoie arrivano dal menu
      const k = e.key.toLowerCase();
      const map = { n: "note:new", o: "quick:open", p: "palette:open", w: "tab:close", e: "note:toggle-mode", g: "graph:open" };
      if (e.shiftKey && k === "f") { e.preventDefault(); run("search:open"); return; }
      if (map[k] && !e.shiftKey && !e.altKey) { e.preventDefault(); run(map[k]); }
    });
  }

  command(cmd) {
    if (!this.panels && cmd !== "settings") return;
    const v = this.active?.view;
    switch (cmd) {
      case "note:new": this.newNote(); break;
      case "quick:open": this.quickOpen(); break;
      case "palette:open": this.palette(); break;
      case "tab:close": if (this.active) this.closeTab(this.active); break;
      case "note:toggle-mode": if (v instanceof NoteView) v.toggleMode(); break;
      case "graph:open": this.openGraph("global"); break;
      case "search:open": this.showPanel("search", true); break;
      default: break;
    }
  }

  commands() {
    const v = this.active?.view;
    const id = this.active?.id;
    const item = v?.item;
    return [
      { label: "Nuova nota", key: "⌘N", run: () => this.newNote() },
      { label: "Apri rapidamente una nota o un file", key: "⌘O", run: () => this.quickOpen() },
      { label: "Cerca nel server", key: "⇧⌘F", run: () => this.showPanel("search", true) },
      { label: "Apri il grafo", key: "⌘G", run: () => this.openGraph("global") },
      { label: "Apri il grafo per anni", run: () => this.openGraph("global", null, "years") },
      { label: "Apri l'agenda", run: () => this.openAgenda() },
      { label: "Nuovo evento", run: () => this.newEvent() },
      item && !item.is_dir ? { label: "Apri il grafo locale di questo elemento", run: () => this.openGraph("local", id) } : null,
      v instanceof NoteView ? { label: "Passa tra modifica e lettura", key: "⌘E", run: () => v.toggleMode() } : null,
      item ? { label: item.bookmarked ? "Togli dai segnalibri" : "Aggiungi ai segnalibri", run: () => this.toggleBookmark(id) } : null,
      item ? { label: "Copia il link a questo elemento", run: () => { navigator.clipboard.writeText(`[[${linkFor(item)}]]`); toast("Link copiato."); } } : null,
      item ? { label: "Mostra nell'albero dei file", run: () => this.ctx.revealInTree(id) } : null,
      v instanceof NoteView ? { label: "Inserisci un link…", run: () => this.quickOpen((it) => v.insertLink(it)) } : null,
      { label: "Nuova cartella nel vault", run: () => this.explorer.newFolder("n:") },
      { label: "Apri la cartella Note", run: () => this.open("n:") },
      { label: "Apri la radice del server", run: () => this.open("s:") },
      { label: "Mostra/nascondi il pannello informazioni", run: () => this.toggleRight() },
      { label: "Ricontrolla tutto il disco ora", run: async () => { await api("/rescan", { method: "POST" }); toast("Ricontrollo del disco avviato."); } },
      { label: "Chiudi scheda", key: "⌘W", run: () => this.active && this.closeTab(this.active) },
      { label: "Chiudi tutte le schede", run: () => [...this.tabs].forEach((t) => this.closeTab(t)) },
      { label: "Impostazioni", run: () => this.openSettings() },
    ].filter(Boolean);
  }

  palette() {
    this.picker({
      placeholder: "Scrivi un comando…",
      source: async (q) => {
        const ql = q.toLowerCase();
        return this.commands().filter((c) => c.label.toLowerCase().includes(ql));
      },
      render: (c) => [h("span", {}, c.label), c.key ? h("kbd", {}, c.key) : null],
      choose: (c) => c.run(),
    });
  }

  quickOpen(onPick) {
    this.picker({
      placeholder: onPick ? "Cosa vuoi collegare?" : "Apri una nota o un file… (⇧Invio crea una nota)",
      source: (q) => api("/quick", { params: { q, limit: 40 } }),
      render: (it) => [kindDot(it.is_dir ? "dir" : it.kind), h("span", { class: "pick-name" }, displayName(it)),
        h("span", { class: "pick-path" }, (it.src === "n" ? "Note/" : "Server/") + it.rel.split("/").slice(0, -1).join("/"))],
      choose: (it, e) => (onPick ? onPick(it) : this.open(it.id, { newTab: e?.metaKey || e?.ctrlKey })),
      create: onPick ? null : async (q) => {
        if (!q.trim()) return;
        const r = await api("/note/create", { method: "POST", body: { name: q.trim() } });
        this.explorer.refresh();
        this.open(r.id);
      },
    });
  }

  picker({ placeholder, source, render, choose, create }) {
    const input = h("input", { type: "text", class: "pick-input", placeholder, "aria-label": placeholder });
    const list = h("div", { class: "pick-list", role: "listbox" });
    let items = [];
    let sel = 0;
    let seq = 0;
    const m = modal(h("div", { class: "picker" }, input, list), { wide: true });
    const draw = () => {
      list.replaceChildren(...items.map((it, i) => {
        const row = h("div", { class: "pick-row" + (i === sel ? " sel" : ""), role: "option", "aria-selected": String(i === sel) }, render(it));
        row.addEventListener("mousemove", () => { if (sel !== i) { sel = i; draw(); } });
        row.addEventListener("click", (e) => { m.close(); choose(it, e); });
        return row;
      }));
      if (!items.length) list.append(h("p", { class: "pick-empty" }, create && input.value.trim() ? `Nessun risultato. ⇧Invio per creare la nota «${input.value.trim()}».` : "Nessun risultato."));
      list.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
    };
    const refresh = async () => {
      const my = ++seq;
      try {
        const r = await source(input.value);
        if (my !== seq) return;
        items = r;
        sel = 0;
        draw();
      } catch (e) { list.replaceChildren(h("p", { class: "pick-empty" }, e.message)); }
    };
    input.addEventListener("input", refresh);
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); draw(); }
      if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey && create) { m.close(); create(input.value); return; }
        if (items[sel]) { m.close(); choose(items[sel], e); }
      }
    });
    input.focus();
    refresh();
  }

  // ------------------------------------------------------------ impostazioni
  openSettings(first = false) {
    const c = config();
    const url = h("input", { type: "url", value: c.url || "", placeholder: "https://server.tailnet.ts.net:8102", required: true });
    const token = h("input", { type: "password", value: "", placeholder: c.token ? "Già salvato: lascia vuoto per non cambiarlo" : "Incolla il token", autocomplete: "off" });
    const theme = h("select", {},
      h("option", { value: "auto" }, "Come il Mac"), h("option", { value: "dark" }, "Scuro"), h("option", { value: "light" }, "Chiaro"));
    theme.value = c.theme || "auto";
    const msg = h("p", { class: "settings-msg", role: "status" });

    // analisi con Ollama (solo nell'app per Mac)
    let aiBox = null;
    const aiOn = h("input", { type: "checkbox", checked: c.aiEnabled });
    const aiModel = h("select", {}, h("option", { value: c.aiModel || "" }, c.aiModel || "Caricamento modelli…"));
    const aiBattery = h("input", { type: "checkbox", checked: c.aiBattery !== false });
    const aiState = h("p", { class: "settings-msg" });
    if (aiAvailable()) {
      aiModels().then((r) => {
        if (!r.ok) {
          aiModel.replaceChildren(h("option", { value: c.aiModel || "" }, c.aiModel || "Ollama non risponde"));
          aiState.textContent = "Ollama non risponde: aprilo sul Mac e riapri le impostazioni.";
          return;
        }
        if (!r.models.length) {
          aiModel.replaceChildren(h("option", { value: "" }, "Nessun modello installato"));
          aiState.textContent = "Scarica un modello con «ollama pull» e riapri le impostazioni.";
          return;
        }
        aiModel.replaceChildren(...r.models.map((m) => h("option", { value: m.name },
          `${m.name}  (${(m.size / 1e9).toFixed(1)} GB)`)));
        aiModel.value = c.aiModel && r.models.some((m) => m.name === c.aiModel) ? c.aiModel : r.models[0].name;
      });
      this.settingsAi = (st) => {
        if (!aiState.isConnected) { this.settingsAi = null; return; }
        const s = st.stats;
        aiState.textContent = st.state === "off" ? "Spenta." : st.message +
          (s ? ` Letti ${s.profiled.toLocaleString("it-IT")} su ${s.total.toLocaleString("it-IT")}; ${s.pending} suggerimenti da rivedere, ${s.accepted} accettati.` +
            (s.wiki != null ? ` Pagine nella wiki: ${s.wiki}.` : "") : "");
      };
      aiStatus().then((st) => this.settingsAi?.(st));
      aiBox = h("fieldset", { class: "settings-ai" },
        h("legend", {}, "Collegamenti automatici con Ollama"),
        h("p", { class: "muted small" }, "L'app legge i file del server con un modello sul tuo Mac e propone collegamenti da approvare. Funziona mentre Atlante è aperta; niente esce da casa."),
        h("label", { class: "check" }, aiOn, "Attiva l'analisi"),
        h("label", {}, "Modello", aiModel),
        h("label", { class: "check" }, aiBattery, "Metti in pausa quando il Mac va a batteria"),
        aiState);
    }

    const test = async () => {
      msg.className = "settings-msg";
      msg.textContent = "Controllo il collegamento…";
      try {
        const s = await api("/status", { override: { url: url.value.replace(/\/+$/, ""), token: token.value || c.token } });
        msg.className = "settings-msg ok";
        msg.textContent = `Collegato. ${(s.items.s || 0).toLocaleString("it-IT")} file sul server, ${(s.items.n || 0).toLocaleString("it-IT")} nel vault.`;
        return true;
      } catch (e) {
        msg.className = "settings-msg err";
        msg.textContent = e.message;
        return false;
      }
    };
    const form = h("form", {
      class: "settings",
      onsubmit: async (e) => {
        e.preventDefault();
        if (!(await test())) return;
        try {
          await saveConfig({
            url: url.value, token: token.value || undefined, theme: theme.value,
            ...(aiBox ? { aiEnabled: aiOn.checked && Boolean(aiModel.value), aiModel: aiModel.value, aiBattery: aiBattery.checked } : {}),
          });
        } catch (err) {
          msg.className = "settings-msg err";
          msg.textContent = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
          return;
        }
        this.applyTheme();
        m.close();
        if (!this.panels) this.boot();
        else { this.explorer.refresh(); this.pollStatus(); }
      },
    },
    h("h2", {}, first ? "Collega Atlante al server" : "Impostazioni"),
    first ? h("p", { class: "muted" }, "Trovi indirizzo e token nelle istruzioni di installazione del motore sul server.") : null,
    h("label", {}, "Indirizzo del server", url),
    h("label", {}, "Token di accesso", token),
    h("label", {}, "Tema", theme),
    aiBox,
    msg,
    h("div", { class: "row end" },
      h("button", { type: "button", class: "btn ghost", onclick: test }, "Prova il collegamento"),
      h("button", { type: "submit", class: "btn primary" }, "Salva")));
    const m = modal(form);
    (first ? url : theme).focus();
    theme.addEventListener("change", () => { document.documentElement.dataset.theme = theme.value; if (theme.value === "auto") document.documentElement.removeAttribute("data-theme"); });
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const app = new App();
  window.__atlante = app;
  app.start();
});
