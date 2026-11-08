// Atlante — Domande alla wiki: si scrive la domanda qui, la risposta arriva da sola.
// La coda vive nel processo principale: puoi chiudere la scheda, le domande continuano.
import { api, aiAsk, askJobs, askClear, onAskJobs } from "./api.js";
import { h, icon, toast } from "./util.js";

const STEPS = ["In coda", "Cerco nella wiki", "Scelgo le pagine", "Scrivo la risposta", "Salvo"];
const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "adesso";
  if (s < 3600) return `${Math.floor(s / 60)} min fa`;
  return new Date(t).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
};

export class AnswersView {
  constructor(container, ctx) {
    this.ctx = ctx;
    this.title = "Domande";
    this.jobs = [];
    this.el = h("div", { class: "view answers-view" });
    container.append(this.el);
    this.build();
    this.off = onAskJobs((jobs) => this.setJobs(jobs));
    askJobs().then((jobs) => this.setJobs(jobs));
    this.loadSaved();
    this.tick = setInterval(() => this.drawJobs(), 30_000); // aggiorna «3 min fa»
  }

  build() {
    this.q = h("textarea", {
      rows: 2, placeholder: "Es. Cosa è successo con il condominio nel 2025?", "aria-label": "La tua domanda",
      onkeydown: (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.send(); } },
    });
    this.list = h("ul", { class: "ans-jobs", "aria-live": "polite" });
    this.saved = h("ul", { class: "ans-saved" });
    this.clearBtn = h("button", { class: "btn small ghost", onclick: async () => this.setJobs(await askClear()) }, "Togli le concluse");
    this.el.replaceChildren(
      h("div", { class: "ans-wrap" },
        h("header", { class: "ans-head" },
          h("h2", {}, icon("ask", 18), "Chiedi alla wiki"),
          h("p", { class: "muted small" },
            "qwen cerca tra le pagine della wiki e i riassunti dei file e risponde solo con quello che trova. " +
            "Puoi scrivere più domande di fila e chiudere questa scheda: vanno avanti una alla volta e le risposte restano in wiki/risposte.")),
        h("form", { class: "ans-ask", onsubmit: (e) => { e.preventDefault(); this.send(); } },
          this.q, h("button", { type: "submit", class: "btn primary" }, "Chiedi")),
        h("section", { class: "ans-section" },
          h("div", { class: "ans-section-head" }, h("h3", {}, "In questa sessione"), this.clearBtn),
          this.list),
        h("section", { class: "ans-section" }, h("h3", {}, "Risposte salvate"), this.saved)));
  }

  focus() { this.q.focus(); }

  async send() {
    const text = this.q.value.trim();
    if (!text) return;
    const job = await aiAsk(text);
    if (!job) return;
    this.q.value = "";
    this.q.focus();
  }

  setJobs(jobs) {
    const before = new Map(this.jobs.map((j) => [j.id, j.state]));
    this.jobs = jobs || [];
    for (const j of this.jobs) {
      if (j.state === "done" && before.get(j.id) && before.get(j.id) !== "done") {
        this.loadSaved();
        this.ctx.treeChanged?.();
        if (!this.el.isConnected || this.el.closest("[hidden]")) toast(`Risposta pronta: «${j.question}»`);
      }
    }
    this.drawJobs();
  }

  drawJobs() {
    const queued = this.jobs.filter((j) => j.state === "queued").reverse();
    this.clearBtn.hidden = !this.jobs.some((j) => ["done", "error"].includes(j.state));
    if (!this.jobs.length) {
      this.list.replaceChildren(h("li", { class: "muted small ans-empty" }, "Nessuna domanda ancora. Scrivila qui sopra e premi Invio."));
      return;
    }
    this.list.replaceChildren(...this.jobs.map((j) => {
      const pct = j.state === "done" ? 100 : j.state === "queued" ? 0 : Math.round(((j.step - 0.5) / j.steps) * 100);
      const status = j.state === "queued" ? (queued.indexOf(j) === 0 ? "In coda: parte appena finisce quella in corso" : `In coda (${queued.indexOf(j) + 1}ª)`)
        : j.state === "running" ? `Passo ${j.step} di ${j.steps}: ${j.message}`
          : j.state === "done" ? `Risposta pronta · ${ago(j.finished)}` : j.message;
      return h("li", { class: `ans-job ${j.state}` },
        h("div", { class: "ans-job-top" },
          h("span", { class: "ans-q" }, j.question),
          j.state === "done" ? h("button", { class: "btn small primary", onclick: () => this.ctx.open(j.noteId, { newTab: true }) }, "Apri") : null,
          j.state === "error" ? h("button", { class: "btn small", onclick: () => aiAsk(j.question) }, "Riprova") : null),
        h("div", { class: "ans-bar", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": pct,
          "aria-label": STEPS[j.step] || j.state },
        h("span", { style: `width:${pct}%` })),
        h("span", { class: "ans-status" }, status));
    }));
  }

  async loadSaved() {
    try {
      const items = await api("/tree", { params: { id: "n:wiki/risposte" } });
      const notes = items.filter((i) => i.kind === "note").sort((a, b) => b.name.localeCompare(a.name));
      if (!notes.length) {
        this.saved.replaceChildren(h("li", { class: "muted small ans-empty" }, "Le risposte compaiono qui, salvate come note."));
        return;
      }
      this.saved.replaceChildren(...notes.slice(0, 100).map((n) => {
        const name = n.name.replace(/\.md$/i, "");
        const m = /^(\d{4}-\d{2}-\d{2})\s+(.*)$/.exec(name);
        return h("li", {}, h("button", { class: "ans-saved-row", onclick: () => this.ctx.open(n.id) },
          h("span", {}, m ? m[2] : name), m ? h("span", { class: "muted small" }, m[1]) : null));
      }));
    } catch {
      this.saved.replaceChildren(h("li", { class: "muted small ans-empty" }, "Ancora nessuna risposta salvata."));
    }
  }

  activate() { this.loadSaved(); this.drawJobs(); }
  destroy() { this.off?.(); clearInterval(this.tick); }
}
