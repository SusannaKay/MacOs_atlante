// Atlante — motore sul Mac, per chi non ha un server.
// È lo stesso motore Python del server (cartella server/), avviato dall'app su 127.0.0.1.
// Si prepara solo se nelle impostazioni scegli «Questo Mac»: la prima volta crea un ambiente
// Python tutto suo (in ~/Library/Application Support/Atlante/engine) e installa i componenti.
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");

const MIN_PY = [3, 10];
const PY_CANDIDATES = [
  ...["3.13", "3.12", "3.11", "3.10"].flatMap((v) => [
    `/opt/homebrew/bin/python${v}`, `/usr/local/bin/python${v}`,
    `/Library/Frameworks/Python.framework/Versions/${v}/bin/python3`,
  ]),
  "/opt/homebrew/bin/python3", "/usr/local/bin/python3",
];
// le app del Mac non vedono il PATH del Terminale: aggiungo le cartelle di Homebrew (per poppler)
const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin"];

function pyVersion(bin) {
  try {
    const r = spawnSync(bin, ["-c", "import sys;print('%d.%d' % sys.version_info[:2])"], { timeout: 15000, encoding: "utf8" });
    if (r.status !== 0) return null;
    const [a, b] = r.stdout.trim().split(".").map(Number);
    return a > MIN_PY[0] || (a === MIN_PY[0] && b >= MIN_PY[1]) ? `${a}.${b}` : null;
  } catch { return null; }
}

