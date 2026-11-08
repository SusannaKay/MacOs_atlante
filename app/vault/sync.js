// Atlante — sincronizzazione a due vie tra il vault sul server e la sua copia sul Mac.
//
// Per ogni file ricordo com'era all'ultima sincronizzazione (data sul server, impronta del
// contenuto e data sul Mac). Così so chi l'ha cambiato:
//   - cambiato solo sul server  -> lo scarico
//   - cambiato solo sul Mac     -> lo carico (solo note .md: gli altri file arrivano solo dal server)
//   - cambiato da tutte e due   -> tengo la versione del server e salvo la tua accanto,
//                                  come «nome (conflitto Mac AAAA-MM-GG HHMM).md»
//   - sparito da una parte e non toccato dall'altra -> lo tolgo anche dall'altra
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_BYTES = 25 * 1024 * 1024; // file più grandi restano solo sul server
const TIMEOUT = 20_000;
// file che scrive il motore (wiki, indice, log): se il server li toglie, li tolgo anche dalla copia
const isGenerated = (rel) => rel.startsWith("wiki/") || rel === "index.md" || rel === "log.md";

const isNote = (rel) => /\.(md|markdown)$/i.test(rel);
const sha1 = (buf) => crypto.createHash("sha1").update(buf).digest("hex");
const same = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-3;

class VaultSync {
  constructor({ local, statePath, getConfig, onStatus, log = () => {} }) {
    this.local = local;
    this.statePath = statePath;
    this.getConfig = getConfig;
    this.onStatus = onStatus;
    this.log = log;
    this.state = this.loadState();
    this.status = { online: null, syncing: false, last: this.state.last || null, error: null, conflicts: [] };
    this.timer = null;
    this.running = null;
  }

  loadState() {
    try { return JSON.parse(fs.readFileSync(this.statePath, "utf8")); } catch { return { files: {}, last: null, url: null }; }
  }

