const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Draft } = require("../draft");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("envía solo texto sin ejecutar OCR y rechaza mensajes vacíos o de espacios", async () => {
  let sent;
  const draft = new Draft({
    transcribe: async () => assert.fail("Un mensaje sin imágenes no requiere OCR"),
    sendMail: async (shots, note) => { sent = { count: shots.length, note }; },
  });
  await assert.rejects(draft.send(), /mensaje o añade/);
  draft.setNote(" \n  ");
  await assert.rejects(draft.send(), /mensaje o añade/);
  draft.setNote("Solo texto\nSegunda línea");
  await draft.send();
  assert.deepEqual(sent, { count: 0, note: "Solo texto\nSegunda línea" });
  assert.equal(draft.note, "");
});

test("429 publica la cuenta regresiva y reintenta automáticamente al terminar la espera", async () => {
  const gate = deferred();
  const waiting = deferred();
  let attempts = 0;
  const draft = new Draft({
    transcribe: async () => {
      if (++attempts === 1) throw Object.assign(new Error("429"), { retryAfterMs: 36_000 });
      return "recuperado";
    },
    sendMail: async () => {},
    wait: async (ms) => { assert.equal(ms, 36_000); waiting.resolve(); await gate.promise; },
  });
  draft.add(Buffer.from("png"), "preview");
  await waiting.promise;
  const shot = draft.snapshot().shots[0];
  assert.equal(shot.ocrStatus, "waiting");
  assert.ok(shot.retryAt > Date.now());
  assert.equal(attempts, 1);
  gate.resolve();
  await draft.queue;
  assert.equal(attempts, 2);
  assert.equal(draft.shots[0].transcript, "recuperado");
});

test("cancelar durante la espera aborta el temporizador y permite terminar un envío pendiente", async () => {
  const waiting = deferred();
  let attempts = 0;
  let sent;
  const draft = new Draft({
    transcribe: async () => { attempts++; throw Object.assign(new Error("429"), { retryAfterMs: 36_000 }); },
    sendMail: async (shots) => { sent = [...shots]; },
    wait: (_ms, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("abortado")), { once: true });
      waiting.resolve();
    }),
  });
  const id = draft.add(Buffer.from("png"), "preview");
  const sending = draft.send();
  await waiting.promise;
  draft.cancel(id);
  await sending;
  assert.equal(attempts, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].ocrStatus, "cancelled");
  assert.equal(sent[0].buffer.toString(), "png");
});

test("cancelar OCR en cola evita la petición y el texto parcial se conserva y se puede editar", async () => {
  const gate = deferred();
  let attempts = 0;
  let sent;
  const draft = new Draft({
    transcribe: async () => {
      attempts++;
      await gate.promise;
      throw Object.assign(new Error("Límite de longitud"), { partialText: "texto recuperado" });
    },
    sendMail: async (shots) => { sent = shots.map((shot) => ({ text: shot.transcript, state: shot.ocrStatus })); },
  });
  const first = draft.add(Buffer.from("uno"), "preview");
  const second = draft.add(Buffer.from("dos"), "preview");
  draft.cancel(second);
  gate.resolve();
  await draft.queue;
  assert.equal(attempts, 1);
  assert.equal(draft.shots[0].ocrStatus, "partial");
  assert.equal(draft.shots[0].transcript, "texto recuperado");
  draft.edit(first, "texto corregido");
  await draft.send();
  assert.deepEqual(sent, [{ text: "texto corregido", state: "partial" }, { text: "", state: "cancelled" }]);
});

test("el envío espera OCR, respeta el orden y bloquea mutaciones y envíos duplicados", async () => {
  const first = deferred();
  const smtp = deferred();
  const calls = [];
  let sent;
  const draft = new Draft({
    transcribe: async (buffer) => {
      calls.push(buffer.toString());
      if (buffer.toString() === "uno") await first.promise;
      return `texto ${buffer}`;
    },
    sendMail: async (shots, note) => {
      sent = { texts: shots.map((shot) => shot.transcript), note };
      await smtp.promise;
    },
  });
  const id = draft.add(Buffer.from("uno"), "preview1");
  draft.add(Buffer.from("dos"), "preview2");
  draft.setNote("Mi comentario");
  const sending = draft.send();
  await Promise.resolve();
  assert.deepEqual(calls, ["uno"]);
  assert.equal(sent, undefined);
  assert.throws(() => draft.remove(id), /envío/);
  assert.throws(() => draft.add(Buffer.from("tres"), "preview3"), /envío/);
  assert.throws(() => draft.setNote("cambio"), /envío/);
  await assert.rejects(draft.send(), /envío/);
  first.resolve();
  await draft.queue;
  assert.deepEqual(sent, { texts: ["texto uno", "texto dos"], note: "Mi comentario" });
  assert.equal(draft.shots.length, 2, "conserva el borrador hasta que SMTP acepte");
  smtp.resolve();
  await sending;
  assert.equal(draft.shots.length, 0);
  assert.equal(draft.note, "");
  assert.equal(draft.sending, false);
});

