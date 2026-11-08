// Atlante — analisi con Ollama sul Mac (processo principale).
// Chiede al motore cosa analizzare, interroga il modello locale, rimanda i risultati.
const OLLAMA = process.env.OLLAMA_HOST ? `http://${process.env.OLLAMA_HOST.replace(/^https?:\/\//, "")}` : "http://127.0.0.1:11434";

const SYSTEM = "Sei l'archivista di un archivio personale: documenti, libri, film, appunti di studio, " +
  "lavoro e vita quotidiana. Rispondi solo con JSON valido, in italiano.";

const PROFILE_SCHEMA = {
  type: "object",
  properties: { riassunto: { type: "string" }, entita: { type: "array", items: { type: "string" } } },
  required: ["riassunto", "entita"],
};
const NAMES_SCHEMA = {
  type: "object",
  properties: {
    files: {
      type: "array",
      items: {
        type: "object",
        properties: { n: { type: "integer" }, riassunto: { type: "string" }, entita: { type: "array", items: { type: "string" } } },
        required: ["n", "riassunto", "entita"],
      },
    },
  },
  required: ["files"],
};
const MATCH_SCHEMA = {
  type: "object",
  properties: {
    collegati: {
      type: "array",
      items: {
        type: "object",
        properties: { n: { type: "integer" }, motivo: { type: "string" }, fiducia: { type: "number" } },
        required: ["n", "motivo", "fiducia"],
      },
    },
  },
  required: ["collegati"],
};

const WIKI_SCHEMA = {
  type: "object",
  properties: {
    scarta: { type: "boolean" },
    titolo: { type: "string" },
    descrizione: { type: "string" },
    tipo: { type: "string", enum: ["persona", "organizzazione", "luogo", "progetto", "opera", "pratica", "evento", "altro"] },
    alias: { type: "array", items: { type: "string" } },
    sintesi: { type: "string" },
    dettagli: { type: "string" },
    da_verificare: { type: "array", items: { type: "string" } },
    collegati: { type: "array", items: { type: "integer" } },
  },
  required: ["scarta", "titolo", "descrizione", "tipo", "alias", "sintesi", "dettagli", "da_verificare", "collegati"],
};

const PICK_SCHEMA = {
  type: "object",
  properties: { pagine: { type: "array", items: { type: "integer" } }, file: { type: "array", items: { type: "integer" } } },
  required: ["pagine", "file"],
};
const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    risposta: { type: "string" },
    pagine_usate: { type: "array", items: { type: "integer" } },
    file_usati: { type: "array", items: { type: "integer" } },
  },
  required: ["risposta", "pagine_usate", "file_usati"],
};
const THEME_SCHEMA = {
  type: "object",
  properties: {
    scarta: { type: "boolean" },
    esistente: { type: "integer" },
    titolo: { type: "string" },
    descrizione: { type: "string" },
    sintesi: { type: "string" },
    membri: { type: "array", items: { type: "integer" } },
  },
  required: ["scarta", "esistente", "titolo", "descrizione", "sintesi", "membri"],
};

const ENTITY_RULE = "fino a 10 nomi specifici e distintivi (persone, aziende, enti, luoghi, progetti, opere, " +
  "pratiche, codici o numeri di contratto). Niente parole generiche come documento, file, pdf, foto, fattura, appunti.";

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});

function parseJson(text) {
  const clean = String(text || "").replace(/<think>[\s\S]*?<\/think>/g, "");
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("risposta del modello non leggibile");
  return JSON.parse(clean.slice(start, end + 1));
}

class AiWorker {
  constructor({ getConfig, broadcast, isOnBattery }) {
    this.getConfig = getConfig;
    this.broadcast = broadcast;
    this.isOnBattery = isOnBattery;
    this.status = { state: "off", message: "Spenta", stats: null, last: null };
    this.ctrl = null;
  }

  set(state, message, extra = {}) {
    this.status = { ...this.status, state, message, ...extra };
    this.broadcast(this.status);
  }

