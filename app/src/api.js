// Comunicazione con il motore di Atlante sul server.

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

export async function api(path, { method = "GET", params, body, override } = {}) {
  const c = override || cfg;
  let res;
  try {
    res = await fetch(c.url + "/api" + path + qs(params), {
      method,
      headers: {
        Authorization: "Bearer " + c.token,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
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
  return res.json();
}

export const rawUrl = (id) => `${cfg.url}/api/raw${qs({ id, token: cfg.token })}`;
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
