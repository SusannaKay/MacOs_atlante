// Atlante — processo principale di Electron (finestra, impostazioni, download).
const { app, BrowserWindow, ipcMain, safeStorage, shell, Menu, dialog, powerMonitor, powerSaveBlocker } = require("electron");
const { AiWorker } = require("./ai-worker");
const path = require("path");
const fs = require("fs");

const CONFIG_FILE = () => path.join(app.getPath("userData"), "config.json");

function readConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE(), "utf8"));
    let token = c.token_plain || "";
    if (c.token_enc && safeStorage.isEncryptionAvailable()) {
      token = safeStorage.decryptString(Buffer.from(c.token_enc, "base64"));
    }
    return { url: c.url || "", token, theme: c.theme || "auto", ...aiFields(c) };
  } catch {
    return { url: "", token: "", theme: "auto", ...aiFields({}) };
  }
}

function aiFields(c) {
  return { aiEnabled: Boolean(c.aiEnabled), aiModel: c.aiModel || "", aiBattery: c.aiBattery !== false };
}

function writeConfig({ url, token, theme, ...rest }) {
  const out = { url: (url || "").replace(/\/+$/, ""), theme: theme || "auto", ...aiFields(rest) };
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
ipcMain.handle("config:set", (_e, c) => {
  const cur = readConfig();
  writeConfig({
    url: c.url ?? cur.url, token: c.token ?? cur.token, theme: c.theme ?? cur.theme,
    aiEnabled: c.aiEnabled ?? cur.aiEnabled, aiModel: c.aiModel ?? cur.aiModel, aiBattery: c.aiBattery ?? cur.aiBattery,
  });
  const next = readConfig();
  applyAi(next);
  return next;
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
  createWindow();
  applyAi(readConfig());
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
