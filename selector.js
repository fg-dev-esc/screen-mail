const box = document.querySelector("#selection");
let start;
let ready = false;
window.selection.getImage().then(async (url) => {
  const image = document.querySelector("#screen");
  image.src = url;
  await image.decode();
  ready = true;
}).catch(() => window.selection.finish(null));

function rectangle(event) {
  const x = Math.max(0, Math.min(innerWidth, event.clientX));
  const y = Math.max(0, Math.min(innerHeight, event.clientY));
  return { x: Math.min(start.x, x), y: Math.min(start.y, y), width: Math.abs(start.x - x), height: Math.abs(start.y - y) };
}
window.addEventListener("pointerdown", (event) => {
  if (!ready || event.button !== 0) return;
  start = { x: event.clientX, y: event.clientY };
  document.body.setPointerCapture(event.pointerId);
  box.hidden = false;
  Object.assign(box.style, { left: `${start.x}px`, top: `${start.y}px`, width: "0px", height: "0px" });
});
window.addEventListener("pointermove", (event) => {
  if (!start) return;
  const rect = rectangle(event);
  Object.assign(box.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
});
window.addEventListener("pointerup", (event) => {
  if (!start) return;
  const rect = rectangle(event);
  start = null;
  if (rect.width >= 5 && rect.height >= 5) window.selection.finish(rect);
  else box.hidden = true;
});
window.addEventListener("pointercancel", () => { start = null; box.hidden = true; });
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") window.selection.finish(null);
});
