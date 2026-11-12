const { test } = require("node:test");
const assert = require("node:assert/strict");
const nodemailer = require("nodemailer");
const { buildMessage, estimateMessageBytes, sendMail } = require("../mail");

test("el correo enlaza cada PNG con su pie, escapa HTML y ofrece texto plano", async () => {
  const text = '<script>alert("x")</script>\nA & B';
  const shots = [
    { id: "first", buffer: Buffer.from("synthetic-png-one"), transcript: text },
    { id: "second", buffer: Buffer.from("synthetic-png-two"), transcript: "segunda captura" },
  ];
  const message = buildMessage(shots, "<img src=x> nota", "me@example.com");
  assert.equal(message.to, message.from);
  assert.ok(message.text.includes(text));
  assert.ok(!message.html.includes("<script>"));
  assert.ok(message.html.includes("&lt;script&gt;"));
  assert.ok(message.html.includes("&lt;img src=x&gt; nota"));
  for (const attachment of message.attachments) {
    assert.ok(message.html.includes(`cid:${attachment.cid}`));
  }
  const smtp = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
  const result = await smtp.sendMail(message);
  const mime = result.message.toString();
  assert.match(mime, /multipart\/alternative/);
  assert.match(mime, /multipart\/related/);
  assert.match(mime, /Content-ID: <first@screen-mail>/);
  assert.match(mime, /Content-ID: <second@screen-mail>/);
  assert.match(mime, /Content-Disposition: inline/);
  assert.ok(estimateMessageBytes(message) >= result.message.length);
});

test("sin OCR el correo contiene imágenes y comentario, sin pies vacíos ni errores de Groq", () => {
  const shots = [{ id: "failed", buffer: Buffer.from("png"), transcript: "", ocrStatus: "error", error: "Groq HTTP 429" }];
  const message = buildMessage(shots, "Solo comentario", "me@example.com");
  assert.equal(message.text, "Solo comentario");
  assert.equal(message.attachments.length, 1);
  assert.ok(message.html.includes("cid:failed@screen-mail"));
  assert.ok(!message.html.includes("<pre"));
  assert.ok(!message.html.includes("Groq"));
  assert.equal(buildMessage(shots, "", "me@example.com").text, "");
});

test("el correo identifica el texto parcial para no presentarlo como una transcripción completa", () => {
  const message = buildMessage([{ id: "partial", buffer: Buffer.from("png"), transcript: "texto recuperado", ocrStatus: "partial" }], "", "me@example.com");
  assert.match(message.html, /Transcripción parcial/);
  assert.match(message.text, /Transcripción parcial\ntexto recuperado/);
});

test("Gmail acepta la clave agrupada con espacios sin cambiar contraseñas de otros proveedores", async (context) => {
  const keys = ["MAIL_USER", "MAIL_APP_PASSWORD", "SMTP_HOST", "SMTP_MAX_MB"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  context.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  process.env.MAIL_USER = "me@example.com";
  process.env.MAIL_APP_PASSWORD = "abcd efgh ijkl mnop";
  process.env.SMTP_HOST = "smtp.gmail.com";
  process.env.SMTP_MAX_MB = "20";
  let options;
  context.mock.method(nodemailer, "createTransport", (value) => {
    options = value;
    return { sendMail: async () => ({ accepted: ["me@example.com"] }) };
  });
  const shots = [{ id: "one", buffer: Buffer.from("png"), transcript: "" }];
  await sendMail(shots, "");
  assert.equal(options.auth.pass, "abcdefghijklmnop");
  process.env.SMTP_HOST = "smtp.example.com";
  await sendMail(shots, "");
  assert.equal(options.auth.pass, "abcd efgh ijkl mnop");
});
