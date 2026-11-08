// Comunicazione con il motore di Atlante (sul server, oppure su questo Mac).

const bridge = window.atlanteBridge || null;
let cfg = { url: "", token: "", theme: "auto" };

export async function loadConfig() {
  if (bridge) cfg = await bridge.getConfig();
  else {
    try {
      cfg = { ...cfg, ...JSON.parse(localStorage.getItem("atlante-config") || "{}") };
    } catch { /* niente */ }
  }
  return cfg;
}

export async function saveConfig(next) {
  if (bridge) cfg = await bridge.setConfig(next);
  else {
    cfg = { ...cfg, ...next, url: (next.url ?? cfg.url).replace(/\/+$/, "") };
    try { localStorage.setItem("atlante-config", JSON.stringify(cfg)); } catch { /* niente */ }
  }
  return cfg;
}

export const config = () => cfg;
export const isConfigured = () => Boolean(cfg.url && cfg.token);
/** Modalità «Questo Mac»: il motore gira sul Mac, avviato dall'app. */
export const isLocalMode = () => cfg.mode === "local";
export const canUseLocalEngine = () => Boolean(bridge?.engineStatus);
export const engineStatus = () => (bridge?.engineStatus ? bridge.engineStatus() : Promise.resolve({ state: "off" }));
export const engineRetry = async () => { if (bridge?.engineRetry) cfg = await bridge.engineRetry(); return cfg; };
export const engineDefaultVault = () => (bridge?.engineDefaultVault ? bridge.engineDefaultVault() : Promise.resolve(""));
export const pickFolder = (opts) => (bridge?.pickFolder ? bridge.pickFolder(opts) : Promise.resolve(null));
export const onEngineStatus = (fn) => bridge?.onEngineStatus?.(fn);
/** Nome della fonte dei file: «Server», oppure la cartella scelta su questo Mac. */
export const sourceName = () => (isLocalMode() && cfg.localStorage ? cfg.localStorage.split("/").filter(Boolean).pop() || "Mac" : "Server");

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  }
  const s = p.toString();
  return s ? "?" + s : "";
}

// ---------------------------------------------------------------- copia sul Mac (offline)
// Quando il server non risponde, le richieste vanno alla copia del vault sul Mac (processo principale),
// che si sincronizza da sola appena il server torna raggiungibile.
const hasLocal = () => Boolean(bridge?.vaultRequest) && cfg.mode !== "local"; // con il motore sul Mac non serve
let vault = { online: null, syncing: false, last: null, error: null, conflicts: [], root: "" };
const vaultListeners = new Set();
export const vaultState = () => vault;
export const isOffline = () => hasLocal() && vault.online === false;
export const onVaultStatus = (fn) => { vaultListeners.add(fn); return () => vaultListeners.delete(fn); };
export const syncNow = () => (bridge?.vaultSyncNow ? bridge.vaultSyncNow() : Promise.resolve(null));
export const revealVault = () => bridge?.vaultReveal?.();
function setVault(st) {
  const was = vault.online;
  vault = { ...vault, ...st };
  vaultListeners.forEach((fn) => fn(vault, was));
}
if (hasLocal()) {
  bridge.vaultStatus().then(setVault).catch(() => {});
  bridge.onVaultStatus(setVault);
}

async function local(path, method, params, body) {
  const r = await bridge.vaultRequest(path, { method, params: params || {}, body: body || {} });
  if (!r.ok) throw new ApiError(r.status, r.detail);
  return r.data;
}

const WRITES = new Set(["POST", "PUT", "DELETE"]);

export async function api(path, { method = "GET", params, body, override } = {}) {
  const c = override || cfg;
  if (!override && isOffline()) return local(path, method, params, body);
  let res;
  try {
    res = await fetch(c.url + "/api" + path + qs(params), {
      method,
      headers: {
        Authorization: "Bearer " + c.token,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    if (e?.name === "TimeoutError") { // il server c'è ma è lento: non passo alla copia offline
      throw new ApiError(0, "Il server non ha risposto in tempo. Riprova tra poco.");
    }
    if (!override && hasLocal() && c.url) {
      bridge.vaultOffline();
      setVault({ online: false });
      return local(path, method, params, body);
    }
    throw new ApiError(0, "Il server non risponde. Controlla che il Mac sia collegato a Tailscale.");
  }
  if (!res.ok) {
    let msg = `Errore ${res.status} ${res.statusText}`.trim();
    try {
      const raw = await res.text();
      try { msg = JSON.parse(raw).detail || msg; } catch { if (raw.trim()) msg = `Errore ${res.status}: ${raw.trim().slice(0, 300)}`; }
    } catch { /* niente */ }
    if (res.status === 401) msg = "Token non valido: aprilo dalle impostazioni e controllalo.";
    throw new ApiError(res.status, msg);
  }
  if (!override && WRITES.has(method) && hasLocal()) bridge.vaultSyncSoon(); // la copia sul Mac si aggiorna subito
  return res.json();
}

/** Indirizzo di un file: dal server, oppure dalla copia sul Mac se sei offline e il file è del vault. */
export const rawUrl = (id) => {
  if (isOffline() && id.startsWith("n:") && vault.root) {
    return "file://" + vault.root.split("/").map(encodeURIComponent).join("/") + "/" + id.slice(2).split("/").map(encodeURIComponent).join("/");
  }
  return `${cfg.url}/api/raw${qs({ id, token: cfg.token })}`;
};

export const thumbUrl = (id, size = 320) => `${cfg.url}/api/thumb${qs({ id, size, token: cfg.token })}`;

export function download(id) {
  const url = rawUrl(id);
  if (bridge) bridge.download(url);
  else window.open(url, "_blank");
}

export function openExternal(url) {
  if (bridge) bridge.openExternal(url);
  else window.open(url, "_blank", "noopener");
}

export const hasBridge = () => Boolean(bridge);
export const isMacApp = () => bridge?.platform === "darwin";
export const onCommand = (fn) => bridge?.onCommand(fn);
export const aiAvailable = () => Boolean(bridge?.aiStatus);
export const aiStatus = () => (bridge?.aiStatus ? bridge.aiStatus() : Promise.resolve(null));
export const aiModels = () => (bridge?.aiModels ? bridge.aiModels() : Promise.resolve({ ok: false, models: [] }));
export const onAiStatus = (fn) => bridge?.onAiStatus?.(fn);
export const canAsk = () => Boolean(bridge?.aiAsk);
export const aiAsk = (q) => bridge.aiAsk(q);
export const askJobs = () => (bridge?.aiAskJobs ? bridge.aiAskJobs() : Promise.resolve([]));
export const askClear = () => (bridge?.aiAskClear ? bridge.aiAskClear() : Promise.resolve([]));
const jobListeners = new Set();
if (typeof window !== "undefined") bridge?.onAiAskJobs?.((jobs) => jobListeners.forEach((fn) => fn(jobs)));
/** Ascolta la coda delle domande; restituisce la funzione per smettere. */
export const onAskJobs = (fn) => { jobListeners.add(fn); return () => jobListeners.delete(fn); };
