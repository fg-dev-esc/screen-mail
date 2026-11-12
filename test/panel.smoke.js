const { app, nativeImage, screen } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

// Ejecuta main, preload, borrador y UI reales. Solo sustituye servicios externos.
app.setPath("userData", path.join(app.getPath("temp"), "opencode", `screen-mail-smoke-${process.pid}`));
process.env.MAIL_USER = "synthetic@example.com";
process.env.MAIL_APP_PASSWORD = "synthetic-password";
process.env.GROQ_API_KEY = "synthetic-key";
const sent = [];
let ocrCalls = 0;
const captureModes = [];
const syntheticImage = () => nativeImage.createFromBitmap(Buffer.alloc(32 * 32 * 4, 255), { width: 32, height: 32 });
require("../capture").captureDisplay = async (_panel, mode) => {
  captureModes.push(mode);
  return syntheticImage();
};
require("../vision").transcribe = async () => {
  if (++ocrCalls > 1) throw new Error("Groq HTTP 429 simulado");
  return "texto original";
};
require("../mail").sendMail = async (shots, note) => {
  sent.push({ note, transcripts: shots.map((shot) => shot.transcript) });
  if (sent.length === 1) throw new Error("SMTP simulado desconectado");
};

const rendererErrors = [];
const loaded = new Promise((resolve) => {
  app.once("browser-window-created", (_event, window) => {
    window.webContents.on("console-message", (event) => {
      if (event.level === "error") rendererErrors.push(event.message);
    });
    window.webContents.once("did-finish-load", () => resolve(window));
  });
});
require("../main");

const watchdog = setTimeout(() => { console.error("Startup timeout"); app.exit(1); }, 20_000);
loaded.then(async (window) => {
  const evaluate = (code) => window.webContents.executeJavaScript(code, true);
  const waitFor = (expression) => evaluate(`new Promise((resolve, reject) => {
    if (${expression}) return resolve(true);
    const observer = new MutationObserver(() => {
      if (${expression}) { observer.disconnect(); clearTimeout(timeout); resolve(true); }
    });
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('UI timeout')); }, 5000);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  })`);
  await waitFor('document.querySelector("#summary").textContent.includes("MB")');
  assert.equal(await evaluate('document.querySelector("#send").disabled'), true);
  await evaluate(`
    document.querySelector('#capture-mode').value = 'region';
    document.querySelector('#capture-mode').dispatchEvent(new Event('change'));
  `);
  assert.equal((await evaluate('window.mail.getDraft()')).captureMode, "region");
  assert.equal(JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "settings.json"), "utf8")).captureMode, "region");
  await evaluate('document.querySelector("#capture").click()');
  await waitFor('document.querySelector(".shot")?.dataset.status === "ready"');
  assert.equal(await evaluate('document.querySelector(".transcript").value'), "texto original");
  assert.equal(captureModes[0], "region");
  await evaluate(`
    document.querySelector('#note').value = 'comentario conservado';
    document.querySelector('#note').dispatchEvent(new Event('input'));
    document.querySelector('.transcript').value = '<texto corregido>';
    document.querySelector('.transcript').dispatchEvent(new Event('input'));
    document.querySelector('#send').focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
  `);
  await waitFor('document.querySelector("#status").textContent.includes("SMTP simulado") && !document.querySelector("#send").disabled');
  assert.equal(sent[0].note, "comentario conservado");
  assert.equal(sent[0].transcripts[0], "<texto corregido>");
  assert.equal(await evaluate('document.querySelector("#note").value'), "comentario conservado");
  assert.equal(await evaluate('document.querySelector(".transcript").value'), "<texto corregido>");
  await evaluate('document.querySelector("#send").click()');
  await waitFor('document.querySelector("#status").textContent.startsWith("Enviado")');
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(ocrCalls, 1);
  assert.equal(await evaluate('document.querySelectorAll(".shot").length'), 0);
  assert.equal(await evaluate('document.querySelector("#note").value'), "");
  await evaluate('document.querySelector("#capture").click()');
  await waitFor('document.querySelector(".shot")?.dataset.status === "error"');
  assert.equal(await evaluate('document.querySelector("#send").disabled'), false);
  await evaluate(`
    document.querySelector('#note').value = 'Sin transcripción';
    document.querySelector('#note').dispatchEvent(new Event('input'));
    document.querySelector('#send').click();
  `);
  await waitFor('document.querySelector("#status").textContent.startsWith("Enviado")');
  assert.deepEqual(sent[2], { note: "Sin transcripción", transcripts: [""] });
  await evaluate(`
    document.querySelector('#note').value = 'Mensaje sin imágenes';
    document.querySelector('#note').dispatchEvent(new Event('input'));
  `);
  assert.equal(await evaluate('document.querySelector("#send").disabled'), false);
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }))`);
  await waitFor('document.querySelector("#status").textContent.startsWith("Enviado")');
  assert.deepEqual(sent[3], { note: "Mensaje sin imágenes", transcripts: [] });
  assert.equal(ocrCalls, 2);
  const fonts = await evaluate(`Promise.all([
    document.fonts.load('14px Geist'),
    document.fonts.load('14px "Geist Pixel"'),
    document.fonts.load('14px "Geist Mono"')
  ]).then(groups => groups.map(faces => faces.length > 0 && faces.every(face => face.status === 'loaded')))`);
  assert.deepEqual(fonts, [true, true, true]);
  assert.deepEqual(rendererErrors, []);
  // Selector real sobre una imagen sintética: valida recorte proporcional y cancelación.
  const { selectRegion } = require("../capture");
  async function openSelection() {
    const opened = new Promise((resolve) => {
      app.once("browser-window-created", (_event, overlay) => {
        overlay.webContents.once("did-finish-load", () => resolve(overlay));
      });
    });
    const result = selectRegion(syntheticImage(), screen.getPrimaryDisplay());
    const overlay = await opened;
    await overlay.webContents.executeJavaScript(`new Promise(resolve => {
      const image = document.querySelector('#screen');
      if (image.complete && image.naturalWidth) resolve();
      else image.addEventListener('load', () => resolve(), { once: true });
    })`);
    return { overlay, result };
  }
  const selected = await openSelection();
  const [width, height] = selected.overlay.getContentSize();
  await selected.overlay.webContents.executeJavaScript(`window.selection.finish({x:${width / 4}, y:${height / 4}, width:${width / 2}, height:${height / 2}})`);
  assert.deepEqual((await selected.result).getSize(), { width: 16, height: 16 });
  const cancelled = await openSelection();
  await cancelled.overlay.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  assert.equal(await cancelled.result, null);
  console.log("UI OK: envío con imágenes y solo texto, fuentes Geist locales, selector y preferencias.");
  clearTimeout(watchdog);
  app.quit();
}).catch((error) => {
  console.error(error);
  clearTimeout(watchdog);
  app.exit(1);
});
