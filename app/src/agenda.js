// Atlante — Agenda: calendario del mese con eventi e scadenze, e lista «Da fare».
// Gli eventi sono note con `tipo: evento` e `data:`; le todo sono le righe "- [ ] cosa 📅 2026-10-25".
import { api } from "./api.js";
import { h, icon, toast, modal } from "./util.js";

const MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto",
  "settembre", "ottobre", "novembre", "dicembre"];
const GIORNI = ["lun", "mar", "mer", "gio", "ven", "sab", "dom"];
const MAX_IN_DAY = 3;

const pad = (n) => String(n).padStart(2, "0");
export const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromIso = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const shortDate = (s) => { const d = fromIso(s); return `${d.getDate()} ${MESI[d.getMonth()].slice(0, 3)}`; };
const stateClass = (s) => "st-" + (s || "idea").replace(/\s+/g, "-");

/** Finestra per creare un evento: nome, data, ora e luogo. Restituisce l'id della nota o null. */
export function newEventDialog(date = iso(new Date())) {
  return new Promise((resolve) => {
    const name = h("input", { type: "text", placeholder: "Es. Festa di Halloween", "aria-label": "Nome dell'evento", required: true });
    const day = h("input", { type: "date", value: date, "aria-label": "Data", required: true });
    const time = h("input", { type: "time", "aria-label": "Ora (facoltativa)" });
    const place = h("input", { type: "text", placeholder: "Facoltativo", "aria-label": "Luogo" });
    const err = h("p", { class: "form-err", hidden: true });
    let done = false;
    const finish = (v) => { if (!done) { done = true; m.close(); resolve(v); } };
    const form = h("form", {
      class: "prompt event-form",
      onsubmit: async (e) => {
        e.preventDefault();
        if (!name.value.trim() || !day.value) return;
        try {
          const r = await api("/event/create", { method: "POST", body: { name: name.value.trim(), date: day.value, ora: time.value, luogo: place.value.trim() } });
          finish(r.id);
        } catch (ex) { err.hidden = false; err.textContent = ex.message; }
      },
    },
    h("h2", {}, "Nuovo evento"),
    h("label", {}, h("span", {}, "Nome"), name),
    h("div", { class: "row" }, h("label", {}, h("span", {}, "Data"), day), h("label", {}, h("span", {}, "Ora"), time)),
    h("label", {}, h("span", {}, "Luogo"), place),
    h("p", { class: "muted small" }, "La nota parte dal modello in Note/_modelli/evento.md, con le scadenze calcolate su questa data."),
    err,
    h("div", { class: "row end" },
      h("button", { type: "button", class: "btn ghost", onclick: () => finish(null) }, "Annulla"),
      h("button", { type: "submit", class: "btn primary" }, "Crea evento")));
    const m = modal(form, { onClose: () => { if (!done) { done = true; resolve(null); } } });
    name.focus();
  });
}

/** Finestra per una todo veloce (senza evento): finisce in Note/Da fare.md con la sua data. */
export function newTaskDialog(date = iso(new Date())) {
  return new Promise((resolve) => {
    const text = h("input", { type: "text", placeholder: "Es. Chiamare il fornitore", "aria-label": "Cosa c'è da fare", required: true });
    const day = h("input", { type: "date", value: date, "aria-label": "Giorno" });
    const err = h("p", { class: "form-err", hidden: true });
    let done = false;
    const finish = (v) => { if (!done) { done = true; m.close(); resolve(v); } };
    const form = h("form", {
      class: "prompt event-form",
      onsubmit: async (e) => {
        e.preventDefault();
        if (!text.value.trim()) return;
        try {
          finish(await api("/task/add", { method: "POST", body: { text: text.value.trim(), due: day.value } }));
        } catch (ex) { err.hidden = false; err.textContent = ex.message; }
      },
    },
    h("h2", {}, "Nuova todo"),
    h("label", {}, h("span", {}, "Cosa c'è da fare"), text),
    h("label", {}, h("span", {}, "Giorno"), day),
    h("p", { class: "muted small" }, "Le todo senza evento finiscono in Note/Da fare.md, ognuna con la sua data."),
    err,
    h("div", { class: "row end" },
      h("button", { type: "button", class: "btn ghost", onclick: () => finish(null) }, "Annulla"),
      h("button", { type: "submit", class: "btn primary" }, "Aggiungi")));
    const m = modal(form, { onClose: () => { if (!done) { done = true; resolve(null); } } });
    text.focus();
  });
}

