const dotenv = require("dotenv");

dotenv.config();

module.exports = {
  port: process.env.PORT || 3000,
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 12000),
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
};
