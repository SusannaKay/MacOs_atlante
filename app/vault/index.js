// Atlante — copia del vault sul Mac (processo principale).
// build.mjs la impacchetta in dist/vault.cjs insieme alla libreria yaml.
const path = require("path");
const fs = require("fs");
const { LocalVault, LocalError } = require("./local");
const { VaultSync } = require("./sync");

function createVault({ userData, getConfig, onStatus }) {
  const root = path.join(userData, "vault");
  fs.mkdirSync(root, { recursive: true });
  const local = new LocalVault(root);
  const logFile = path.join(userData, "vault-sync.log");
  const log = (msg) => {
    try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`); } catch { /* niente */ }
  };
  const sync = new VaultSync({ local, statePath: path.join(userData, "vault-sync.json"), getConfig, onStatus, log });

  /** Una richiesta all'API, servita dalla copia sul Mac. */
  function request(p, { method = "GET", params = {}, body = {} } = {}) {
    try {
      return { ok: true, data: local.handle(p, method, params || {}, body || {}, sync) };
    } catch (e) {
      if (!(e instanceof LocalError)) log(`locale ${method} ${p}: ${e.stack || e.message}`);
      return { ok: false, status: e.status || 500, detail: e.message };
    }
  }

  return { root, local, sync, request };
}

module.exports = { createVault };
