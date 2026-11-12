const gallery = document.querySelector("#gallery");
const empty = document.querySelector("#empty");
const note = document.querySelector("#note");
const status = document.querySelector("#status");
const sendButton = document.querySelector("#send");
const captureButton = document.querySelector("#capture");
const lightbox = document.querySelector("#lightbox");
const cards = new Map();
let current;
let submitting = false;

function report(error) {
  status.textContent = error.message;
  status.classList.add("error");
}

function run(task) { return Promise.resolve().then(task).catch(report); }

function makeCard(shot) {
  const card = document.querySelector("#shot-template").content.firstElementChild.cloneNode(true);
  card.dataset.id = shot.id;
  card.querySelector(".thumbnail img").src = shot.preview;
  card.querySelector(".remove").addEventListener("click", () => run(() => window.mail.remove(shot.id)));
  card.querySelector(".retry").addEventListener("click", () => run(() => window.mail.retry(shot.id)));
  card.querySelector(".cancel-ocr").addEventListener("click", () => run(() => window.mail.cancel(shot.id)));
  card.querySelector(".transcript").addEventListener("input", (event) => {
    run(() => window.mail.edit(shot.id, event.target.value));
  });
  card.querySelector(".thumbnail").addEventListener("click", () => run(async () => {
    const image = await window.mail.preview(shot.id);
    if (!image) return;
    document.querySelector("#full-image").src = image;
    if (!lightbox.open) lightbox.showModal();
  }));
  gallery.append(card);
  cards.set(shot.id, card);
  return card;
}

function render(state) {
  current = state;
  document.querySelector("#capture-mode").value = state.captureMode || "screen";
  document.querySelector("#capture-mode").disabled = state.capturing;
  const locked = state.sending || submitting;
  const ids = new Set(state.shots.map((shot) => shot.id));
  for (const [id, card] of cards) {
    if (!ids.has(id)) { card.remove(); cards.delete(id); }
  }
  state.shots.forEach((shot, index) => {
    const card = cards.get(shot.id) || makeCard(shot);
    card.dataset.status = shot.ocrStatus;
    card.querySelector(".shot-name").textContent = `CAPTURA ${String(index + 1).padStart(2, "0")}`;
    card.querySelector(".thumbnail img").alt = `Captura ${index + 1}`;
    card.querySelector(".ocr-status").textContent = {
      pending: "En cola", processing: "Transcribiendo…", ready: "Transcrita", error: "Error de transcripción",
      waiting: countdown(shot), cancelled: "OCR cancelado", partial: "Transcripción parcial",
    }[shot.ocrStatus];
    const input = card.querySelector(".transcript");
    if (document.activeElement !== input) input.value = shot.transcript;
    input.disabled = locked || !["ready", "partial"].includes(shot.ocrStatus);
    input.placeholder = shot.ocrStatus === "error" ? "Puedes enviar esta imagen sin transcripción o reintentar." : "Groq está preparando la transcripción…";
    card.querySelector(".remove").disabled = locked;
    card.querySelector(".retry").disabled = locked;
    card.querySelector(".retry").hidden = !["error", "cancelled"].includes(shot.ocrStatus);
    card.querySelector(".cancel-ocr").hidden = !["pending", "processing", "waiting"].includes(shot.ocrStatus);
    card.querySelector(".ocr-error").hidden = !["error", "waiting", "partial", "cancelled"].includes(shot.ocrStatus);
    card.querySelector(".ocr-error span").textContent = shot.error;
  });
  empty.hidden = state.shots.length > 0;
  const bytes = state.shots.reduce((total, shot) => total + shot.bytes, 0);
  document.querySelector("#summary").textContent = `${state.shots.length} captura${state.shots.length === 1 ? "" : "s"} · ${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (document.activeElement !== note || state.notice) note.value = state.note;
  note.disabled = locked;
  captureButton.disabled = locked || state.capturing;
  sendButton.disabled = locked || state.capturing || (!state.shots.length && !note.value.trim());
  const pending = state.shots.filter((shot) => ["pending", "processing", "waiting"].includes(shot.ocrStatus)).length;
  status.classList.toggle("error", Boolean(state.error));
  status.textContent = state.error || state.notice || (
    state.capturing ? "Capturando…" : locked ? (pending ? "Esperando transcripciones…" : "Enviando correo…") :
      pending ? `Transcribiendo · ${pending} pendiente${pending === 1 ? "" : "s"}` :
        state.shots.some((shot) => shot.ocrStatus === "error") ? "Listo para enviar · las imágenes sin transcripción también se incluyen." :
          state.shots.length || note.value.trim() ? "Listo para enviar" : "Captura la pantalla, transcribe con IA y envia por correo."
  );
  const config = document.querySelector("#config");
  config.hidden = !state.missing?.length;
  config.textContent = state.missing?.length ? `Completa ${state.missing.join(", ")} en screen-mail/.env y reinicia la app.` : "";
}

note.addEventListener("input", () => {
  if (current) current.note = note.value;
  if (current) {
    current.notice = "";
    render(current);
  }
  run(() => window.mail.setNote(note.value));
});
captureButton.addEventListener("click", () => run(() => window.mail.capture()));
document.querySelector("#capture-mode").addEventListener("change", (event) => {
  run(async () => {
    try { await window.mail.setCaptureMode(event.target.value); }
    finally { render(await window.mail.getDraft()); }
  });
});
document.querySelector("#close").addEventListener("click", () => window.mail.hide());
document.querySelector("#preview-close").addEventListener("click", () => lightbox.close());
lightbox.addEventListener("close", () => document.querySelector("#full-image").removeAttribute("src"));
document.querySelector("#composer").addEventListener("submit", (event) => {
  event.preventDefault();
  if (sendButton.disabled || submitting) return;
  const payload = {
    note: note.value,
    transcripts: current.shots.filter((shot) => ["ready", "partial"].includes(shot.ocrStatus)).map((shot) => ({
      id: shot.id,
      text: cards.get(shot.id).querySelector(".transcript").value,
    })),
  };
  submitting = true;
  render(current);
  run(async () => {
    await window.mail.send(payload);
  }).finally(() => {
    submitting = false;
    run(async () => render(await window.mail.getDraft()));
  });
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !lightbox.open) window.mail.hide();
  if (event.ctrlKey && event.key === "Enter" && !lightbox.open) {
    event.preventDefault();
    document.querySelector("#composer").requestSubmit();
  }
});
window.mail.onChange(render);
function countdown(shot) {
  return `Reintento en ${Math.max(0, Math.ceil((shot.retryAt - Date.now()) / 1000))} s`;
}
setInterval(() => {
  for (const shot of current?.shots || []) {
    if (shot.ocrStatus === "waiting") cards.get(shot.id)?.querySelector(".ocr-status").replaceChildren(countdown(shot));
  }
}, 250);
run(async () => render(await window.mail.getDraft()));
