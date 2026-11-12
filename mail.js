const nodemailer = require("nodemailer");

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);

function buildMessage(shots, note, user) {
  return {
    from: user,
    to: user,
    subject: `${shots.length ? "Capturas" : "Mensaje"} · ${new Date().toLocaleString("es")}`,
    text: [note, ...shots.flatMap((shot, i) => shot.transcript ? [`Captura ${i + 1}${shot.ocrStatus === "partial" ? " · Transcripción parcial" : ""}\n${shot.transcript}`] : [])].filter(Boolean).join("\n\n"),
    html: `<div style="white-space:pre-wrap">${escapeHtml(note)}</div>` + shots.map((shot, i) => `
      <div style="margin:24px 0">
        <p style="font:12px sans-serif;color:#666">Captura ${i + 1}${shot.ocrStatus === "partial" ? " · Transcripción parcial" : ""}</p>
        <img src="cid:${shot.id}@screen-mail" alt="Captura ${i + 1}"
          style="display:block;max-width:100%;height:auto">
        ${shot.transcript ? `<pre style="white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 monospace">${escapeHtml(shot.transcript)}</pre>` : ""}
      </div>`).join(""),
    attachments: shots.map((shot, i) => ({
      filename: `captura-${i + 1}.png`,
      content: shot.buffer,
      contentType: "image/png",
      contentDisposition: "inline",
      cid: `${shot.id}@screen-mail`,
    })),
  };
}

function estimateMessageBytes(message) {
  const textBytes = Buffer.byteLength(message.html) + Buffer.byteLength(message.text);
  const attachmentBytes = message.attachments.reduce((total, item) => total + item.content.length, 0);
  // Base64, saltos de línea MIME y margen para cabeceras/quoted-printable.
  return Math.ceil(attachmentBytes * 1.38 + textBytes * 3 + message.attachments.length * 2048 + 8192);
}

async function sendMail(shots, note) {
  const user = process.env.MAIL_USER?.trim();
  const host = process.env.SMTP_HOST?.trim() || "smtp.gmail.com";
  // Gmail muestra las claves de aplicación agrupadas: los espacios son separadores.
  const pass = host.toLowerCase() === "smtp.gmail.com"
    ? process.env.MAIL_APP_PASSWORD?.replace(/\s/g, "")
    : process.env.MAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error("Configura MAIL_USER y MAIL_APP_PASSWORD en .env y reinicia la app.");
  const message = buildMessage(shots, note, user);
  const limit = Number(process.env.SMTP_MAX_MB || 20);
  if (!Number.isFinite(limit) || limit <= 0) throw new Error("SMTP_MAX_MB debe ser un número positivo.");
  if (estimateMessageBytes(message) > limit * 1024 * 1024) {
    throw new Error(`El correo supera el límite configurado de ${limit} MB. Quita alguna captura.`);
  }
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : port === 465;
  const smtp = nodemailer.createTransport({
    host,
    port,
    secure,
    requireTLS: !secure,
    auth: { user, pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });
  const result = await smtp.sendMail(message);
  if (!result.accepted?.length) throw new Error("El servidor SMTP no aceptó el destinatario.");
}

module.exports = { sendMail, buildMessage, estimateMessageBytes };
