// Piccoli strumenti condivisi: DOM, icone, formati, menu contestuale, avvisi.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "html") el.innerHTML = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const ICONS = {
  files: '<path d="M4 4h6l2 2h8v13H4z"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
  tag: '<path d="M3 12V4h8l9 9-8 8z"/><circle cx="7.5" cy="8" r="1.4"/>',
  bookmark: '<path d="M6 3h12v18l-6-5-6 5z"/>',
  graph: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="10" cy="18" r="2.5"/><path d="M8.3 7 15.6 7.6M7 8.3l2.2 7.3M16.6 10.2l-5 5.8"/>',
  years: '<path d="M4 20V10M9 20V4M14 20v-7M19 20V8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  folderPlus: '<path d="M4 4h6l2 2h8v13H4z"/><path d="M12 10v6M9 13h6"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  read: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  note: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
};

export function icon(name, size = 18) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("width", size);
  s.setAttribute("height", size);
  s.setAttribute("fill", "none");
  s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "1.7");
  s.setAttribute("stroke-linecap", "round");
  s.setAttribute("stroke-linejoin", "round");
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = ICONS[name] || "";
  return s;
}

export const KINDS = {
  note: { label: "Nota", color: "var(--k-note)" },
  markdown: { label: "Markdown", color: "var(--k-note)" },
  pdf: { label: "PDF", color: "var(--k-pdf)" },
  image: { label: "Immagine", color: "var(--k-image)" },
  video: { label: "Video", color: "var(--k-video)" },
  audio: { label: "Audio", color: "var(--k-audio)" },
  ebook: { label: "Libro / fumetto", color: "var(--k-ebook)" },
  text: { label: "Testo", color: "var(--k-text)" },
  doc: { label: "Documento", color: "var(--k-doc)" },
  archive: { label: "Archivio", color: "var(--k-other)" },
  other: { label: "Altro", color: "var(--k-other)" },
  dir: { label: "Cartella", color: "var(--k-other)" },
  tag: { label: "Tag", color: "var(--k-tag)" },
};
export const kindLabel = (k) => (KINDS[k] || KINDS.other).label;

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function kindColor(k) {
  const v = (KINDS[k] || KINDS.other).color;
  return cssVar(v.slice(4, -1));
}

export function fmtSize(n) {
  if (n == null) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(n < 10 ? 1 : 0) : n) + " " + u[i];
}

export function fmtDate(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleString("it-IT", { dateStyle: "medium", timeStyle: "short" });
}

export const YEAR_SRC = {
  "proprietà": "dalla proprietà «anno»",
  metadati: "dai metadati del file",
  nota: "dalla data scritta nella nota",
  nome: "dal nome del file o della cartella",
  modifica: "dall'ultima modifica del file",
};

export function displayName(item) {
  if (!item) return "";
  if (item.kind === "note" && item.name.toLowerCase().endsWith(".md")) return item.name.slice(0, -3);
  return item.name;
}

/** Come scrivere un [[link]] a un elemento. */
export function linkFor(item) {
  if (item.src === "s") return "/" + item.rel;
  if (item.kind === "note") return displayName(item);
  return item.rel;
}

export function debounce(fn, ms) {
  let t;
  const d = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.flush = (...a) => {
    clearTimeout(t);
    return fn(...a);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

// ------------------------------------------------------------- avvisi

export function toast(msg, kind = "info", ms = 3500) {
  let box = document.querySelector(".toasts");
  if (!box) {
    box = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(box);
  }
  const t = h("div", { class: "toast " + kind }, msg);
  box.append(t);
  setTimeout(() => t.remove(), ms);
}

// ------------------------------------------------------------- menu contestuale

export function contextMenu(ev, entries) {
  ev.preventDefault();
  closeMenus();
  const menu = h("div", { class: "ctxmenu", role: "menu" },
    entries.filter(Boolean).map((e) => e === "-"
      ? h("div", { class: "sep" })
      : h("button", {
        role: "menuitem", class: e.danger ? "danger" : "",
        onclick: () => { closeMenus(); e.action(); },
      }, e.label)));
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(ev.clientX, innerWidth - r.width - 8) + "px";
  menu.style.top = Math.min(ev.clientY, innerHeight - r.height - 8) + "px";
  menu.querySelector("button")?.focus();
  setTimeout(() => document.addEventListener("pointerdown", onDown, { once: true }), 0);
  function onDown(e) {
    if (!menu.contains(e.target)) closeMenus();
    else document.addEventListener("pointerdown", onDown, { once: true });
  }
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenus();
    const items = [...menu.querySelectorAll("button")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  });
}

export function closeMenus() {
  document.querySelectorAll(".ctxmenu").forEach((m) => m.remove());
}

// ------------------------------------------------------------- finestre modali

export function modal(content, { onClose, wide } = {}) {
  const back = h("div", { class: "modal-back" });
  const box = h("div", { class: "modal" + (wide ? " wide" : ""), role: "dialog", "aria-modal": "true" }, content);
  back.append(box);
  document.body.append(back);
  const close = () => {
    back.remove();
    onClose?.();
  };
  back.addEventListener("pointerdown", (e) => { if (e.target === back) close(); });
  back.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
  return { close, box };
}

export function prompt(title, value = "", { okLabel = "Conferma", hint } = {}) {
  return new Promise((resolve) => {
    const input = h("input", { type: "text", value, "aria-label": title });
    let done = false;
    const finish = (v) => { if (!done) { done = true; m.close(); resolve(v); } };
    const form = h("form", {
      class: "prompt",
      onsubmit: (e) => { e.preventDefault(); finish(input.value.trim()); },
    },
    h("h2", {}, title), input, hint ? h("p", { class: "muted" }, hint) : null,
    h("div", { class: "row end" },
      h("button", { type: "button", class: "btn ghost", onclick: () => finish(null) }, "Annulla"),
      h("button", { type: "submit", class: "btn primary" }, okLabel)));
    const m = modal(form, { onClose: () => { if (!done) { done = true; resolve(null); } } });
    input.focus();
    input.select();
  });
}

export function confirmBox(title, text, okLabel = "Conferma", danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; m.close(); resolve(v); } };
    const ok = h("button", { class: "btn " + (danger ? "danger" : "primary"), onclick: () => finish(true) }, okLabel);
    const m = modal(h("div", { class: "prompt" }, h("h2", {}, title), h("p", {}, text),
      h("div", { class: "row end" },
        h("button", { class: "btn ghost", onclick: () => finish(false) }, "Annulla"), ok)),
    { onClose: () => { if (!done) { done = true; resolve(false); } } });
    ok.focus();
  });
}