  saveState() {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tmp = this.statePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.statePath);
  }

  emit(patch = {}) {
    this.status = { ...this.status, ...patch };
    this.onStatus?.(this.status);
  }

  /** La copia sul Mac è ancora identica a quella scaricata con questa data del server? */
  isPristine(rel, serverMtime) {
    const st = this.state.files[rel];
    if (!st || !same(st.smtime, serverMtime)) return false;
    try { return sha1(fs.readFileSync(this.local.abs(rel))) === st.hash; } catch { return false; }
  }

  // ---------------------------------------------------------------- rete
  async req(p, { method = "GET", body, raw = false, timeout = TIMEOUT } = {}) {
    const c = this.getConfig();
    if (!c.url || !c.token) throw Object.assign(new Error("Atlante non è configurata"), { status: 0 });
    let res;
    try {
      res = await fetch(c.url + "/api" + p, {
        method,
        headers: { Authorization: "Bearer " + c.token, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      throw Object.assign(new Error("server non raggiungibile"), { status: 0, cause: e });
    }
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = (await res.json()).detail || detail; } catch { /* niente */ }
      throw Object.assign(new Error(detail), { status: res.status });
    }
    return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
  }

  // ---------------------------------------------------------------- ciclo
  start() {
    if (this.timer) return;
    const tick = async () => {
      try {
        if (this.status.online) await this.sync();
        else await this.probe();
      } catch { /* lo stato è già aggiornato */ }
      this.timer = setTimeout(tick, this.status.online ? 60_000 : 20_000);
    };
    this.timer = setTimeout(tick, 500);
  }

  stop() { clearTimeout(this.timer); this.timer = null; }

  /** Il server risponde? Se sì, prima sincronizzo e solo dopo torno online. */
  async probe() {
    try {
      await this.req("/health", { timeout: 6000 });
    } catch (e) {
      if (e.status === 0) { this.emit({ online: false, syncing: false }); return false; }
      // il server risponde ma con un errore (token, versione…): resto online, l'app mostrerà l'errore vero
      this.emit({ online: true, syncing: false, error: "Il server risponde con un errore: " + e.message });
      return true;
    }
    try {
      await this.sync();
    } catch { /* se il server risponde ma la sincronizzazione no, resto online lo stesso (vedi _sync) */ }
    return this.status.online;
  }

  /** L'app ha visto il server non rispondere: passo subito alla copia sul Mac. */
  reportOffline() {
    if (this.status.online === false) return;
    this.emit({ online: false });
    clearTimeout(this.timer);
    this.timer = null;
    this.start();
  }

  syncSoon() {
    clearTimeout(this._soon);
    this._soon = setTimeout(() => { if (this.status.online) this.sync().catch(() => {}); }, 1500);
  }

  sync() {
    if (!this.running) this.running = this._sync().finally(() => { this.running = null; });
    return this.running;
  }

  async _sync() {
    const c = this.getConfig();
    this.emit({ syncing: true, error: null });
    const conflicts = [];
    try {
      const { files } = await this.req("/sync/manifest");
      // indirizzo del server cambiato: non so più cosa corrisponde a cosa, quindi riconfronto tutto
      // (i file uguali restano, quelli diversi diventano copie «conflitto», niente va perso)
      if (this.state.url && this.state.url !== c.url) this.state = { files: {}, last: null, url: c.url };
      this.state.url = c.url;
      const server = new Map(files.map((f) => [f.rel, f]));
      const local = new Map();
      for (const rel of this.local.walk()) {
        try { local.set(rel, fs.statSync(this.local.abs(rel))); } catch { /* niente */ }
      }
      const rels = new Set([...server.keys(), ...local.keys(), ...Object.keys(this.state.files)]);
      // se da una parte sparisce mezzo vault (disco del server scollegato, cartella sul Mac cancellata…)
      // non cancello niente dall'altra: meglio un doppione che perdere le note
      const known = Object.keys(this.state.files).length;
      let goneLocal = 0;
      let goneServer = 0;
      for (const rel of Object.keys(this.state.files)) {
        if (isGenerated(rel)) continue; // le pagine della wiki le cancella il motore da solo: non contano
        if (!local.has(rel)) goneLocal++;
        if (!server.has(rel)) goneServer++;
      }
      const limit = Math.max(10, known * 0.2);
      const noDelete = goneLocal > limit || goneServer > limit ||
        (known > 0 && (server.size === 0 || local.size === 0)); // una delle due parti è vuota: sicuramente un problema
      if (noDelete) this.log(`sync: spariti ${goneLocal} file sul Mac e ${goneServer} sul server, non cancello nulla`);
      for (const rel of rels) {
        try {
          await this.syncOne(rel, server.get(rel), local.get(rel), conflicts, noDelete);
        } catch (e) {
          if (e.status === 0) throw e; // il server è sparito a metà: riprovo più tardi
          this.log(`sync ${rel}: ${e.message}`);
        }
      }
      this.state.last = Date.now();
      this.saveState();
      this.emit({ online: true, syncing: false, last: this.state.last, conflicts,
        error: noDelete ? "Molti file risultano spariti da una delle due parti: per sicurezza non ho cancellato nulla." : null });
    } catch (e) {
      this.saveState();
      if (e.status === 0) this.emit({ online: false, syncing: false });
      else {
        // il server risponde: l'app lo usa normalmente, solo la copia offline resta indietro
        const old = e.status === 404 ? "Il motore sul server è da aggiornare (versione 1.5): finché non lo aggiorni la copia offline non si sincronizza." : null;
        this.emit({ online: true, syncing: false, error: old || "Sincronizzazione della copia offline non riuscita: " + e.message });
      }
      throw e;
    }
  }

  async syncOne(rel, s, l, conflicts, noDelete = false) {
    const st = this.state.files[rel];
    const lChanged = l && (!st || (l.mtimeMs !== st.lmtime && this.hashLocal(rel) !== st.hash));
    const sChanged = s && (!st || !same(s.mtime, st.smtime));

    if (s && l) {
      if (!st) { // file in tutte e due ma mai sincronizzato
        if (this.hashLocal(rel) === (await this.serverHash(rel, s))) return this.remember(rel, s.mtime);
        if (isNote(rel)) return this.conflict(rel, s, conflicts);
        return this.download(rel, s);
      }
      if (lChanged && sChanged) return isNote(rel) ? this.conflict(rel, s, conflicts) : this.download(rel, s);
      if (lChanged) return isNote(rel) ? this.upload(rel, st.smtime, conflicts) : this.download(rel, s);
      if (sChanged) return this.download(rel, s);
      return undefined;
    }
    if (s && !l) {
      if (st && !sChanged) { // cancellato sul Mac
        if (noDelete) return undefined;
        if (isNote(rel)) await this.req("/note/delete", { method: "POST", body: { id: "n:" + rel } });
        delete this.state.files[rel];
        return undefined;
      }
      return this.download(rel, s);
    }
    if (l && !s) {
      if (st && !lChanged) { // cancellato sul server
        if (noDelete && !isGenerated(rel)) return undefined;
        fs.rmSync(this.local.abs(rel), { force: true });
        delete this.state.files[rel];
        return undefined;
      }
      if (noDelete && st) return undefined; // il server l'ha "perso" insieme a tanti altri: aspetto
      if (isNote(rel)) return this.upload(rel, null, conflicts);
      return undefined; // file non-nota creato sul Mac: resta lì
    }
    delete this.state.files[rel]; // sparito da tutte e due
    return undefined;
  }

  hashLocal(rel) {
    try { return sha1(fs.readFileSync(this.local.abs(rel))); } catch { return null; }
  }

  async serverHash(rel, s) {
    if (s.size > MAX_BYTES) return null;
    return sha1(await this.req("/raw?id=" + encodeURIComponent("n:" + rel), { raw: true }));
  }

  remember(rel, smtime) {
    const p = this.local.abs(rel);
    const buf = fs.readFileSync(p);
    this.state.files[rel] = { smtime, hash: sha1(buf), lmtime: fs.statSync(p).mtimeMs };
  }

  async download(rel, s) {
    if (s.size > MAX_BYTES) return;
    const buf = await this.req("/raw?id=" + encodeURIComponent("n:" + rel), { raw: true });
    const p = this.local.abs(rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + ".atlante-tmp";
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, p);
    const t = new Date(s.mtime * 1000);
    try { fs.utimesSync(p, t, t); } catch { /* niente */ }
    this.state.files[rel] = { smtime: s.mtime, hash: sha1(buf), lmtime: fs.statSync(p).mtimeMs };
  }

  async upload(rel, baseMtime, conflicts) {
    const p = this.local.abs(rel);
    const lmtime = fs.statSync(p).mtimeMs;
    const buf = fs.readFileSync(p);
    try {
      const r = await this.req("/note", { method: "PUT", body: { id: "n:" + rel, text: buf.toString("utf8"), base_mtime: baseMtime } });
      this.state.files[rel] = { smtime: r.mtime, hash: sha1(buf), lmtime };
    } catch (e) {
      if (e.status !== 409) throw e;
      const { files } = await this.req("/sync/manifest");
      const s = files.find((f) => f.rel === rel);
      if (s) await this.conflict(rel, s, conflicts);
    }
  }

  /** Tutte e due le versioni sono cambiate: quella del server resta, la tua va in un file accanto. */
  async conflict(rel, s, conflicts) {
    const p = this.local.abs(rel);
    const mine = fs.readFileSync(p);
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
    const ext = path.posix.extname(rel);
    let copy = `${rel.slice(0, -ext.length)} (conflitto Mac ${stamp})${ext}`;
    for (let i = 2; fs.existsSync(this.local.abs(copy)); i++) copy = `${rel.slice(0, -ext.length)} (conflitto Mac ${stamp} ${i})${ext}`;
    fs.writeFileSync(this.local.abs(copy), mine);
    await this.download(rel, s);
    await this.upload(copy, null, conflicts);
    conflicts.push({ rel, copy });
    this.log(`conflitto su ${rel}: la versione del Mac è in ${copy}`);
  }
}

module.exports = { VaultSync };
