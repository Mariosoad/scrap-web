const axios = require("axios");
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
} = require("../config");

function validateSmtpConfig() {
  if (!smtpHost || !smtpPort || !smtpUser || !smtpPass || !smtpFrom) {
    throw new Error(
      "SMTP no configurado. Define SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS y SMTP_FROM."
    );
  }
}

function formatResendError(err) {
  const body = err.response?.data;
  if (!body) return err.message || "Error al enviar con Resend.";
  if (typeof body.message === "string") return body.message;
  if (Array.isArray(body.message)) return body.message.join("; ");
  if (typeof body.error === "string") return body.error;
  try {
    return JSON.stringify(body);
  } catch {
    return err.message;
  }
}

async function sendViaResend({ to, subject, text, html }) {
  const fromTrimmed = String(resendFrom || "").trim();
  if (!fromTrimmed) {
    throw new Error(
      "Con RESEND_API_KEY define RESEND_FROM (o SMTP_FROM) con el remitente verificado en Resend."
    );
  }

  const payload = {
    from: fromTrimmed,
    to: [to],
    subject,
  };
  if (text) payload.text = text;
  if (html) payload.html = html;

  try {
    const { data } = await axios.post("https://api.resend.com/emails", payload, {
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    });
    return {
      messageId: data.id,
      accepted: [to],
      rejected: [],
    };
  } catch (err) {
    throw new Error(formatResendError(err));
  }
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
