// Atlante — processo principale di Electron (finestra, impostazioni, download).
const { app, BrowserWindow, ipcMain, safeStorage, shell, Menu, dialog, powerMonitor, powerSaveBlocker } = require("electron");
const { AiWorker } = require("./ai-worker");
const { createVault } = require("./dist/vault.cjs");
const { LocalEngine } = require("./engine");
const path = require("path");
const fs = require("fs");

const CONFIG_FILE = () => path.join(app.getPath("userData"), "config.json");

// Il file di configurazione contiene:
//   mode          "server" (predefinito) oppure "local" (motore su questo Mac)
//   url, token    il motore sul server (token cifrato con il Portachiavi)
//   localStorage, localVault   in modalità local: la cartella da organizzare e quella delle note
function readStored() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE(), "utf8"));
    let token = c.token_plain || "";
    if (c.token_enc && safeStorage.isEncryptionAvailable()) {
      token = safeStorage.decryptString(Buffer.from(c.token_enc, "base64"));
    }
    return {
      mode: c.mode === "local" ? "local" : "server", url: c.url || "", token, theme: c.theme || "auto",
      localStorage: c.localStorage || "", localVault: c.localVault || "", ...aiFields(c),
    };
  } catch {
    return { mode: "server", url: "", token: "", theme: "auto", localStorage: "", localVault: "", ...aiFields({}) };
  }
}

/** Configurazione per il resto dell'app: url e token sono quelli del motore in uso (server o Mac). */
function readConfig() {
  const s = readStored();
  const out = { ...s, serverUrl: s.url, serverToken: s.token, hasServerToken: Boolean(s.token) };
  if (s.mode === "local") {
    const st = engine?.status || {};
    out.url = st.state === "ready" ? st.url : "";
    out.token = st.state === "ready" ? st.token : "";
    out.engine = { state: st.state || "off", message: st.message || "" };
  }
  return out;
}

function aiFields(c) {
  return { aiEnabled: Boolean(c.aiEnabled), aiModel: c.aiModel || "", aiBattery: c.aiBattery !== false };
}

function writeConfig({ url, token, theme, mode, localStorage, localVault, ...rest }) {
  const out = {
    mode: mode === "local" ? "local" : "server", url: (url || "").replace(/\/+$/, ""), theme: theme || "auto",
    localStorage: localStorage || "", localVault: localVault || "", ...aiFields(rest),
  };
  if (token) {
    if (safeStorage.isEncryptionAvailable()) {
      out.token_enc = safeStorage.encryptString(token).toString("base64");
    } else if (process.platform !== "darwin") {
      out.token_plain = token; // solo fuori dal Mac, senza portachiavi: file leggibile solo dall'utente
    } else {
      throw new Error("Il Portachiavi del Mac non è disponibile: non posso salvare il token.");
    }
  }
  fs.mkdirSync(path.dirname(CONFIG_FILE()), { recursive: true });
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify(out, null, 2), { mode: 0o600 });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    title: "Atlante",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: "#13202a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      plugins: true, // visualizzatore PDF integrato
      spellcheck: true,
    },
  });
  win.loadFile(path.join(__dirname, "dist", "index.html"));

  // i link esterni si aprono nel browser, mai dentro l'app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file://")) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  // download dei file del server nella cartella Download
  win.webContents.session.on("will-download", (_e, item) => {
    const target = path.join(app.getPath("downloads"), item.getFilename());
    item.setSavePath(target);
    item.once("done", (_ev, state) => {
      if (state === "completed") shell.showItemInFolder(target);
      else dialog.showErrorBox("Download non riuscito", `Non è stato possibile scaricare ${item.getFilename()}.`);
    });
  });
  return win;
}

ipcMain.handle("config:get", () => readConfig());
ipcMain.handle("config:set", async (_e, c) => {
  const cur = readStored(); // i valori salvati, non quelli del motore in uso
  writeConfig({
    mode: c.mode ?? cur.mode, url: c.url ?? cur.url, token: c.token ?? cur.token, theme: c.theme ?? cur.theme,
    localStorage: c.localStorage ?? cur.localStorage, localVault: c.localVault ?? cur.localVault,
    aiEnabled: c.aiEnabled ?? cur.aiEnabled, aiModel: c.aiModel ?? cur.aiModel, aiBattery: c.aiBattery ?? cur.aiBattery,
  });
  await applyMode();
  const next = readConfig();
  applyAi(next);
  return next;
});

