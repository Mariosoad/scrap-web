const express = require("express");
const swaggerUi = require("swagger-ui-express");
const swaggerSpec = require("./swagger");
const {
  discoverBusinesses,
  listRubros,
  RubroNotFoundError,
} = require("./services/osmDiscoveryService");
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
const DEFAULT_MAX_RESULTS = 25;
const MAX_RESULTS_LIMIT = 200;
const DISCOVERY_MULTIPLIER = 5;
const MAX_DISCOVERY_LIMIT = 1000;

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
    `SELECT email FROM clients WHERE email IN (${placeholders})`,
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
    "INSERT INTO clients (`name`, `email`, `address`, `web`) VALUES ?",
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
 *             properties:
 *               category:
 *                 type: string
 *                 description: "Opcional. Texto libre para un solo rubro (ej. inmobiliaria, arquitectura). Si lo omitís, se busca todo el sector inmobiliario/construcción/arquitectura en AMBA."
 *                 example: "inmobiliaria"
 *               maxResults:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 200
 *                 example: 25
 *               offset:
 *                 type: integer
 *                 minimum: 0
 *                 example: 0
 *           example:
 *             maxResults: 25
 *             offset: 0
 *     responses:
 *       200:
 *         description: Leads procesados
 *       400:
 *         description: Error de validacion
 */
app.post("/api/leads/scrape", async (req, res) => {
  const { category: rawCategory, maxResults = DEFAULT_MAX_RESULTS, offset = 0 } = req.body || {};
  const category =
    typeof rawCategory === "string" ? rawCategory.trim() : "";

  const safeMaxResults = Math.max(
    1,
    Math.min(Number(maxResults) || DEFAULT_MAX_RESULTS, MAX_RESULTS_LIMIT)
  );
  const safeOffset = Math.max(0, Number(offset) || 0);

  try {
    const discoveryLimit = Math.min(
      (safeOffset + safeMaxResults) * DISCOVERY_MULTIPLIER,
      MAX_DISCOVERY_LIMIT
    );
    const {
      businesses,
      searchArea,
      totalBusinesses,
      rubro,
      rubroLabel,
    } = await discoverBusinesses({
      category,
      maxResults: discoveryLimit,
      offset: 0,
    });
    const leads = [];
    let scanIndex = safeOffset;

    while (scanIndex < businesses.length && leads.length < safeMaxResults) {
      const business = businesses[scanIndex];
      scanIndex += 1;

      let primaryEmail =
        Array.isArray(business.osmEmails) && business.osmEmails.length > 0
          ? business.osmEmails[0]
          : null;

      if (!primaryEmail && business.website) {
        const websiteContacts = await scrapeWebsiteContacts(business.website);
        primaryEmail = websiteContacts.emails[0] || null;
      }

      if (!primaryEmail) {
        continue;
      }

      leads.push({
        businessName: business.businessName || null,
        email: primaryEmail,
        address: business.address || null,
        sourceWebsite: business.website || null,
      });
    }

    const saveSummary = await saveNewClients(leads);
    const nextOffset = scanIndex;
    const hasMore = nextOffset < totalBusinesses;
    const scannedBusinessesCount = Math.max(0, scanIndex - safeOffset);

    return res.json({
      category: category || null,
      rubro,
      rubroLabel,
      location: FIXED_LOCATION,
      searchArea,
      maxResults: safeMaxResults,
      offset: safeOffset,
      nextOffset,
      hasMore,
      totalBusinessesDiscovered: totalBusinesses,
      scannedBusinessesCount,
      count: leads.length,
      insertedCount: saveSummary.insertedCount,
      skippedCount: saveSummary.skippedCount,
      leads,
    });
  } catch (error) {
    if (error instanceof RubroNotFoundError) {
      return res.status(400).json({
        message: error.message,
        location: FIXED_LOCATION,
        rubrosDisponibles: listRubros(),
      });
    }
    return res.status(500).json({
      message: "No se pudieron procesar los leads.",
      detail: error.message,
    });
  }
});

/**
 * @swagger
 * /api/leads/rubros:
 *   get:
 *     summary: Rubros reconocidos (area fija Buenos Aires AMBA)
 *     tags: [Leads]
 *     responses:
 *       200:
 *         description: Lista de slugs y etiquetas
 */
app.get("/api/leads/rubros", (_, res) => {
  res.json({
    location: FIXED_LOCATION,
    areaNote: "Busqueda acotada al area metropolitana (bbox AMBA), no es configurable por API.",
    rubros: listRubros(),
  });
});

/**
 * @swagger
 * /api/clients:
 *   get:
 *     summary: Lista clientes paginados
 *     tags: [Clients]
 *     parameters:
 *       - in: query
 *         name: page
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Numero de pagina (50 registros por pagina)
 *     responses:
 *       200:
 *         description: Clientes paginados
 *       400:
 *         description: Error de validacion
 */
app.get("/api/clients", async (req, res) => {
  const rawPage = req.query.page;
  const page = Number.parseInt(rawPage, 10) || 1;
  const pageSize = 50;

  if (!Number.isInteger(page) || page < 1) {
    return res.status(400).json({
      message: "El parametro 'page' debe ser un entero mayor o igual a 1.",
    });
  }

  const offset = (page - 1) * pageSize;

  try {
    const [countRows] = await pool.query("SELECT COUNT(*) AS total FROM clients");
    const total = Number(countRows?.[0]?.total || 0);
    const totalPages = total > 0 ? Math.ceil(total / pageSize) : 0;

    const [clients] = await pool.query(
      "SELECT * FROM clients ORDER BY id DESC LIMIT ? OFFSET ?",
      [pageSize, offset]
    );

    return res.json({
      page,
      pageSize,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      data: clients,
    });
  } catch (error) {
    return res.status(500).json({
      message: "No se pudieron obtener los clients.",
      detail: error.message,
    });
  }
});

/**
 * @swagger
 * /api/clients/claim:
 *   get:
 *     summary: Obtiene un cliente sin status (el de mayor id)
 *     tags: [Clients]
 *     description: Devuelve un solo registro con status NULL, ordenado por id descendente.
 *     responses:
 *       200:
 *         description: Cliente disponible o ninguno
 *       500:
 *         description: Error del servidor
 */
app.get("/api/clients/claim", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM clients WHERE `status` IS NULL ORDER BY id DESC LIMIT 1"
    );
    const client = rows?.[0] ?? null;
    return res.json({ data: client });
  } catch (error) {
    return res.status(500).json({
      message: "No se pudo obtener el cliente.",
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
