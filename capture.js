const { desktopCapturer, screen, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

async function captureDisplay(panel, mode = "screen") {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  panel.hide();
  // Da tiempo al compositor de Windows para retirar el panel de la pantalla.
  await delay(200);
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.round(display.bounds.width * display.scaleFactor),
      height: Math.round(display.bounds.height * display.scaleFactor),
    },
    fetchWindowIcons: false,
  });
  const source = sources.find((item) => item.display_id === String(display.id));
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error("No se pudo capturar el monitor donde está el cursor.");
  }
  return mode === "region" ? selectRegion(source.thumbnail, display) : source.thumbnail;
}

function selectRegion(image, display) {
  const overlay = new BrowserWindow({
    ...display.bounds,
    frame: false,
    roundedCorners: false,
    fullscreen: true,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: "#000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  return new Promise((resolve, reject) => {
    let finished = false;
    const settle = (result, error) => {
      if (finished) return;
      finished = true;
      ipcMain.removeHandler("selection:image");
      ipcMain.removeListener("selection:finish", finish);
      if (!overlay.isDestroyed()) overlay.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const finish = (event, rect) => {
      if (event.sender !== overlay.webContents) return;
      if (!rect) return settle(null);
      try {
        if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) throw new Error("Selección inválida.");
        if (rect.width < 5 || rect.height < 5) return;
        const [width, height] = overlay.getContentSize();
        const size = image.getSize();
        const left = Math.max(0, Math.min(size.width, Math.floor(rect.x * size.width / width)));
        const top = Math.max(0, Math.min(size.height, Math.floor(rect.y * size.height / height)));
        const right = Math.max(left, Math.min(size.width, Math.ceil((rect.x + rect.width) * size.width / width)));
        const bottom = Math.max(top, Math.min(size.height, Math.ceil((rect.y + rect.height) * size.height / height)));
        if (right === left || bottom === top) return;
        settle(image.crop({ x: left, y: top, width: right - left, height: bottom - top }));
      } catch (error) { settle(null, error); }
    };
    ipcMain.handle("selection:image", (event) => {
      if (event.sender !== overlay.webContents) throw new Error("Origen de selección inválido.");
      return image.toDataURL();
    });
    ipcMain.on("selection:finish", finish);
    overlay.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    overlay.webContents.on("will-navigate", (event) => event.preventDefault());
    overlay.once("closed", () => settle(null));
    overlay.once("ready-to-show", () => {
      if (finished) return;
      overlay.setAlwaysOnTop(true, "screen-saver");
      overlay.show();
      overlay.focus();
    });
    overlay.loadFile(path.join(__dirname, "selector.html")).catch((error) => settle(null, error));
  });
}

module.exports = { captureDisplay, selectRegion };
