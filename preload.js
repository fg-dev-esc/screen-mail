const { contextBridge, ipcRenderer } = require("electron");

async function invoke(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

contextBridge.exposeInMainWorld("mail", {
  getDraft: () => invoke("draft:get"),
  capture: () => invoke("draft:capture"),
  setCaptureMode: (mode) => invoke("settings:capture-mode", mode),
  setNote: (text) => invoke("draft:note", text),
  edit: (id, text) => invoke("draft:edit", id, text),
  remove: (id) => invoke("draft:remove", id),
  retry: (id) => invoke("draft:retry", id),
  cancel: (id) => invoke("draft:cancel", id),
  send: (value) => invoke("draft:send", value),
  preview: (id) => invoke("draft:preview", id),
  hide: () => ipcRenderer.send("panel:hide"),
  onChange: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("draft:changed", listener);
    return () => ipcRenderer.removeListener("draft:changed", listener);
  },
});

contextBridge.exposeInMainWorld("selection", {
  getImage: () => ipcRenderer.invoke("selection:image"),
  finish: (rect) => ipcRenderer.send("selection:finish", rect),
});
