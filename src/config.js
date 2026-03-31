const dotenv = require("dotenv");

dotenv.config();

module.exports = {
  port: process.env.PORT || 3000,
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 12000),
  /** Overpass puede tardar >60s en mirrors públicos; 504 suele ser saturación del servidor. */
  overpassTimeoutMs: Number(process.env.OVERPASS_TIMEOUT_MS || 90000),
  overpassUrl:
    process.env.OVERPASS_API_URL || "https://overpass-api.de/api/interpreter",
  overpassUrls: (process.env.OVERPASS_API_URLS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  smtpHost: process.env.SMTP_HOST || "",
  smtpPort: Number(process.env.SMTP_PORT || 465),
  smtpSecure: String(process.env.SMTP_SECURE || "true") === "true",
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  smtpFrom: process.env.SMTP_FROM || process.env.SMTP_USER || "",
  /** Si está definida, el envío usa la API HTTPS de Resend (recomendado en Railway Hobby/Free). */
  resendApiKey: process.env.RESEND_API_KEY || "",
  /** Remitente verificado en Resend; por defecto se reutiliza SMTP_FROM. */
  resendFrom: process.env.RESEND_FROM || process.env.SMTP_FROM || "",
  /** Reply-To en envíos Resend (cabecera reply_to en la API). Por defecto SMTP_FROM si es un email suelto. */
  resendReplyTo:
    process.env.RESEND_REPLY_TO || process.env.SMTP_FROM || "",
  mysqlUrl: process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL || "",
  mysqlHost: process.env.MYSQLHOST || "",
  mysqlPort: Number(process.env.MYSQLPORT || 3306),
  mysqlUser: process.env.MYSQLUSER || "",
  mysqlPassword: process.env.MYSQLPASSWORD || process.env.MYSQL_ROOT_PASSWORD || "",
  mysqlDatabase: process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE || "",
};