export class AgendaView {
  constructor(container, ctx) {
    this.ctx = ctx;
    this.title = "Agenda";
    const now = new Date();
    this.month = new Date(now.getFullYear(), now.getMonth(), 1);
    this.showDone = localStorage.getItem("atlante-agenda-done") === "1";
    this.el = h("div", { class: "view agenda-view" });
    container.append(this.el);
    this.build();
    this.load();
    this._timer = setInterval(() => { if (!this.el.closest("[hidden]")) this.load(); }, 60_000);
  }

  build() {
    this.monthLabel = h("h2", { class: "ag-month" });
    this.grid = h("div", { class: "ag-grid", role: "grid" });
    this.todo = h("div", { class: "ag-todo" });
    const doneToggle = h("input", { type: "checkbox", checked: this.showDone, onchange: (e) => {
      this.showDone = e.target.checked;
      localStorage.setItem("atlante-agenda-done", this.showDone ? "1" : "0");
      this.load();
    } });
    this.el.replaceChildren(
      h("header", { class: "view-head ag-head" },
        h("button", { class: "icon-btn flip", title: "Mese precedente", "aria-label": "Mese precedente", onclick: () => this.shift(-1) }, icon("chevron")),
        h("button", { class: "btn small ghost", onclick: () => this.today() }, "Oggi"),
        h("button", { class: "icon-btn", title: "Mese successivo", "aria-label": "Mese successivo", onclick: () => this.shift(1) }, icon("chevron")),
        this.monthLabel,
        h("div", { class: "spacer" }),
        h("label", { class: "check small" }, doneToggle, "Mostra le todo fatte"),
        h("button", { class: "btn small", onclick: () => this.newTask() }, icon("plus", 14), "Todo"),
        h("button", { class: "btn small primary", onclick: () => this.newEvent() }, icon("plus", 14), "Nuovo evento")),
      h("div", { class: "ag-body" },
        h("section", { class: "ag-cal", "aria-label": "Calendario" },
          h("div", { class: "ag-dow" }, GIORNI.map((g) => h("span", {}, g))),
          this.grid),
        h("aside", { class: "ag-side", "aria-label": "Da fare" }, h("h3", {}, "Da fare"), this.todo)));
  }

  shift(n) { this.month = new Date(this.month.getFullYear(), this.month.getMonth() + n, 1); this.load(); }
  today() { const t = new Date(); this.month = new Date(t.getFullYear(), t.getMonth(), 1); this.load(); }

  range() {
    const first = this.month;
    const start = addDays(first, -((first.getDay() + 6) % 7)); // lunedì della prima settimana
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
    const end = addDays(last, 6 - ((last.getDay() + 6) % 7));
    return { start, end };
  }

  async load() {
    const { start, end } = this.range();
    const seq = (this.seq = (this.seq || 0) + 1);
    try {
      const [cal, todo] = await Promise.all([
        api("/agenda", { params: { start: iso(start), end: iso(end) } }),
        api("/tasks"),
      ]);
      if (seq !== this.seq) return;
      this.data = cal;
      this.drawCalendar(start, end, cal);
      this.drawTodo(todo);
    } catch (e) {
      if (e.status === 404) {
        this.grid.replaceChildren(h("div", { class: "empty" }, h("p", {}, "Il motore sul server va aggiornato per usare l'agenda (versione 1.4 o successiva).")));
      } else toast(e.message, "error");
    }
  }