  // ------------------------------------------------------------ servizi
  async server(path, { method = "GET", body, ok409 = false } = {}) {
    const c = this.getConfig();
    const res = await fetch(c.url + "/api" + path, {
      method,
      headers: { Authorization: "Bearer " + c.token, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    if (ok409 && res.status === 409) return {}; // pagina bloccata o scritta a mano: il motore la lascia stare
    if (!res.ok) throw new Error(`motore: ${res.status}`);
    return res.json();
  }

  async models() {
    const res = await fetch(OLLAMA + "/api/tags", { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error("Ollama non risponde");
    const j = await res.json();
    return (j.models || []).map((m) => ({ name: m.name, size: m.size }));
  }

  async chat(prompt, schema, numCtx = 8192, signal = this.ctrl?.signal) {
    const model = this.getConfig().aiModel;
    const res = await fetch(OLLAMA + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        format: schema,
        options: { temperature: 0.1, num_ctx: numCtx },
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
      }),
      signal: signal ? AbortSignal.any([AbortSignal.timeout(300_000), signal]) : AbortSignal.timeout(300_000),
    });
    if (!res.ok) {
      let msg = `Ollama: ${res.status}`;
      try { msg = "Ollama: " + (await res.json()).error; } catch { /* niente */ }
      throw new Error(msg);
    }
    const j = await res.json();
    return parseJson(j.message?.content);
  }

  /** Se il modello risponde in modo illeggibile, salto quel file invece di riprovarlo all'infinito. */
  async tolerant(fn, fallback) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof SyntaxError || /non leggibile/.test(e.message)) return fallback;
      throw e;
    }
  }

  // ------------------------------------------------------------ ciclo
  start() {
    if (this.ctrl) return;
    this.ctrl = new AbortController();
    this.loop(this.ctrl.signal).catch(() => {});
  }

  stop() {
    this.ctrl?.abort();
    this.ctrl = null;
    this.set("off", "Spenta");
  }

  async refreshStats() {
    try {
      const stats = await this.server("/ai/stats");
      this.status.stats = stats;
    } catch { /* niente */ }
  }

  async loop(signal) {
    while (!signal.aborted) {
      const c = this.getConfig();
      if (!c.url || !c.token || !c.aiModel) {
        this.set("paused", "Scegli un modello nelle impostazioni.");
        await sleep(30_000, signal);
        continue;
      }
      if (c.aiBattery !== false && this.isOnBattery()) {
        this.set("paused", "In pausa: il Mac va a batteria.");
        await sleep(60_000, signal);
        continue;
      }
      try {
        await this.models();
      } catch {
        this.set("paused", "Ollama non è acceso. Aprilo e l'analisi riparte da sola.");
        await sleep(60_000, signal);
        continue;
      }
      try {
        // di solito prima leggo e abbino i file; ogni 5 giri scrivo una pagina della wiki,
        // così la wiki cresce anche durante la prima lettura dell'archivio (che dura giorni)
        this.cycle = (this.cycle || 0) + 1;
        const steps = this.cycle % 5 === 0
          ? [this.compileStep, this.themeStep, this.profileStep, this.matchStep]
          : [this.profileStep, this.matchStep, this.compileStep, this.themeStep];
        let did = false;
        for (const step of steps) {
          if (signal.aborted) break;
          if (await step.call(this, signal)) { did = true; break; }
        }
        await this.refreshStats();
        if (!did) {
          this.set("idle", "Tutto analizzato. Ricontrollo tra 10 minuti.");
          await sleep(600_000, signal);
        }
      } catch (e) {
        if (signal.aborted) break;
        this.set("error", "Errore: " + e.message + ". Riprovo tra un minuto.");
        await sleep(60_000, signal);
      }
    }
  }

  // ------------------------------------------------------------ 1. profili
  async profileStep(signal) {
    const items = await this.server("/ai/next?limit=15");
    if (!items.length) return false;
    const text = items.filter((i) => i.mode === "text").slice(0, 3);
    const names = items.filter((i) => i.mode === "name");
    const model = this.getConfig().aiModel;
    const out = [];
    for (const it of text) {
      if (signal.aborted) return true;
      this.set("running", `Leggo «${it.name}»`);
      const r = await this.tolerant(() => this.chat(
        `File: ${it.path}\nTipo: ${it.kind}${it.year ? `\nAnno: ${it.year}` : ""}\n\n` +
        `Contenuto (estratto):\n"""\n${it.text}\n"""\n\n` +
        `Scrivi in JSON:\n- riassunto: 1-2 frasi su cosa è questo file e a cosa si riferisce\n- entita: ${ENTITY_RULE}`,
        PROFILE_SCHEMA), {});
      out.push({ id: it.id, summary: r.riassunto || "", entities: (r.entita || []).map(String) });
    }
    if (!text.length && names.length) {
      this.set("running", `Guardo i nomi di ${names.length} file`);
      const list = names.map((it, i) => `${i + 1}. ${it.path} (${it.kind}${it.year ? ", " + it.year : ""})`).join("\n");
      const r = await this.tolerant(() => this.chat(
        `Per ciascun file deduci dal nome e dalla cartella che cos'è (un film, un libro, un documento di una pratica…).\n` +
        `Se il nome non dice nulla (es. IMG_1234, 0000414.pdf, numeri casuali) lascia riassunto vuoto ed entita vuote.\n\n` +
        `${list}\n\nPer ogni file (n = numero in elenco): riassunto in una frase; entita: ${ENTITY_RULE}`,
        NAMES_SCHEMA), {});
      const byN = new Map((r.files || []).map((f) => [Number(f.n), f]));
      names.forEach((it, i) => {
        const f = byN.get(i + 1) || {};
        out.push({ id: it.id, summary: f.riassunto || "", entities: (f.entita || []).map(String) });
      });
    }
    if (out.length) {
      await this.server("/ai/profiles", { method: "POST", body: { model, items: out } });
      this.status.last = { what: "profili", count: out.length, at: Date.now() };
    }
    return true;
  }

  // ------------------------------------------------------------ 2. abbinamenti
  async matchStep(signal) {
    const r = await this.server("/ai/pending_match?limit=2");
    if (!r.items.length) return r.skipped > 0;
    const model = this.getConfig().aiModel;
    for (const it of r.items) {
      if (signal.aborted) return true;
      this.set("running", `Cerco collegamenti per «${it.name}»`);
      const cands = it.candidates.map((c, i) =>
        `${i + 1}. ${c.path}${c.year ? ` (${c.year})` : ""} — ${c.summary || "nessun riassunto"}` +
        (c.entities?.length ? ` [${c.entities.join(", ")}]` : "")).join("\n");
      const res = await this.tolerant(() => this.chat(
        `File principale: ${it.path}${it.year ? ` (${it.year})` : ""}\nRiassunto: ${it.summary || "—"}\n` +
        `Entità: ${(it.entities || []).join(", ") || "—"}\n\nCandidati:\n${cands}\n\n` +
        "Quali candidati sono collegati in modo concreto al file principale? Collegati vuol dire: stessa pratica, " +
        "persona o progetto; uno è parte, allegato, versione o seguito dell'altro; uno parla esplicitamente " +
        "dell'altro; stessa serie o stesso evento. NON collegare file solo perché trattano un argomento simile. " +
        "Per ogni collegamento: n del candidato, motivo in italiano (massimo 12 parole), fiducia da 0 a 1. " +
        "Se nessuno è collegato, restituisci una lista vuota.",
        MATCH_SCHEMA), {});
      const links = (res.collegati || [])
        .map((l) => ({ target: it.candidates[Number(l.n) - 1]?.id, reason: String(l.motivo || ""), confidence: Number(l.fiducia) || 0 }))
        .filter((l) => l.target);
      await this.server("/ai/matches", { method: "POST", body: { id: it.id, model, links } });
      this.status.last = { what: "abbinamenti", count: links.length, at: Date.now() };
    }
    return true;
  }

  // ------------------------------------------------------------ 3. wiki
  async compileStep(signal) {
    const { item: it } = await this.server("/wiki/next");
    if (!it || !it.sources.length) return false;
    if (signal.aborted) return true;
    const model = this.getConfig().aiModel;
    const ex = it.existing;
    const name = ex?.title || it.entity;
    this.set("running", `${ex ? "Aggiorno" : "Scrivo"} la pagina «${name}»`);

    const fonti = it.sources.map((s, i) =>
      `${i + 1}. ${s.path}${s.year ? ` (${s.year})` : ""} — ${s.summary}` +
      (s.entities?.length ? ` [compare con: ${s.entities.join(", ")}]` : "")).join("\n");
    const pagine = it.related.map((r, i) => `${i + 1}. ${r.title}${r.descrizione ? " — " + r.descrizione : ""}`).join("\n");
    const attuale = ex
      ? `PAGINA ATTUALE (da aggiornare, non da riscrivere da zero):\nTitolo: ${ex.title}\nDescrizione: ${ex.descrizione}\n` +
        `Alias: ${ex.alias.join(", ") || "—"}\nSintesi: ${ex.sintesi}\nDettagli:\n"""\n${ex.dettagli}\n"""\n` +
        `Da verificare: ${ex.da_verificare.join("; ") || "—"}\n\n`
      : "";
    const prompt =
      `Scrivi la pagina della wiki personale su «${name}», che compare in ${it.total} file dell'archivio.\n\n` +
      attuale +
      `FONTI ${ex ? "NUOVE DA INTEGRARE" : ""}:\n${fonti}\n\n` +
      (pagine ? `PAGINE DELLA WIKI CHE POTRESTI COLLEGARE:\n${pagine}\n\n` : "") +
      "Rispondi in JSON:\n" +
      `- scarta: true solo se le fonti non dicono niente di concreto su «${name}» (nome troppo generico o sbagliato), altrimenti false\n` +
      "- titolo: il nome scritto bene, con maiuscole e accenti\n" +
      "- descrizione: una riga di massimo 15 parole, per l'indice\n" +
      "- tipo: che cos'è\n" +
      "- alias: altri nomi con cui compare nelle fonti\n" +
      "- sintesi: 2-3 frasi: chi o che cos'è e che ruolo ha nella vita del proprietario o nel suo archivio\n" +
      "- dettagli: i fatti principali in Markdown, come elenco puntato (massimo 20 punti; sottotitoli ### se servono): " +
      "date, importi, pratiche, persone coinvolte, cosa è successo e quando\n" +
      "- da_verificare: fatti incerti o fonti che si contraddicono\n" +
      "- collegati: i numeri delle pagine della wiki legate davvero a questa (lista vuota se nessuna)\n\n" +
      "Regole: usa solo quello che c'è nelle fonti" + (ex ? " e nella pagina attuale; conserva tutto quello che c'era e aggiungi il nuovo" : "") +
      ". Non inventare. Non scrivere [[link]] e non elencare le fonti: li aggiunge il programma.";

    const r = await this.tolerant(() => this.chat(prompt, WIKI_SCHEMA, 16384), null);
    const base = { entity: it.entity, model, sources: it.sources.map((s) => s.id) };
    if (!r) {
      await this.server("/wiki/page", { method: "POST", body: { ...base, rinvia: true } });
      return true;
    }
    const collegati = (r.collegati || []).map((n) => it.related[Number(n) - 1]?.entity).filter(Boolean);
    const res = await this.server("/wiki/page", {
      method: "POST",
      ok409: true,
      body: {
        ...base, scarta: Boolean(r.scarta), titolo: String(r.titolo || ""), descrizione: String(r.descrizione || ""),
        tipo: String(r.tipo || ""), alias: (r.alias || []).map(String), sintesi: String(r.sintesi || ""),
        dettagli: String(r.dettagli || ""), da_verificare: (r.da_verificare || []).map(String), collegati,
      },
    });
    this.status.last = { what: "wiki", title: res.title || name, at: Date.now() };
    return true;
  }

  // ------------------------------------------------------------ 4. temi
  async themeStep(signal) {
    const { item: it } = await this.server("/wiki/theme/next");
    if (!it) return false;
    if (signal.aborted) return true;
    const model = this.getConfig().aiModel;
    this.set("running", `Cerco un tema intorno a «${it.members[0].title}»`);
    const membri = it.members.map((m, i) => `${i + 1}. ${m.title}${m.descrizione ? " — " + m.descrizione : ""}` +
      (m.sintesi ? `\n   ${m.sintesi}` : "")).join("\n");
    const temi = it.themes.map((t, i) => `${i + 1}. ${t.title}${t.descrizione ? " — " + t.descrizione : ""}`).join("\n");
    const r = await this.tolerant(() => this.chat(
      "Queste pagine della wiki personale di Sus compaiono spesso negli stessi file. La prima è il centro del gruppo.\n\n" +
      `PAGINE:\n${membri}\n\n` + (temi ? `TEMI GIÀ ESISTENTI:\n${temi}\n\n` : "") +
      "Formano un tema, cioè un argomento della vita o del lavoro di Sus che le tiene insieme " +
      "(es. «Casa e condominio», «Studi a 42», «Viaggio in Giappone 2024»)?\n" +
      "Rispondi in JSON:\n" +
      "- scarta: true se non c'è un argomento chiaro che le unisce (solo coincidenze), altrimenti false\n" +
      "- esistente: il numero del tema già esistente che è proprio questo, oppure 0 se è un tema nuovo\n" +
      "- titolo: nome del tema, breve (2-5 parole)\n" +
      "- descrizione: una riga di massimo 15 parole\n" +
      "- sintesi: 2-4 frasi su cosa riguarda il tema e come si collegano le pagine\n" +
      "- membri: i numeri delle pagine che fanno davvero parte del tema (almeno 3, sempre compreso l'1)\n" +
      "Usa solo quello che c'è scritto qui. Non inventare.",
      THEME_SCHEMA, 12288), null);
    const base = { seed: it.seed, model };
    if (!r) {
      await this.server("/wiki/theme", { method: "POST", body: { ...base, scarta: true } });
      return true;
    }
    const membriSel = (r.membri || []).map((n) => it.members[Number(n) - 1]?.entity).filter(Boolean);
    const esistente = Number(r.esistente) > 0 ? it.themes[Number(r.esistente) - 1]?.slug || "" : "";
    const res = await this.server("/wiki/theme", {
      method: "POST",
      body: { ...base, scarta: Boolean(r.scarta), esistente, titolo: String(r.titolo || ""),
        descrizione: String(r.descrizione || ""), sintesi: String(r.sintesi || ""), membri: membriSel },
    });
    if (res.written) this.status.last = { what: "tema", title: res.title, at: Date.now() };
    return true;
  }

  // ------------------------------------------------------------ domande alla wiki
  /** Risponde a una domanda usando la wiki e salva la risposta in wiki/risposte. Restituisce l'id della nota. */
  async ask(question, progress = () => {}) {
    const c = this.getConfig();
    if (!c.aiModel) throw new Error("Scegli un modello di Ollama nelle Impostazioni.");
    try { await this.models(); } catch { throw new Error("Ollama non è acceso: aprilo e riprova."); }
    const signal = AbortSignal.timeout(900_000);
    progress("Cerco nella wiki…");
    const cand = await this.server("/wiki/ask/candidates?q=" + encodeURIComponent(question));
    if (!cand.pages.length && !cand.files.length) throw new Error("Non trovo niente nella wiki e nei file su questa domanda.");
    const pagine = cand.pages.map((p, i) => `${i + 1}. ${p.title}${p.descrizione ? " — " + p.descrizione : ""}`).join("\n");
    const files = cand.files.map((f, i) => `${i + 1}. ${f.path}${f.year ? ` (${f.year})` : ""}${f.summary ? " — " + f.summary : ""}`).join("\n");

    progress("Scelgo le pagine utili…");
    const pick = await this.chat(
      `Domanda di Sus: «${question}»\n\n` +
      (pagine ? `PAGINE DELLA WIKI:\n${pagine}\n\n` : "") + (files ? `FILE DELL'ARCHIVIO:\n${files}\n\n` : "") +
      "Quali servono per rispondere? JSON con pagine (massimo 6 numeri) e file (massimo 4 numeri). " +
      "Liste vuote se non c'entra niente.", PICK_SCHEMA, 12288, signal);
    const pages = [...new Set((pick.pagine || []).map((n) => cand.pages[Number(n) - 1]).filter(Boolean))].slice(0, 6);
    const chosenFiles = [...new Set((pick.file || []).map((n) => cand.files[Number(n) - 1]).filter(Boolean))].slice(0, 4);
    if (!pages.length && !chosenFiles.length) throw new Error("La wiki non contiene ancora niente di utile per questa domanda.");

    progress(`Leggo ${pages.length + chosenFiles.length} fonti e scrivo la risposta…`);
    const full = pages.length ? (await this.server("/wiki/ask/pages?ids=" + encodeURIComponent(pages.map((p) => p.id).join("|")))).pages : [];
    const fonti = [
      ...full.map((p, i) => `[P${i + 1}] Pagina «${p.title}»\n${p.text}`),
      ...chosenFiles.map((f, i) => `[F${i + 1}] File ${f.path}${f.year ? ` (${f.year})` : ""}\n${f.summary || "(nessun riassunto)"}`),
    ].join("\n\n---\n\n");
    const ans = await this.chat(
      `Domanda di Sus: «${question}»\n\nFONTI:\n${fonti}\n\n` +
      "Rispondi in italiano, in Markdown, in modo chiaro e diretto (elenchi puntati se servono). Usa solo le fonti: " +
      "se non bastano per rispondere, dillo e spiega cosa manca. Non inventare date, nomi o cifre.\n" +
      "JSON: risposta (il testo), pagine_usate (numeri delle P che hai usato), file_usati (numeri delle F che hai usato).",
      ANSWER_SCHEMA, 16384, signal);
    const text = String(ans.risposta || "").trim();
    if (!text) throw new Error("Il modello non ha risposto. Riprova, magari con una domanda più precisa.");
    const usedPages = (ans.pagine_usate || []).map((n) => full[Number(n) - 1]?.id).filter(Boolean);
    const usedFiles = (ans.file_usati || []).map((n) => chosenFiles[Number(n) - 1]?.id).filter(Boolean);
    progress("Salvo la risposta…");
    const r = await this.server("/wiki/answer", {
      method: "POST",
      body: { question, answer: text, model: c.aiModel,
        // se il modello non dice quali fonti ha usato, le elenco tutte
        ...(usedPages.length || usedFiles.length ? { pages: usedPages, files: usedFiles }
          : { pages: full.map((p) => p.id), files: chosenFiles.map((f) => f.id) }) },
    });
    return r.id;
  }
}

module.exports = { AiWorker };
