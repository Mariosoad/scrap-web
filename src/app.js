const express = require("express");
const swaggerUi = require("swagger-ui-express");
const swaggerSpec = require("./swagger");
const { discoverBusinesses } = require("./services/osmDiscoveryService");
const { scrapeWebsiteContacts } = require("./services/websiteScraperService");
const { sendEmail } = require("./services/emailService");

const app = express();
app.use(express.json());
const FIXED_LOCATION = "Buenos Aires, Argentina";

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