  drawCalendar(start, end, { events, tasks }) {
    this.monthLabel.textContent = `${MESI[this.month.getMonth()]} ${this.month.getFullYear()}`;
    const byDay = {};
    for (const e of events) (byDay[e.date] ||= { events: [], tasks: [] }).events.push(e);
    for (const t of tasks) if (this.showDone || !t.done) (byDay[t.due] ||= { events: [], tasks: [] }).tasks.push(t);
    const todayIso = iso(new Date());
    this.byDay = byDay;
    const cells = [];
    for (let d = start; d <= end; d = addDays(d, 1)) {
      const key = iso(d);
      const day = byDay[key] || { events: [], tasks: [] };
      const out = d.getMonth() !== this.month.getMonth();
      const open = day.tasks.filter((t) => !t.done);
      const late = open.length && key < todayIso;
      const evs = day.events.map((e) => this.eventChip(e));
      const extra = evs.length - MAX_IN_DAY;
      cells.push(h("div", {
        class: "ag-day" + (out ? " out" : "") + (key === todayIso ? " today" : ""), role: "gridcell",
        title: "Doppio clic per aggiungere una todo o un evento in questo giorno",
        ondblclick: () => this.dayPopup(key, day),
      },
      h("span", { class: "ag-num" }, d.getDate()),
      h("div", { class: "ag-items" },
        extra > 0 ? evs.slice(0, MAX_IN_DAY - 1) : evs,
        extra > 0 ? h("button", { class: "ag-more", onclick: (ev) => { ev.stopPropagation(); this.dayPopup(key, day); } }, `altri ${extra + 1} eventi`) : null,
        day.tasks.length ? h("button", {
          class: "ag-tasks" + (late ? " late" : "") + (!open.length ? " done" : ""),
          title: day.tasks.map((t) => (t.done ? "✓ " : "○ ") + t.text).join("\n"),
          onclick: (ev) => { ev.stopPropagation(); this.dayPopup(key, day); },
        }, h("span", { class: "ag-dot" }), open.length
          ? (open.length === 1 ? "1 da fare" : `${open.length} da fare`)
          : (day.tasks.length === 1 ? "1 fatta" : `${day.tasks.length} fatte`)) : null)));
    }
    this.grid.replaceChildren(...cells);
  }

  eventChip(e, onOpen) {
    return h("button", {
      class: `ag-event ${stateClass(e.stato)}`, title: [e.title, e.ora, e.luogo, e.stato].filter(Boolean).join(" · "),
      onclick: (ev) => { ev.stopPropagation(); onOpen?.(); this.ctx.open(e.id); },
    },
    h("span", { class: "ag-ev-title" }, e.title),
    (e.ora || e.total) ? h("span", { class: "ag-ev-meta" },
      e.ora ? h("span", { class: "ag-time" }, e.ora) : null,
      e.total ? h("span", { class: "ag-prog" + (e.done === e.total ? " full" : "") }, `${e.done}/${e.total}`) : null) : null);
  }

