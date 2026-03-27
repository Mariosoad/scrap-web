const express = require("express");
const swaggerUi = require("swagger-ui-express");
const swaggerSpec = require("./swagger");
const { discoverBusinesses } = require("./services/osmDiscoveryService");
const { scrapeWebsiteContacts } = require("./services/websiteScraperService");
const { sendEmail } = require("./services/emailService");
const { pool } = require("./db");

const app = express();
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  return next();
});
app.use(express.json());
const FIXED_LOCATION = "Buenos Aires, Argentina";

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

async function saveNewClients(leads) {
  if (!Array.isArray(leads) || leads.length === 0) {
    return { insertedCount: 0, skippedCount: 0 };
  }

  const uniqueLeadsByEmail = new Map();
  for (const lead of leads) {
    const normalizedEmail = normalizeEmail(lead.email);
    if (!normalizedEmail) {
      continue;
    }

    if (!uniqueLeadsByEmail.has(normalizedEmail)) {
      uniqueLeadsByEmail.set(normalizedEmail, {
        ...lead,
        email: normalizedEmail,
      });
    }
  }

  const candidateLeads = Array.from(uniqueLeadsByEmail.values());
  if (candidateLeads.length === 0) {
    return { insertedCount: 0, skippedCount: 0 };
  }

  const candidateEmails = candidateLeads.map((lead) => lead.email);
  const placeholders = candidateEmails.map(() => "?").join(",");
  const [existingRows] = await pool.query(
    `SELECT email FROM client WHERE email IN (${placeholders})`,
    candidateEmails
  );

  const existingEmails = new Set(
    existingRows.map((row) => normalizeEmail(row.email))
  );
  const leadsToInsert = candidateLeads.filter(
    (lead) => !existingEmails.has(lead.email)
  );

  if (leadsToInsert.length === 0) {
    return { insertedCount: 0, skippedCount: candidateLeads.length };
  }

  const values = leadsToInsert.map((lead) => [
    lead.businessName || null,
    lead.email,
    lead.address || null,
    lead.sourceWebsite || null,
  ]);

  await pool.query(
    "INSERT INTO client (`name`, `email`, `address`, `web`) VALUES ?",
    [values]
  );

  return {
    insertedCount: leadsToInsert.length,
    skippedCount: candidateLeads.length - leadsToInsert.length,
  };
}

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health check
 *     tags: [System]
 *     responses:
 *       200:
 *         description: API activa
 */
app.get("/health", (_, res) => {
  res.json({ ok: true });
});

/**
 * @swagger
 * /api/leads/scrape:
 *   post:
 *     summary: Descubre empresas por OSM y extrae contactos del website
 *     tags: [Leads]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [category]
 *             properties:
 *               category:
 *                 type: string
 *                 example: "inmobiliaria"
 *               maxResults:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 20
 *                 example: 10
 *           example:
 *             category: "inmobiliaria"
 *             maxResults: 10
 *     responses:
 *       200:
 *         description: Leads procesados
 *       400:
 *         description: Error de validacion
 */
app.post("/api/leads/scrape", async (req, res) => {
  const { category, maxResults = 10 } = req.body || {};

  if (!category || typeof category !== "string") {
    return res.status(400).json({
      message: "El campo 'category' es obligatorio y debe ser string.",
    });
  }

  const safeMaxResults = Math.max(1, Math.min(Number(maxResults) || 10, 20));

  try {
    const discoveryLimit = Math.min(safeMaxResults * 5, 100);
    const { businesses, searchArea } = await discoverBusinesses({
      category,
      maxResults: discoveryLimit,
    });
    const leads = [];

    for (const business of businesses) {
      const websiteContacts = await scrapeWebsiteContacts(business.website);
      const primaryEmail = websiteContacts.emails[0] || null;
      if (!primaryEmail) {
        continue;
      }

      leads.push({
        businessName: business.businessName || null,
        email: primaryEmail,
        address: business.address || null,
        sourceWebsite: business.website || null,
      });

      if (leads.length >= safeMaxResults) {
        break;
      }
    }

    await saveNewClients(leads);

    return res.json({
      category,
      location: FIXED_LOCATION,
      searchArea,
      count: leads.length,
      leads,
    });
  } catch (error) {
    return res.status(500).json({
      message: "No se pudieron procesar los leads.",
      detail: error.message,
    });
  }
});

/**
 * @swagger
 * /api/email/send:
 *   post:
 *     summary: Envia un email por SMTP
 *     tags: [Email]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [to, subject]
 *             properties:
 *               to:
 *                 type: string
 *                 example: "cliente@empresa.com"
 *               subject:
 *                 type: string
 *                 example: "Propuesta comercial"
 *               text:
 *                 type: string
 *                 example: "Hola, te comparto nuestra propuesta."
 *               html:
 *                 type: string
 *                 example: "<p>Hola, te comparto nuestra propuesta.</p>"
 *           example:
 *             to: "cliente@empresa.com"
 *             subject: "Propuesta comercial"
 *             text: "Hola, te comparto nuestra propuesta."
 *     responses:
 *       200:
 *         description: Email enviado
 *       400:
 *         description: Error de validacion
 */
app.post("/api/email/send", async (req, res) => {
  const { to, subject, text, html } = req.body || {};
  const toEmail = String(to || "").trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!emailRegex.test(toEmail)) {
    return res.status(400).json({
      message: "El campo 'to' debe ser un email valido.",
    });
  }
  if (!subject || typeof subject !== "string") {
    return res.status(400).json({
      message: "El campo 'subject' es obligatorio y debe ser string.",
    });
  }
  if (!text && !html) {
    return res.status(400).json({
      message: "Debes enviar 'text' o 'html'.",
    });
  }

  try {
    const result = await sendEmail({ to: toEmail, subject, text, html });
    return res.json({
      message: "Email enviado correctamente.",
      ...result,
    });
  } catch (error) {
    return res.status(500).json({
      message: "No se pudo enviar el email.",
      detail: error.message,
    });
  }
});

app.get("/openapi.json", (_, res) => {
  res.set("Cache-Control", "no-store");
  res.json(swaggerSpec);
});

app.use(
  "/docs",
  (req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  },
  swaggerUi.serve,
  swaggerUi.setup(undefined, {
    swaggerOptions: {
      url: "/openapi.json",
    },
  })
);

module.exports = app;
