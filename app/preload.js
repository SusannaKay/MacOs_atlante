// Ponte sicuro tra la finestra e il processo principale.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("atlanteBridge", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (c) => ipcRenderer.invoke("config:set", c),
  download: (url) => ipcRenderer.invoke("download", url),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  onCommand: (fn) => ipcRenderer.on("command", (_e, cmd) => fn(cmd)),
  aiStatus: () => ipcRenderer.invoke("ai:status"),
  aiModels: () => ipcRenderer.invoke("ai:models"),
  onAiStatus: (fn) => ipcRenderer.on("ai-status", (_e, st) => fn(st)),
  platform: process.platform,
});