  dayPopup(key, day) {
    const d = fromIso(key);
    const input = h("input", { type: "text", placeholder: "Aggiungi una todo per questo giorno…", "aria-label": "Nuova todo per questo giorno" });
    const add = h("form", {
      class: "ag-add",
      onsubmit: async (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        input.disabled = true;
        try {
          const r = await api("/task/add", { method: "POST", body: { text, due: key } });
          this.ctx.noteChanged?.(r.id);
          this.ctx.treeChanged?.();
          await this.load();
          m.close();
          this.dayPopup(key, this.byDay?.[key] || { events: [], tasks: [] }); // riapro con la todo nuova
        } catch (ex) {
          input.disabled = false;
          toast(ex.message, "error");
        }
      },
    }, input, h("button", { type: "submit", class: "btn small primary" }, "Aggiungi"));
    const m = modal(h("div", { class: "prompt ag-daypop" },
      h("h2", {}, `${GIORNI[(d.getDay() + 6) % 7]} ${d.getDate()} ${MESI[d.getMonth()]}`),
      day.events.map((e) => this.eventChip(e, () => m.close())),
      day.tasks.length ? h("ul", { class: "ag-list" }, day.tasks.map((t) => this.taskRow(t, { date: false, after: () => m.close() }))) : null,
      add,
      h("div", { class: "row end" },
        h("button", { class: "btn ghost", onclick: () => { m.close(); this.newEvent(key); } }, icon("plus", 14), "Evento in questo giorno"),
        h("button", { class: "btn", onclick: () => m.close() }, "Chiudi"))));
    input.focus(); // così puoi scrivere subito, ed Esc chiude
  }

  async newTask(date) {
    const r = await newTaskDialog(date || iso(new Date()));
    if (!r) return;
    toast("Todo aggiunta in «Da fare».");
    this.ctx.noteChanged?.(r.id);
    this.ctx.treeChanged?.();
    this.load();
  }

  drawTodo({ items, today }) {
    const t0 = fromIso(today);
    const week = iso(addDays(t0, 7));
    const groups = [
      ["In ritardo", (t) => t.due < today, "late"],
      ["Oggi", (t) => t.due === today, "now"],
      ["Prossimi 7 giorni", (t) => t.due > today && t.due <= week, ""],
      ["Più avanti", (t) => t.due > week, ""],
    ];
    const blocks = groups.map(([label, test, cls]) => {
      const list = items.filter(test);
      if (!list.length) return null;
      return h("div", { class: "ag-group " + cls },
        h("h4", {}, label, h("span", { class: "count" }, list.length)),
        h("ul", { class: "ag-list" }, (label === "Più avanti" ? list.slice(0, 30) : list).map((t) => this.taskRow(t))));
    }).filter(Boolean);
    this.todo.replaceChildren(...(blocks.length ? blocks : [h("p", { class: "muted" },
      "Niente da fare. Le todo con una data (- [ ] cosa 📅 2026-10-25) e quelle degli eventi compaiono qui.")]));
  }

  taskRow(t, { date = true, after } = {}) {
    const box = h("input", {
      type: "checkbox", checked: t.done, "aria-label": (t.done ? "Segna da fare: " : "Segna fatta: ") + t.text,
      onchange: (e) => this.toggle(t, e.target.checked, e.target, e.target.closest("li")),
    });
    return h("li", { class: "ag-row" + (t.done ? " done" : "") },
      box,
      h("div", { class: "ag-row-main" },
        h("button", { class: "ag-row-text", onclick: () => { after?.(); this.ctx.open(t.id); } }, t.text),
        h("span", { class: "ag-row-meta" },
          t.event ? icon("calendar", 11) : null, t.note,
          date ? ` · ${shortDate(t.due)}` : "")));
  }

  async toggle(t, done, box, row) {
    box.disabled = true;
    row?.classList.toggle("done", done);
    try {
      await api("/task/toggle", { method: "POST", body: { id: t.id, line: t.line, done, text: t.text } });
      this.ctx.noteChanged?.(t.id);
      t.done = done;
      box.disabled = false;
      await this.load();
    } catch (e) {
      box.checked = !done;
      box.disabled = false;
      row?.classList.toggle("done", !done);
      toast(e.message, "error");
      if (e.status === 409) this.load();
    }
  }

  async newEvent(date) {
    const id = await newEventDialog(date || (this.month.getMonth() === new Date().getMonth() ? iso(new Date()) : iso(this.month)));
    if (!id) return;
    this.ctx.treeChanged?.();
    await this.load();
    this.ctx.open(id, { newTab: true });
  }

  activate() { this.load(); }
  destroy() { clearInterval(this._timer); }
}
