// Vista a grafo: modalità "Collegamenti" (forze) e "Anni" (colonne per anno di creazione).
import { forceSimulation, forceLink, forceManyBody, forceCollide, forceX, forceY } from "d3-force";
import { zoom, zoomIdentity } from "d3-zoom";
import { select } from "d3-selection";
import { api, isOffline } from "./api.js";
import { h, kindColor, kindLabel, cssVar, displayName, toast } from "./util.js";

const COLW = 150; // larghezza di un anno, in unità del grafo
const LANEH = 110; // altezza di una corsia (un tipo di file) nella vista per anni
const LANES = ["note", "pdf", "doc", "text", "markdown", "image", "video", "audio", "ebook", "archive", "other", "tag"];
const NOYEAR = "—";

export class GraphView {
  constructor(container, opts = {}) {
    this.opts = { scope: "global", focusId: null, depth: 1, compact: false, mode: "links", ...opts };
    this.mode = this.opts.mode;
    this.showTags = false;
    this.showSuggest = true;
    this.showOrphans = !this.opts.compact;
    this.hiddenKinds = new Set();
    this.filter = "";
    this.explored = new Map(); // anno -> numero di elementi aggiunti
    this.transform = zoomIdentity;
    this.hover = null;
    this.yearsHist = [];
    this.el = h("div", { class: "graph" + (this.opts.compact ? " compact" : "") });
    container.append(this.el);
    this.buildUI();
    if (this.mode === "years") this.setMode("years");
    this.load();
  }

  // ------------------------------------------------------------ interfaccia
  buildUI() {
    const o = this.opts;
    this.canvas = h("canvas", { class: "graph-canvas", tabindex: "0", "aria-label": "Grafo dei collegamenti" });
    this.tip = h("div", { class: "graph-tip", hidden: true });
    this.hint = h("div", { class: "graph-hint", hidden: true });
    if (!o.compact) {
      const seg = h("div", { class: "seg", role: "group", "aria-label": "Disposizione" },
        this.btnLinks = h("button", { "aria-pressed": String(this.mode === "links"), onclick: () => this.setMode("links") }, "Collegamenti"),
        this.btnYears = h("button", { "aria-pressed": String(this.mode === "years"), onclick: () => this.setMode("years") }, "Anni"));
      const tags = h("label", { class: "check" }, h("input", {
        type: "checkbox", onchange: (e) => { this.showTags = e.target.checked; this.load(); },
      }), "Tag");
      const sugg = h("label", { class: "check", title: "Collegamenti proposti dall'LLM, ancora da approvare" }, h("input", {
        type: "checkbox", checked: true, onchange: (e) => { this.showSuggest = e.target.checked; this.load(); },
      }), "Suggeriti");
      const orph = h("label", { class: "check" }, h("input", {
        type: "checkbox", checked: true, onchange: (e) => { this.showOrphans = e.target.checked; this.load(); },
      }), "Elementi senza link");
      const depth = o.scope === "local" ? h("label", { class: "check" }, "Distanza",
        h("input", {
          type: "range", min: 1, max: 3, value: o.depth,
          onchange: (e) => { this.opts.depth = +e.target.value; this.load(); },
        })) : null;
      const filter = h("input", {
        type: "search", class: "graph-filter", placeholder: "Evidenzia per nome…",
        oninput: (e) => { this.filter = e.target.value.toLowerCase(); this.draw(); },
      });
      this.legend = h("div", { class: "legend" });
      this.el.append(h("div", { class: "graph-bar" }, seg, tags, sugg, o.scope === "global" ? orph : depth, filter), this.legend);
    }
    this.el.append(this.canvas, this.tip, this.hint);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.canvas);

    this.zoomer = zoom().scaleExtent([0.05, 6])
      .filter((ev) => ev.type === "wheel" || !this.nodeAt(ev))
      .on("zoom", (ev) => { this.transform = ev.transform; this.draw(); });
    select(this.canvas).call(this.zoomer).on("dblclick.zoom", null);

