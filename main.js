const { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, screen, Tray } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { captureDisplay } = require("./capture");
const { Draft } = require("./draft");
const { transcribe } = require("./vision");
const { sendMail } = require("./mail");

const envFile = path.join(__dirname, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const CAPTURE_SHORTCUT = "Control+Shift+S";
const TOGGLE_SHORTCUT = "Control+Shift+A";
const startHidden = process.argv.includes("--start-hidden");
const draft = new Draft({ transcribe, sendMail });
let panel;
let tray;
let quitting = false;
let captureMode = "screen";
const missing = ["MAIL_USER", "MAIL_APP_PASSWORD", "GROQ_API_KEY"].filter((key) => !process.env[key]);
const state = () => ({ ...draft.snapshot(), missing, captureMode });

function setCaptureMode(mode) {
  if (!["screen", "region"].includes(mode)) throw new Error("Modo de captura inválido.");
  if (draft.capturing) throw new Error("Espera a que termine la captura.");
  fs.writeFileSync(path.join(app.getPath("userData"), "settings.json"), JSON.stringify({ captureMode: mode }), "utf8");
  captureMode = mode;
  publish();
}

function publish() {
  if (panel && !panel.isDestroyed()) panel.webContents.send("draft:changed", state());
}
draft.on("change", publish);

function showPanel() {
  if (!panel || panel.isDestroyed() || quitting || draft.capturing) return;
  if (panel.isMinimized()) panel.restore();
  panel.show();
  panel.focus();
}

function togglePanel() {
  if (draft.capturing) return;
  if (panel?.isVisible() && !panel.isMinimized()) panel.hide();
  else showPanel();
}

async function action(callback) {
  try {
    return { ok: true, value: await callback() };
  } catch (error) {
    draft.error = error.message || "No se pudo completar la acción.";
    publish();
    return { ok: false, error: draft.error };
  }
}

async function capture() {
  draft.assertEditable();
  if (draft.capturing) return;
  draft.capturing = true;
  draft.error = "";
  draft.notice = "";
  publish();
  try {
    const image = await captureDisplay(panel, captureMode);
    if (image) draft.add(image.toPNG(), image.resize({ width: Math.min(480, image.getSize().width) }).toDataURL());
  } finally {
    draft.capturing = false;
    publish();
    showPanel();
  }
}

function icon() {
  const pixels = Buffer.alloc(32 * 32 * 4);
  for (let y = 4; y < 28; y++) {
    for (let x = 4; x < 28; x++) {
      const edge = x < 7 || x > 24 || y < 7 || y > 24;
      if (!edge && !(x >= 10 && x <= 21 && y >= 14 && y <= 17)) continue;
      const offset = (y * 32 + x) * 4;
      pixels.set([255, 255, 255, 255], offset);
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: 32, height: 32 });
}

async function bootstrap() {
  const settingsFile = path.join(app.getPath("userData"), "settings.json");
  if (fs.existsSync(settingsFile)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
      if (["screen", "region"].includes(settings.captureMode)) captureMode = settings.captureMode;
    } catch { draft.error = "No se pudo leer la preferencia de captura. Se usará pantalla completa."; }
  }
  const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = Math.min(580, workArea.width - 32);
  const height = Math.min(740, workArea.height - 32);
  panel = new BrowserWindow({
    width, height,
    minWidth: Math.min(420, width),
    minHeight: Math.min(420, height),
    x: workArea.x + workArea.width - width - 16,
    y: workArea.y + 16,
    frame: false,
    roundedCorners: false,
    backgroundColor: "#0a0a0a",
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    icon: icon(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  panel.on("close", (event) => {
    if (!quitting) { event.preventDefault(); panel.hide(); }
  });
  panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  panel.webContents.on("will-navigate", (event) => event.preventDefault());

  const handle = (channel, callback) => ipcMain.handle(channel, (event, ...args) => {
    if (event.sender !== panel.webContents) throw new Error("Origen IPC inválido.");
    return action(() => callback(...args));
  });
  handle("draft:get", state);
  handle("draft:capture", capture);
  handle("settings:capture-mode", setCaptureMode);
  handle("draft:note", (text) => draft.setNote(text));
  handle("draft:edit", (id, text) => draft.edit(id, text));
  handle("draft:remove", (id) => draft.remove(id));
  handle("draft:retry", (id) => draft.retry(id));
  handle("draft:cancel", (id) => draft.cancel(id));
  handle("draft:send", ({ note, transcripts }) => {
    draft.setNote(note);
    for (const { id, text } of transcripts) draft.edit(id, text);
    return draft.send();
  });
  handle("draft:preview", (id) => {
    const shot = draft.shots.find((item) => item.id === id);
    return shot ? `data:image/png;base64,${shot.buffer.toString("base64")}` : null;
  });
  ipcMain.on("panel:hide", (event) => {
    if (event.sender === panel.webContents) panel.hide();
  });

  tray = new Tray(icon());
  tray.setToolTip("Screen Mail · Ctrl+Mayús+A abrir · Ctrl+Mayús+S capturar");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Mostrar / ocultar · Ctrl+Mayús+A", click: togglePanel },
    { label: "Capturar · Ctrl+Mayús+S", click: () => action(capture) },
    { type: "separator" },
    { label: "Salir", click: () => app.quit() },
  ]));
  tray.on("double-click", showPanel);
  if (!globalShortcut.register(CAPTURE_SHORTCUT, () => action(capture))) {
    draft.error = "Ctrl+Mayús+S está ocupado. Puedes capturar con el botón del panel.";
  }
  if (!globalShortcut.register(TOGGLE_SHORTCUT, togglePanel)) {
    draft.error += " Ctrl+Mayús+A está ocupado. Abre el panel desde la bandeja.";
  }
  await panel.loadFile(path.join(__dirname, "panel.html"));
  if (!startHidden) showPanel();
}

app.setName("Screen Mail");
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showPanel);
  app.on("activate", showPanel);
  app.on("window-all-closed", () => {});
  app.on("before-quit", () => {
    quitting = true;
    draft.dispose();
    globalShortcut.unregisterAll();
  });
  app.whenReady().then(bootstrap).catch((error) => {
    dialog.showErrorBox("Screen Mail", error.message);
    app.quit();
  });
}