test("un error SMTP conserva texto corregido, comentario e imágenes sin repetir OCR", async () => {
  let ocrCalls = 0;
  let smtpCalls = 0;
  const draft = new Draft({
    transcribe: async () => { ocrCalls++; return "texto original"; },
    sendMail: async (shots, note) => {
      smtpCalls++;
      assert.equal(shots[0].transcript, "texto corregido");
      assert.equal(note, "nota");
      if (smtpCalls === 1) throw new Error("SMTP desconectado");
    },
  });
  const id = draft.add(Buffer.from("png"), "preview");
  await draft.queue;
  draft.edit(id, "texto corregido");
  draft.setNote("nota");
  await assert.rejects(draft.send(), /SMTP desconectado/);
  assert.equal(draft.shots.length, 1);
  assert.equal(draft.note, "nota");
  assert.equal(draft.sending, false);
  await draft.send();
  assert.equal(ocrCalls, 1);
  assert.equal(smtpCalls, 2);
});

test("eliminar una captura en procesamiento cancela su solicitud y descarta resultados tardíos", async () => {
  const gate = deferred();
  let signal;
  const calls = [];
  const draft = new Draft({
    transcribe: async (buffer, options) => {
      calls.push(buffer.toString());
      signal = options.signal;
      await gate.promise;
      return "resultado tardío";
    },
    sendMail: async () => {},
  });
  const first = draft.add(Buffer.from("uno"), "preview");
  const second = draft.add(Buffer.from("dos"), "preview");
  await Promise.resolve();
  draft.remove(first);
  assert.equal(signal.aborted, true);
  draft.remove(second);
  gate.resolve();
  await draft.queue;
  assert.equal(draft.shots.length, 0);
  assert.deepEqual(calls, ["uno"], "una captura eliminada de la cola no llega a Groq");
});

test("OCR fallido permite reintentar solo esa captura antes de enviar", async () => {
  let attempts = 0;
  let sent = 0;
  const draft = new Draft({
    transcribe: async () => {
      if (++attempts === 1) throw new Error("Groq HTTP 429");
      return "recuperado";
    },
    sendMail: async () => { sent++; },
  });
  const id = draft.add(Buffer.from("png"), "preview");
  await draft.queue;
  assert.equal(sent, 0);
  assert.equal(draft.shots[0].ocrStatus, "error");
  draft.retry(id);
  await draft.send();
  assert.equal(sent, 1);
  assert.equal(attempts, 2);
});

test("envía todas las imágenes y el comentario aunque fallen todas las transcripciones", async () => {
  let sent;
  const draft = new Draft({
    transcribe: async () => { throw new Error("Groq HTTP 429"); },
    sendMail: async (shots, note) => { sent = { shots: [...shots], note }; },
  });
  draft.add(Buffer.from("uno"), "preview1");
  draft.add(Buffer.from("dos"), "preview2");
  draft.setNote("Comentario sin OCR");
  await draft.send();
  assert.equal(sent.note, "Comentario sin OCR");
  assert.deepEqual(sent.shots.map((shot) => shot.buffer.toString()), ["uno", "dos"]);
  assert.ok(sent.shots.every((shot) => shot.transcript === ""));
  assert.equal(draft.shots.length, 0);
});

test("envío mixto conserva las transcripciones disponibles y las imágenes con OCR fallido", async () => {
  let sent;
  const draft = new Draft({
    transcribe: async (buffer) => {
      if (buffer.toString() === "dos") throw new Error("Groq HTTP 429");
      return "texto uno";
    },
    sendMail: async (shots) => { sent = shots.map((shot) => shot.transcript); },
  });
  draft.add(Buffer.from("uno"), "preview1");
  draft.add(Buffer.from("dos"), "preview2");
  await draft.send();
  assert.deepEqual(sent, ["texto uno", ""]);
});

test("el estado público omite buffers y el envío espera a que acabe la captura", async () => {
  const draft = new Draft({ transcribe: async () => "texto", sendMail: async () => {} });
  draft.add(Buffer.from("original"), "miniatura");
  await draft.queue;
  const shot = draft.snapshot().shots[0];
  assert.equal(shot.buffer, undefined);
  assert.equal(shot.bytes, 8);
  draft.capturing = true;
  await assert.rejects(draft.send(), /termine la captura/);
});