    this.canvas.addEventListener("pointermove", (e) => this.onMove(e));
    this.canvas.addEventListener("pointerdown", (e) => this.onDown(e));
    this.canvas.addEventListener("pointerleave", () => { this.hover = null; this.tip.hidden = true; this.draw(); });
    this.canvas.addEventListener("click", (e) => this.onClick(e));
  }

  setMode(m) {
    this.mode = m;
    this.btnLinks?.setAttribute("aria-pressed", String(m === "links"));
    this.btnYears?.setAttribute("aria-pressed", String(m === "years"));
    if (m === "years" && !this.yearsHist.length) {
      api("/years").then((rows) => {
        const tot = new Map();
        rows.forEach((r) => tot.set(r.year, (tot.get(r.year) || 0) + r.count));
        this.yearsHist = [...tot.entries()].sort((a, b) => a[0] - b[0]);
        this.applyForces(true);
      }).catch(() => {});
    }
    this.applyForces(true);
    this.fitSoon();
  }

  setFocus(id) {
    if (this.opts.focusId === id) return;
    this.opts.focusId = id;
    this.load();
  }

  // ------------------------------------------------------------ dati
  async load() {
    const o = this.opts;
    if (o.scope === "local" && !o.focusId) { this.setData({ nodes: [], edges: [] }); return; }
    try {
      const g = await api("/graph", {
        params: {
          scope: o.scope, id: o.focusId, depth: o.depth, tags: this.showTags, orphans: this.showOrphans,
          suggest: this.showSuggest,
        },
      });
      // gli anni esplorati restano quando si ricarica
      const extra = this.nodes ? this.nodes.filter((n) => n.explored) : [];
      const ids = new Set(g.nodes.map((n) => n.id));
      g.nodes.push(...extra.filter((n) => !ids.has(n.id)));
      this.setData(g);
    } catch (e) {
      if (isOffline()) { this.setData({ nodes: [], edges: [] }); return; } // offline il grafo resta vuoto, senza avvisi
      toast(e.message, "error");
    }
  }

  setData(g) {
    const old = new Map((this.nodes || []).map((n) => [n.id, n]));
    this.allNodes = g.nodes.map((n) => {
      const p = old.get(n.id);
      return p ? Object.assign(p, n) : { ...n };
    });
    this.allEdges = g.edges;
    this.rebuild();
    if (!old.size) this.fitSoon();
  }

  rebuild() {
    const nodes = this.allNodes.filter((n) => !this.hiddenKinds.has(n.kind));
    const ids = new Set(nodes.map((n) => n.id));
    const links = this.allEdges.filter((e) => ids.has(e.source.id || e.source) && ids.has(e.target.id || e.target))
      .map((e) => ({ source: e.source.id || e.source, target: e.target.id || e.target, type: e.type }));
    this.nodes = nodes;
    this.links = links;
    this.neighbors = new Map();
    for (const l of links) {
      if (!this.neighbors.has(l.source)) this.neighbors.set(l.source, new Set());
      if (!this.neighbors.has(l.target)) this.neighbors.set(l.target, new Set());
      this.neighbors.get(l.source).add(l.target);
      this.neighbors.get(l.target).add(l.source);
    }
    this.renderLegend();
    if (this.sim) this.sim.stop();
    this.sim = forceSimulation(nodes)
      .force("link", forceLink(links).id((d) => d.id).distance(55))
      .force("charge", forceManyBody().strength(-110).distanceMax(450))
      .force("collide", forceCollide((d) => this.radius(d) + 3))
      .on("tick", () => this.draw());
    this.lanes = null;
    this.applyForces(false);
    if (this.hint) {
      this.hint.hidden = nodes.length > 0;
      this.hint.textContent = this.opts.scope === "local"
        ? "Questo elemento non ha ancora collegamenti."
        : "Il grafo è vuoto: crea una nota e collega qualcosa con [[…]].";
    }
  }

  yearsInView() {
    const ys = new Set(this.nodes.filter((n) => n.year).map((n) => n.year));
    this.yearsHist.forEach(([y]) => ys.add(y));
    const list = [...ys].sort((a, b) => a - b);
    this.minYear = list[0] ?? new Date().getFullYear();
    this.maxYear = list[list.length - 1] ?? this.minYear;
    return list;
  }

  colX(year) {
    if (!year) return -1.4 * COLW; // colonna "senza anno", a sinistra del primo anno
    return (year - this.minYear) * COLW;
  }

  lanesInView() {
    const present = new Set(this.nodes.map((n) => (n.kind === "markdown" ? "note" : n.kind)));
    this.lanes = LANES.filter((k) => present.has(k));
    return this.lanes;
  }

  laneY(kind) {
    const lanes = this.lanes || this.lanesInView();
    const i = lanes.indexOf(kind === "markdown" ? "note" : kind);
    return ((i < 0 ? lanes.length : i) - (lanes.length - 1) / 2) * LANEH;
  }

  applyForces(reheat) {
    if (!this.sim) return;
    const years = this.mode === "years";
    if (years) { this.yearsInView(); this.lanesInView(); }
    const link = this.sim.force("link");
    link.strength(years ? 0.04 : 0.35);
    this.sim.force("x", years ? forceX((d) => this.colX(d.year)).strength(0.9) : forceX(0).strength(0.04));
    this.sim.force("y", years ? forceY((d) => this.laneY(d.kind)).strength(0.6) : forceY(0).strength(0.04));
    if (reheat) this.sim.alpha(0.9).restart();
  }

  async exploreYear(year) {
    if (this.explored.has(year)) { toast(`${year} è già nel grafo.`); return; }
    try {
      const items = await api("/years/items", { params: { year, limit: 150 } });
      const have = new Set(this.allNodes.map((n) => n.id));
      const add = items.filter((i) => !have.has(i.id)).map((i) => ({
        id: i.id, name: i.name, kind: i.kind, src: i.src, year: i.year, year_src: i.year_src, degree: 0,
        explored: true, x: this.colX(i.year) + (Math.random() - 0.5) * 40, y: (Math.random() - 0.5) * 300,
      }));
      this.explored.set(year, add.length);
      this.allNodes.push(...add);
      this.rebuild();
      this.sim.alpha(0.6).restart();
      toast(add.length === 1 ? `Aggiunto 1 elemento del ${year}.`
        : add.length ? `Aggiunti ${add.length} elementi del ${year}.` : `Nessun altro elemento nel ${year}.`);
    } catch (e) {
      toast(e.message, "error");
    }
  }

  renderLegend() {
    if (!this.legend) return;
    const counts = new Map();
    this.allNodes.forEach((n) => counts.set(n.kind, (counts.get(n.kind) || 0) + 1));
    this.legend.replaceChildren(...[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) =>
      h("button", {
        class: "legend-item", "aria-pressed": String(!this.hiddenKinds.has(k)),
        title: this.hiddenKinds.has(k) ? "Mostra" : "Nascondi",
        onclick: () => {
          if (this.hiddenKinds.has(k)) this.hiddenKinds.delete(k); else this.hiddenKinds.add(k);
          this.rebuild();
        },
      }, h("span", { class: "dot", style: { background: kindColor(k) } }), `${kindLabel(k)} ${c}`)));
  }

  // ------------------------------------------------------------ disegno
  radius(d) {
    const base = this.opts.compact ? 3 : 3.5;
    const r = (d.explored ? base - 0.5 : base) + Math.sqrt(d.degree || 0) * 1.6;
    const k = this.transform?.k || 1;
    return Math.max(r, 3 / k); // mai più piccolo di 3 pixel sullo schermo
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = window.devicePixelRatio || 1;
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.dpr = dpr;
    this.draw();
  }

  fitSoon() {
    clearTimeout(this._fit);
    this._fit = setTimeout(() => this.fit(), 700);
  }

  fit() {
    if (!this.nodes?.length || !this.w) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of this.nodes) {
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y);
    }
    const pad = 60;
    const k = Math.min(2, Math.max(0.05, Math.min((this.w - pad * 2) / (x1 - x0 || 1), (this.h - pad * 2) / (y1 - y0 || 1))));
    const t = zoomIdentity.translate(this.w / 2 - k * (x0 + x1) / 2, this.h / 2 - k * (y0 + y1) / 2).scale(k);
    select(this.canvas).transition().duration(400).call(this.zoomer.transform, t);
  }

  draw() {
    const ctx = this.canvas.getContext("2d");
    if (!ctx || !this.nodes) return;
    const { w, h: hh, dpr } = this;
    const t = this.transform;
    const col = {
      bg: cssVar("--bg-graph"), edge: cssVar("--graph-edge"), edgeHi: cssVar("--accent"),
      text: cssVar("--text"), muted: cssVar("--text-faint"), grid: cssVar("--graph-grid"), bar: cssVar("--graph-bar"),
    };
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = col.bg;
    ctx.fillRect(0, 0, w, hh);

    const years = this.mode === "years";
    if (years) this.drawYearGrid(ctx, col);

    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.scale(t.k, t.k);

    const focus = this.hover?.id || null;
    const near = focus ? this.neighbors.get(focus) || new Set() : null;
    const match = this.filter ? (n) => displayName(n).toLowerCase().includes(this.filter) : null;

    // archi
    ctx.lineWidth = 1 / t.k;
    for (const l of this.links) {
      const hi = focus && (l.source.id === focus || l.target.id === focus);
      ctx.strokeStyle = hi ? col.edgeHi : col.edge;
      ctx.globalAlpha = focus && !hi ? 0.15 : hi ? 0.9 : 0.55;
      if (l.type === "suggest") {
        ctx.strokeStyle = col.edgeHi;
        if (!hi) ctx.globalAlpha = focus ? 0.15 : 0.45;
        ctx.setLineDash([6 / t.k, 4 / t.k]);
      } else if (l.type === "tag") ctx.setLineDash([3 / t.k, 3 / t.k]);
      else ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(l.source.x, l.source.y);
      ctx.lineTo(l.target.x, l.target.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // nodi
    for (const n of this.nodes) {
      const dim = (focus && n.id !== focus && !near.has(n.id)) || (match && !match(n));
      ctx.globalAlpha = dim ? 0.18 : 1;
      const r = this.radius(n);
      ctx.beginPath();
      if (n.kind === "tag") {
        ctx.rect(n.x - r, n.y - r, r * 2, r * 2);
      } else {
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      }
      const c = kindColor(n.kind);
      if (n.explored) {
        ctx.lineWidth = 1.4 / t.k;
        ctx.strokeStyle = c;
        ctx.stroke();
      } else {
        ctx.fillStyle = c;
        ctx.fill();
      }
      if (n.id === this.opts.focusId) {
        ctx.lineWidth = 2 / t.k;
        ctx.strokeStyle = col.text;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 3 / t.k, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // etichette
    const many = this.nodes.length > 160;
    const showAll = this.opts.compact ? t.k > 0.7
      : this.mode === "years" ? COLW * t.k >= 120 && LANEH * t.k >= 40
        : t.k > (many ? 1.6 : 0.85);
    ctx.font = `${12 / t.k}px ${cssVar("--font-ui") || "system-ui, sans-serif"}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const n of this.nodes) {
      const important = n.id === focus || (near && near.has(n.id)) || (match && match(n)) || n.id === this.opts.focusId;
      if (!showAll && !important && !(n.degree >= 6 && t.k > 0.5)) continue;
      const dim = (focus && !important) || (match && !match(n));
      ctx.globalAlpha = dim ? 0.25 : 0.95;
      ctx.fillStyle = n.id === focus ? col.text : col.muted;
      const label = displayName(n);
      ctx.fillText(label.length > 32 ? label.slice(0, 30) + "…" : label, n.x, n.y + this.radius(n) + 3 / t.k);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    if (years) this.drawYearAxis(ctx, col);
  }

  /** Meridiani verticali, uno per anno (sotto i nodi). */
  drawYearGrid(ctx, col) {
    const t = this.transform;
    const list = this.yearsInView();
    ctx.strokeStyle = col.grid;
    ctx.lineWidth = 1;
    for (const y of list) {
      const sx = t.applyX(this.colX(y));
      if (sx < -50 || sx > this.w + 50) continue;
      ctx.beginPath();
      ctx.moveTo(sx, 34);
      ctx.lineTo(sx, this.h - 46);
      ctx.stroke();
    }
    // corsie orizzontali, una per tipo di file
    const lanes = this.lanes || this.lanesInView();
    ctx.font = `12px ${cssVar("--font-ui") || "system-ui, sans-serif"}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    lanes.forEach((k) => {
      const sy = t.applyY(this.laneY(k));
      if (sy < 30 || sy > this.h - 44) return;
      ctx.strokeStyle = col.grid;
      ctx.beginPath();
      ctx.moveTo(0, sy - (LANEH / 2) * t.k);
      ctx.lineTo(this.w, sy - (LANEH / 2) * t.k);
      ctx.stroke();
      ctx.fillStyle = kindColor(k);
      ctx.globalAlpha = 0.85;
      ctx.fillText(kindLabel(k), 10, sy);
      ctx.globalAlpha = 1;
    });
    const nx = t.applyX(this.colX(null));
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(nx, 34);
    ctx.lineTo(nx, this.h - 46);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** Etichette degli anni in alto e istogramma dei file per anno in basso. */
  drawYearAxis(ctx, col) {
    const t = this.transform;
    const list = this.yearsInView();
    this.yearHits = [];
    const max = Math.max(1, ...this.yearsHist.map(([, c]) => c));
    const hist = new Map(this.yearsHist);
    const spacing = COLW * t.k;
    const every = spacing < 34 ? Math.ceil(34 / spacing) : 1;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // fascia superiore e inferiore
    ctx.fillStyle = col.bg;
    ctx.globalAlpha = 0.92;
    ctx.fillRect(0, 0, this.w, 30);
    ctx.fillRect(0, this.h - 44, this.w, 44);
    ctx.globalAlpha = 1;
    const nx = t.applyX(this.colX(null));
    ctx.font = `600 12px ${cssVar("--font-ui") || "system-ui, sans-serif"}`;
    ctx.fillStyle = col.muted;
    ctx.fillText(NOYEAR, nx, 16);
    for (const y of list) {
      const sx = t.applyX(this.colX(y));
      if (sx < -40 || sx > this.w + 40) continue;
      const explored = this.explored.has(y);
      if ((y - this.minYear) % every === 0 || explored) {
        ctx.font = (explored ? "700 " : "600 ") + `12px ${cssVar("--font-ui") || "system-ui, sans-serif"}`;
        ctx.fillStyle = explored ? col.edgeHi : col.text;
        ctx.fillText(String(y), sx, 16);
      }
      const c = hist.get(y) || 0;
      if (c) {
        const bh = Math.max(2, (Math.log10(c + 1) / Math.log10(max + 1)) * 30);
        const bw = Math.max(3, Math.min(spacing * 0.5, 26));
        ctx.fillStyle = explored ? col.edgeHi : col.bar;
        ctx.fillRect(sx - bw / 2, this.h - 8 - bh, bw, bh);
      }
      this.yearHits.push({ year: y, x: sx, count: c });
    }
  }

  // ------------------------------------------------------------ interazione
  toWorld(ev) {
    const r = this.canvas.getBoundingClientRect();
    return this.transform.invert([ev.clientX - r.left, ev.clientY - r.top]);
  }

  nodeAt(ev) {
    if (!this.nodes) return null;
    const [x, y] = this.toWorld(ev);
    let best = null, bd = Infinity;
    for (const n of this.nodes) {
      const d = (n.x - x) ** 2 + (n.y - y) ** 2;
      const r = this.radius(n) + 4 / this.transform.k;
      if (d < r * r && d < bd) { best = n; bd = d; }
    }
    return best;
  }

  yearAt(ev) {
    if (this.mode !== "years" || !this.yearHits) return null;
    const r = this.canvas.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    if (y > 30 && y < this.h - 44) return null;
    let best = null, bd = 22;
    for (const hit of this.yearHits) {
      const d = Math.abs(hit.x - x);
      if (d < bd) { best = hit; bd = d; }
    }
    return best;
  }

  onMove(ev) {
    if (this.drag) return;
    const n = this.nodeAt(ev);
    const yr = n ? null : this.yearAt(ev);
    if (n !== this.hover) {
      this.hover = n;
      this.draw();
    }
    this.canvas.style.cursor = n || yr ? "pointer" : "grab";
    if (n || yr) {
      const r = this.canvas.getBoundingClientRect();
      this.tip.hidden = false;
      this.tip.style.left = ev.clientX - r.left + 14 + "px";
      this.tip.style.top = ev.clientY - r.top + 10 + "px";
      if (n) {
        this.tip.replaceChildren(h("strong", {}, displayName(n)),
          h("span", {}, kindLabel(n.kind) + (n.year ? ` · ${n.year}` : "") + (n.src === "s" ? " · server" : "")));
      } else {
        this.tip.replaceChildren(h("strong", {}, String(yr.year)),
          h("span", {}, `${yr.count.toLocaleString("it-IT")} file · clic per aggiungerli`));
      }
    } else {
      this.tip.hidden = true;
    }
  }

  onDown(ev) {
    const n = this.nodeAt(ev);
    if (!n) return;
    ev.preventDefault();
    this.canvas.setPointerCapture(ev.pointerId);
    const start = [ev.clientX, ev.clientY];
    this.drag = { n, moved: false };
    const move = (e) => {
      if (Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 3) this.drag.moved = true;
      if (!this.drag.moved) return;
      const [x, y] = this.toWorld(e);
      n.fx = x;
      n.fy = y;
      this.sim.alphaTarget(0.25).restart();
    };
    const up = () => {
      this.canvas.removeEventListener("pointermove", move);
      this.canvas.removeEventListener("pointerup", up);
      n.fx = null;
      n.fy = null;
      this.sim.alphaTarget(0);
      this._suppressClick = this.drag.moved;
      this.drag = null;
    };
    this.canvas.addEventListener("pointermove", move);
    this.canvas.addEventListener("pointerup", up);
  }

  onClick(ev) {
    if (this._suppressClick) { this._suppressClick = false; return; }
    const n = this.nodeAt(ev);
    if (n) { this.opts.onOpen?.(n, ev); return; }
    const yr = this.yearAt(ev);
    if (yr) this.exploreYear(yr.year);
  }

  redraw() { this.renderLegend(); this.draw(); }

  destroy() {
    this.sim?.stop();
    this.ro?.disconnect();
    this.el.remove();
  }
}
