const fs = require("fs");
const path = require("path");
const { Resend } = require("resend");
const nodemailer = require("nodemailer");
const {
  smtpHost,
  smtpPort,
  smtpSecure,
  smtpUser,
  smtpPass,
  smtpFrom,
  resendApiKey,
  resendFrom,
  resendReplyTo,
} = require("../config");

/** CID para imagen inline; debe coincidir con `src="cid:…"` en el HTML. */
const SIGNATURE_IMAGE_CID = "gemdam-pie-signature";
const GEMDAM_URL = "https://www.gemdam.com/";

function signatureImageAbsolutePath() {
  return path.join(__dirname, "..", "..", "media", "pie-gemdam.png");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Convierte cuerpo solo-texto a HTML seguro (saltos de línea → &lt;br&gt;). */
function textToSimpleHtml(text) {
  const escaped = escapeHtml(String(text).replace(/\s+$/u, ""));
  const withBreaks = escaped.replace(/\r?\n/g, "<br />\n");
  return `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;">${withBreaks}</div>`;
}

/**
 * Firma: solo la imagen clicable a GEMDAM (sin texto de firma). Si no hay PNG, un enlace mínimo.
 * Resend exige adjuntos en base64 cuando se manda `content`; SMTP usa el buffer tal cual.
 * Si el cliente envía solo `text`, generamos HTML para que la imagen CID se vea en Gmail, etc.
 */
function buildEmailWithSignature(text, html) {
  const imgPath = signatureImageAbsolutePath();
  const hasImage = fs.existsSync(imgPath);

  const signatureHtml = hasImage
    ? `<p style="margin:24px 0 0 0;line-height:0;font-size:0;"><a href="${GEMDAM_URL}" target="_blank" rel="noopener noreferrer"><img src="cid:${SIGNATURE_IMAGE_CID}" alt="GEMDAM" width="450" style="max-width:100%;height:auto;display:block;border:0;outline:none;text-decoration:none;" /></a></p>`
    : `<p style="margin:24px 0 0 0;"><a href="${GEMDAM_URL}" target="_blank" rel="noopener noreferrer">www.gemdam.com</a></p>`;

  const hasUserHtml = html != null && String(html).trim() !== "";
  const hasUserText = text != null && String(text).trim() !== "";

  let finalHtml;
  if (hasUserHtml) {
    finalHtml = `${String(html).replace(/\s+$/u, "")}\n${signatureHtml}`;
  } else if (hasUserText) {
    finalHtml = `${textToSimpleHtml(text)}\n${signatureHtml}`;
  } else {
    finalHtml = signatureHtml;
  }

  let finalText;
  if (hasUserText) {
    finalText = String(text).replace(/\s+$/u, "");
  }

  const attachments = [];
  if (finalHtml && hasImage) {
    attachments.push({
      filename: "pie-gemdam.png",
      buffer: fs.readFileSync(imgPath),
      contentType: "image/png",
    });
  }

  return { text: finalText, html: finalHtml, attachments };
}

function validateSmtpConfig() {
  if (!smtpHost || !smtpPort || !smtpUser || !smtpPass || !smtpFrom) {
    throw new Error(
      "SMTP no configurado. Define SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS y SMTP_FROM."
    );
  }
}

async function sendViaResend({ to, subject, text, html, attachments }) {
  const fromTrimmed = String(resendFrom || "").trim();
  if (!fromTrimmed) {
    throw new Error(
      "Con RESEND_API_KEY define RESEND_FROM (o SMTP_FROM) con el remitente verificado en Resend."
    );
  }

  const resend = new Resend(resendApiKey.trim());
  const payload = {
    from: fromTrimmed,
    to: [to],
    subject,
  };
  if (text) payload.text = text;
  if (html) payload.html = html;
  if (attachments?.length) {
    payload.attachments = attachments.map((a) => ({
      filename: a.filename,
      content: a.buffer.toString("base64"),
      contentType: a.contentType,
      contentId: SIGNATURE_IMAGE_CID,
    }));
  }

  const replyTrimmed = String(resendReplyTo || "").trim();
  if (replyTrimmed) {
    payload.replyTo = replyTrimmed;
  }

  const { data, error } = await resend.emails.send(payload);
  if (error) {
    throw new Error(error.message || "Error al enviar con Resend.");
  }
  return {
    messageId: data.id,
    accepted: [to],
    rejected: [],
  };
}

async function sendViaSmtp({ to, subject, text, html, attachments }) {
  validateSmtpConfig();

  const transport = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpSecure,
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  });

  const mail = {
    from: smtpFrom,
    to,
    subject,
    text: text || undefined,
    html: html || undefined,
  };
  if (attachments?.length) {
    mail.attachments = attachments.map((a) => ({
      filename: a.filename,
      content: a.buffer,
      contentType: a.contentType,
      cid: SIGNATURE_IMAGE_CID,
    }));
  }

  const info = await transport.sendMail(mail);

  return {
    messageId: info.messageId,
    accepted: info.accepted || [],
    rejected: info.rejected || [],
  };
}

async function sendEmail({ to, subject, text, html }) {
  const { text: t, html: h, attachments } = buildEmailWithSignature(text, html);
  if (resendApiKey) {
    return sendViaResend({ to, subject, text: t, html: h, attachments });
  }
  return sendViaSmtp({ to, subject, text: t, html: h, attachments });
}

module.exports = {
  sendEmail,
};