function findPython() {
  const list = [process.env.ATLANTE_PYTHON, ...PY_CANDIDATES].filter(Boolean);
  // /usr/bin/python3 solo se ci sono gli strumenti da sviluppatore, altrimenti macOS apre la finestra per installarli
  if (fs.existsSync("/Library/Developer/CommandLineTools/usr/bin/python3") || fs.existsSync("/Applications/Xcode.app")) {
    list.push("/usr/bin/python3");
  }
  for (const bin of list) {
    if (!fs.existsSync(bin)) continue;
    const v = pyVersion(bin);
    if (v) return { bin, version: v };
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class LocalEngine {
  /**
   * @param {object} o
   * @param {string} o.home    cartella dei dati del motore (venv, indice, log)
   * @param {string} o.source  cartella con app/ e requirements.txt del motore
   * @param {(st: object) => void} o.onStatus
   */
  constructor({ home, source, onStatus }) {
    this.home = home;
    this.source = source;
    this.onStatus = onStatus;
    this.proc = null;
    this.status = { state: "off", message: "", url: "", token: "" };
    this.want = null; // { storage, vault }
    this.restarts = 0;
  }

  emit(patch) {
    this.status = { ...this.status, ...patch };
    this.onStatus?.(this.status);
  }

  log(line) {
    try { fs.appendFileSync(path.join(this.home, "engine.log"), line.endsWith("\n") ? line : line + "\n"); } catch { /* niente */ }
  }

  get venvPython() { return path.join(this.home, "venv", "bin", "python"); }

  /** Crea l'ambiente Python e installa i componenti, solo se non c'è o se sono cambiati. */
  async prepare() {
    fs.mkdirSync(this.home, { recursive: true });
    const req = fs.readFileSync(path.join(this.source, "requirements.txt"), "utf8");
    const marker = path.join(this.home, "venv", ".atlante-ready");
    const want = crypto.createHash("sha1").update(req).digest("hex");
    if (fs.existsSync(this.venvPython) && fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === want) return;

    this.emit({ state: "preparing", message: "Cerco Python sul Mac…" });
    const py = findPython();
    if (!py) {
      throw new Error("Per usare Atlante senza server serve Python 3.10 o più recente. Installalo da python.org " +
        "oppure con «brew install python», poi riapri le impostazioni.");
    }
    this.emit({ message: `Preparo il motore con Python ${py.version} (solo la prima volta, serve internet)…` });
    fs.rmSync(path.join(this.home, "venv"), { recursive: true, force: true });
    await this.run(py.bin, ["-m", "venv", path.join(this.home, "venv")]);
    this.emit({ message: "Installo i componenti del motore (qualche minuto, solo la prima volta)…" });
    await this.run(this.venvPython, ["-m", "pip", "install", "--disable-pip-version-check", "-q", "--upgrade", "pip"]);
    await this.run(this.venvPython, ["-m", "pip", "install", "--disable-pip-version-check", "-q", "-r",
      path.join(this.source, "requirements.txt")]);
    fs.writeFileSync(marker, want);
  }

  run(bin, args) {
    return new Promise((resolve, reject) => {
      this.log(`$ ${bin} ${args.join(" ")}`);
      const p = spawn(bin, args, { cwd: this.home, env: this.env() });
      let tail = "";
      const keep = (d) => { const s = d.toString(); this.log(s); tail = (tail + s).slice(-1500); };
      p.stdout.on("data", keep);
      p.stderr.on("data", keep);
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(
        `Preparazione del motore non riuscita (${path.basename(bin)} ${args[1] || ""}). ` +
        (tail.trim().split("\n").pop() || "") + " Dettagli in " + path.join(this.home, "engine.log")))));
    });
  }

  env(extra = {}) {
    return { ...process.env, PATH: [...EXTRA_PATH, process.env.PATH || "/usr/bin:/bin"].join(":"), PYTHONUNBUFFERED: "1", ...extra };
  }

  writeConfig({ storage, vault }) {
    const exclude = ["lost+found", "**/.Trash*", "**/.DS_Store", "**/._*", "**/node_modules", "**/.git",
      "**/*.photoslibrary", "**/*.app", "Library"];
    const rel = path.relative(storage, vault);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) exclude.push(rel.split(path.sep).join("/")); // note dentro la cartella
    const yaml = "# generato da Atlante (modalità «Questo Mac»): viene riscritto a ogni avvio\nexclude:\n" +
      exclude.map((e) => `  - ${JSON.stringify(e)}`).join("\n") + "\nrescan_minutes: 30\n";
    const p = path.join(this.home, "config.yaml");
    fs.writeFileSync(p, yaml);
    return p;
  }

  /** Avvia (o riavvia, se le cartelle sono cambiate) il motore. */
  async start({ storage, vault }) {
    if (this.proc && this.want && this.want.storage === storage && this.want.vault === vault && this.status.state === "ready") {
      return this.status;
    }
    this.want = { storage, vault };
    await this.stop();
    try {
      if (!storage || !fs.existsSync(storage)) throw new Error("La cartella da organizzare non esiste (disco scollegato?): " + (storage || "nessuna"));
      fs.mkdirSync(vault, { recursive: true });
      await this.prepare();
      this.emit({ state: "starting", message: "Avvio il motore…" });
      const port = await freePort();
      const token = crypto.randomBytes(24).toString("hex");
      const cfgPath = this.writeConfig({ storage, vault });
      const proc = spawn(this.venvPython, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port)], {
        cwd: this.source,
        env: this.env({
          ATLANTE_STORAGE: storage, ATLANTE_VAULT: vault, ATLANTE_DATA: path.join(this.home, "data"),
          ATLANTE_TOKEN: token, ATLANTE_CONFIG: cfgPath, ATLANTE_STORAGE_LABEL: storage, ATLANTE_VAULT_LABEL: vault,
        }),
      });
      this.proc = proc;
      proc.stdout.on("data", (d) => this.log(d.toString()));
      proc.stderr.on("data", (d) => this.log(d.toString()));
      proc.on("exit", (code) => {
        this.log(`motore terminato (codice ${code})`);
        if (this.proc !== proc) return; // fermato da me
        this.proc = null;
        this.emit({ state: "error", message: "Il motore si è fermato. Lo riavvio…", url: "" });
        if (this.restarts++ < 3) setTimeout(() => this.start(this.want).catch(() => {}), 3000);
        else this.emit({ message: "Il motore continua a fermarsi. Dettagli in " + path.join(this.home, "engine.log") });
      });
      const url = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 120; i++) { // fino a un minuto
        await sleep(500);
        if (this.proc !== proc) throw new Error("Il motore non è partito. Dettagli in " + path.join(this.home, "engine.log"));
        try {
          const r = await fetch(url + "/api/health", { signal: AbortSignal.timeout(2000) });
          if (r.ok) {
            this.restarts = 0;
            this.emit({ state: "ready", message: "", url, token });
            return this.status;
          }
        } catch { /* non ancora */ }
      }
      throw new Error("Il motore non risponde. Dettagli in " + path.join(this.home, "engine.log"));
    } catch (e) {
      this.log("errore: " + e.message);
      this.emit({ state: "error", message: e.message, url: "", token: "" });
      throw e;
    }
  }

  stop() {
    const p = this.proc;
    this.proc = null;
    if (!p) return Promise.resolve();
    this.emit({ state: "off", url: "", token: "" });
    return new Promise((resolve) => {
      const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* niente */ } resolve(); }, 4000);
      p.once("exit", () => { clearTimeout(t); resolve(); });
      try { p.kill("SIGTERM"); } catch { clearTimeout(t); resolve(); }
    });
  }
}

module.exports = { LocalEngine, findPython };
