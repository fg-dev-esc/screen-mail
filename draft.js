const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");

class Draft extends EventEmitter {
  constructor({ transcribe, sendMail, wait = (ms, signal) => delay(ms, undefined, { signal }) }) {
    super();
    this.transcribe = transcribe;
    this.sendMail = sendMail;
    this.wait = wait;
    this.shots = [];
    this.note = "";
    this.sending = false;
    this.capturing = false;
    this.error = "";
    this.notice = "";
    this.queue = Promise.resolve();
  }

  snapshot() {
    return {
      shots: this.shots.map(({ id, preview, transcript, ocrStatus, error, buffer, retryAt }) => ({
        id, preview, transcript, ocrStatus, error, retryAt, bytes: buffer.length,
      })),
      note: this.note,
      sending: this.sending,
      capturing: this.capturing,
      error: this.error,
      notice: this.notice,
    };
  }

  changed() { this.emit("change", this.snapshot()); }

  assertEditable() {
    if (this.sending) throw new Error("Hay un envío en curso.");
  }

  add(buffer, preview) {
    this.assertEditable();
    const shot = { id: randomUUID(), buffer, preview, transcript: "", ocrStatus: "pending", error: "" };
    this.shots.push(shot);
    this.notice = "";
    this.error = "";
    this.enqueue(shot);
    return shot.id;
  }

  enqueue(shot) {
    shot.ocrStatus = "pending";
    shot.error = "";
    shot.retryAt = 0;
    const controller = new AbortController();
    shot.controller = controller;
    const active = () => this.shots.includes(shot) && !controller.signal.aborted;
    this.queue = this.queue.then(async () => {
      try {
        while (active()) {
          shot.ocrStatus = "processing";
          shot.retryAt = 0;
          shot.error = "";
          this.changed();
          try {
            const text = await this.transcribe(shot.buffer, { signal: controller.signal });
            if (active()) {
              shot.transcript = text;
              shot.ocrStatus = "ready";
            }
            break;
          } catch (error) {
            if (!active()) break;
            if (!Number.isFinite(error.retryAfterMs)) throw error;
            shot.ocrStatus = "waiting";
            shot.retryAt = Date.now() + error.retryAfterMs;
            shot.error = "Groq alcanzó su cuota. Se reintentará automáticamente; puedes cancelar el OCR y conservar la imagen.";
            this.changed();
            await this.wait(error.retryAfterMs, controller.signal);
          }
        }
      } catch (error) {
        if (active()) {
          shot.ocrStatus = error.partialText ? "partial" : "error";
          if (error.partialText) shot.transcript = error.partialText;
          shot.error = error.name === "TimeoutError" ? "Groq tardó demasiado. Reintenta la transcripción." : error.message;
        }
      } finally {
        if (shot.controller === controller) {
          delete shot.controller;
          shot.retryAt = 0;
        }
        this.changed();
      }
    });
    this.changed();
  }

  remove(id) {
    this.assertEditable();
    const shot = this.shots.find((item) => item.id === id);
    this.shots = this.shots.filter((item) => item.id !== id);
    shot?.controller?.abort();
    this.error = "";
    this.changed();
  }

  retry(id) {
    this.assertEditable();
    const shot = this.shots.find((item) => item.id === id);
    if (["error", "cancelled"].includes(shot?.ocrStatus)) this.enqueue(shot);
  }

  cancel(id) {
    const shot = this.shots.find((item) => item.id === id);
    if (!shot || !["pending", "processing", "waiting"].includes(shot.ocrStatus)) return;
    shot.controller?.abort();
    shot.ocrStatus = "cancelled";
    shot.retryAt = 0;
    shot.error = "OCR cancelado. La imagen se conserva y se puede enviar.";
    this.changed();
  }

  setNote(text) {
    this.assertEditable();
    if (typeof text !== "string" || text.length > 100_000) throw new Error("El comentario es demasiado largo.");
    this.note = text;
  }

  edit(id, text) {
    this.assertEditable();
    if (typeof text !== "string" || text.length > 100_000) throw new Error("La transcripción es demasiado larga.");
    const shot = this.shots.find((item) => item.id === id);
    if (["ready", "partial"].includes(shot?.ocrStatus)) shot.transcript = text;
  }

  async send() {
    this.assertEditable();
    if (this.capturing) throw new Error("Espera a que termine la captura.");
    if (!this.shots.length && !this.note.trim()) throw new Error("Escribe un mensaje o añade una captura.");
    this.sending = true;
    this.error = "";
    this.notice = "";
    this.changed();
    try {
      await this.queue;
      await this.sendMail(this.shots, this.note);
      this.shots = [];
      this.note = "";
      this.notice = "Enviado · el servidor de correo aceptó el mensaje.";
    } catch (error) {
      this.error = error.message;
      throw error;
    } finally {
      this.sending = false;
      this.changed();
    }
  }

  dispose() {
    for (const shot of this.shots) shot.controller?.abort();
    this.shots = [];
  }
}

module.exports = { Draft };
