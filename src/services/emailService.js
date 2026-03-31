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

function validateSmtpConfig() {
  if (!smtpHost || !smtpPort || !smtpUser || !smtpPass || !smtpFrom) {
    throw new Error(
      "SMTP no configurado. Define SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS y SMTP_FROM."
    );
  }
}

async function sendViaResend({ to, subject, text, html }) {
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

async function sendViaSmtp({ to, subject, text, html }) {
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

  const info = await transport.sendMail({
    from: smtpFrom,
    to,
    subject,
    text: text || undefined,
    html: html || undefined,
  });

  return {
    messageId: info.messageId,
    accepted: info.accepted || [],
    rejected: info.rejected || [],
  };
}

async function sendEmail({ to, subject, text, html }) {
  if (resendApiKey) {
    return sendViaResend({ to, subject, text, html });
  }
  return sendViaSmtp({ to, subject, text, html });
}

module.exports = {
  sendEmail,
};