// ---- motore su questo Mac (solo se nelle impostazioni scegli «Questo Mac»)
let engine = null;
function getEngine() {
  if (!engine) {
    engine = new LocalEngine({
      home: path.join(app.getPath("userData"), "engine"),
      source: app.isPackaged ? path.join(process.resourcesPath, "engine") : path.join(__dirname, "..", "server"),
      onStatus: (st) => {
        BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("engine-status", { state: st.state, message: st.message }));
        if (st.state === "ready" || st.state === "error") applyAi(readConfig());
      },
    });
  }
  return engine;
}
/** Avvia o ferma il motore sul Mac secondo la modalità scelta. In modalità server non tocca niente. */
async function applyMode() {
  const s = readStored();
  if (s.mode === "local") {
    vault?.sync.stop();
    try { await getEngine().start({ storage: s.localStorage, vault: s.localVault }); } catch { /* lo stato dice cosa non va */ }
  } else if (engine) {
    await engine.stop();
  }
}
ipcMain.handle("engine:status", () => (engine ? { state: engine.status.state, message: engine.status.message } : { state: "off", message: "" }));
ipcMain.handle("engine:retry", async () => { await applyMode(); return readConfig(); });
ipcMain.handle("engine:default-vault", () => path.join(app.getPath("documents"), "Atlante"));
ipcMain.handle("engine:pick-folder", async (e, { title, defaultPath } = {}) => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    title: title || "Scegli una cartella", defaultPath: defaultPath || app.getPath("home"),
    properties: ["openDirectory", "createDirectory"], buttonLabel: "Scegli",
  });
  return r.canceled ? null : r.filePaths[0];
});

// ---- analisi con Ollama
let configCache = null;
let blocker = null;
const worker = new AiWorker({
  getConfig: () => configCache || readConfig(),
  broadcast: (st) => {
    // mentre l'LLM lavora il Mac non va in stop da solo (lo schermo può spegnersi)
    if (st.state === "running" && blocker === null) blocker = powerSaveBlocker.start("prevent-app-suspension");
    if (st.state !== "running" && blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("ai-status", st));
  },
  isOnBattery: () => powerMonitor.isOnBatteryPower(),
});
function applyAi(cfg) {
  configCache = cfg;
  if (cfg.mode === "server") vault?.sync.start(); // la copia offline serve solo con il server
  if (cfg.aiEnabled && cfg.url && cfg.token) worker.start();
  else worker.stop();
}
ipcMain.handle("ai:status", () => worker.status);
ipcMain.handle("ai:models", async () => {
  try {
    return { ok: true, models: await worker.models() };
  } catch (e) {
    return { ok: false, error: e.message, models: [] };
  }
});
// ---- copia del vault sul Mac, per lavorare anche senza il server
let vault = null;
function startVault() {
  vault = createVault({
    userData: app.getPath("userData"),
    getConfig: () => configCache || readConfig(),
    onStatus: (st) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("vault-status", st)),
  });
  vault.sync.start();
}
ipcMain.handle("vault:request", (_e, p, opts) => vault.request(p, opts));
ipcMain.handle("vault:status", () => ({ ...vault.sync.status, root: vault.root }));
ipcMain.handle("vault:offline", () => vault.sync.reportOffline());
ipcMain.handle("vault:sync-soon", () => vault.sync.syncSoon());
ipcMain.handle("vault:sync-now", async () => {
  try { await vault.sync.probe(); } catch { /* lo stato dice cosa è successo */ }
  return vault.sync.status;
});
ipcMain.handle("vault:reveal", () => shell.openPath(vault.root));

ipcMain.handle("download", (e, url) => {
  e.sender.downloadURL(url);
});
ipcMain.handle("open-external", (_e, url) => {
  if (/^https?:/i.test(url)) shell.openExternal(url);
});

function buildMenu() {
  const send = (cmd) => () => BrowserWindow.getFocusedWindow()?.webContents.send("command", cmd);
  const template = [
    { role: "appMenu" },
    {
      label: "File",
      submenu: [
        { label: "Nuova nota", accelerator: "CmdOrCtrl+N", click: send("note:new") },
        { label: "Apri rapidamente…", accelerator: "CmdOrCtrl+O", click: send("quick:open") },
        { label: "Palette dei comandi…", accelerator: "CmdOrCtrl+P", click: send("palette:open") },
        { type: "separator" },
        { label: "Chiudi scheda", accelerator: "CmdOrCtrl+W", click: send("tab:close") },
      ],
    },
    { role: "editMenu" },
    {
      label: "Vista",
      submenu: [
        { label: "Modifica / lettura", accelerator: "CmdOrCtrl+E", click: send("note:toggle-mode") },
        { label: "Grafo", accelerator: "CmdOrCtrl+G", click: send("graph:open") },
        { label: "Cerca nel server", accelerator: "CmdOrCtrl+Shift+F", click: send("search:open") },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
        { role: "togglefullscreen" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  startVault();
  createWindow();
  applyAi(readConfig());
  applyMode();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", (e) => {
  if (!engine?.proc) return;
  e.preventDefault(); // fermo il motore sul Mac prima di uscire
  engine.stop().finally(() => { engine.proc = null; app.quit(); });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
