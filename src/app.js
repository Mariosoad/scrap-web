const express = require("express");
const swaggerUi = require("swagger-ui-express");
const swaggerSpec = require("./swagger");
const {
  discoverBusinesses,
  listRubros,
  RubroNotFoundError,
  FIXED_LOCATION,
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
const DEFAULT_MAX_RESULTS = 25;
const MAX_RESULTS_LIMIT = 200;
const DISCOVERY_MULTIPLIER = 5;
const MAX_DISCOVERY_LIMIT = 1000;

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

/** Prioriza un email de contacto frente a noreply/postmaster cuando hay varios en OSM o en la web. */
const GENERIC_EMAIL_LOCAL =
  /^(noreply|no-reply|donotreply|mailer-daemon|postmaster|bounce|newsletter)$/i;

function pickContactEmail(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const normalized = [
    ...new Set(candidates.map((e) => normalizeEmail(e)).filter(Boolean)),
  ];
  const preferred = normalized.find(
    (e) => !GENERIC_EMAIL_LOCAL.test(e.split("@")[0] || "")
  );
  return preferred || normalized[0];
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
 *                 description: "Opcional. Rubro por texto (inmobiliaria, arquitectura, constructora, muebleria, ferreteria, pintureria, vidrieria, cerrajeria, iluminacion, banos-cocinas, interiorismo, ingenieria-topografia, oficios-construccion). Si lo omitís, se usa el sector amplio (todas las categorías OSM mapeadas, bbox Argentina)."
 *                 example: "ferreteria"
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

      let primaryEmail = pickContactEmail(business.osmEmails);

      if (!primaryEmail && business.website) {
        const websiteContacts = await scrapeWebsiteContacts(business.website);
        primaryEmail = pickContactEmail(websiteContacts.emails);
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
 *     summary: Rubros reconocidos (area fija Argentina)
 *     tags: [Leads]
 *     responses:
 *       200:
 *         description: Lista de slugs y etiquetas
 */
app.get("/api/leads/rubros", (_, res) => {
  res.json({
    location: FIXED_LOCATION,
    areaNote:
      "Busqueda acotada a Argentina (bbox aproximado continental + sur), no es configurable por API. Puede tardar varios minutos en la primera pasada por la cantidad de consultas Overpass.",
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
 *     summary: Obtiene el primer cliente sin status (FIFO por id)
 *     tags: [Clients]
 *     description: Devuelve un solo registro con status NULL, el de menor id (primero en cola).
 *     responses:
 *       200:
 *         description: Cliente disponible o ninguno
 *       500:
 *         description: Error del servidor
 */
app.get("/api/clients/claim", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM clients WHERE `status` IS NULL ORDER BY id ASC LIMIT 1"
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

const CLIENT_STATUS_MAX_LENGTH = 45;

/**
 * @swagger
 * /api/clients/status:
 *   put:
 *     summary: Actualiza el status de un cliente por email
 *     tags: [Clients]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, status]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: "cliente@empresa.com"
 *               status:
 *                 type: string
 *                 maxLength: 45
 *                 description: Nuevo valor de status (VARCHAR 45 en BD)
 *                 example: "contactado"
 *     responses:
 *       200:
 *         description: Status actualizado
 *       400:
 *         description: Error de validacion
 *       404:
 *         description: Cliente no encontrado
 *       500:
 *         description: Error del servidor
 */
app.put("/api/clients/status", async (req, res) => {
  const body = req.body || {};
  const email = normalizeEmail(body.email);
  const rawStatus = body.status;

  if (!email) {
    return res.status(400).json({
      message: "El campo 'email' es obligatorio y debe ser un email valido.",
    });
  }

  if (rawStatus === undefined || rawStatus === null) {
    return res.status(400).json({
      message: "El campo 'status' es obligatorio.",
    });
  }

  if (typeof rawStatus !== "string") {
    return res.status(400).json({
      message: "El campo 'status' debe ser un string.",
    });
  }

  const status = rawStatus.trim();
  if (status.length > CLIENT_STATUS_MAX_LENGTH) {
    return res.status(400).json({
      message: `El campo 'status' admite como maximo ${CLIENT_STATUS_MAX_LENGTH} caracteres.`,
    });
  }

  try {
    const [result] = await pool.query(
      "UPDATE clients SET `status` = ? WHERE email = ?",
      [status, email]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        message: "No se encontro un cliente con ese email.",
      });
    }

    return res.json({
      email,
      status,
      updated: true,
    });
  } catch (error) {
    return res.status(500).json({
      message: "No se pudo actualizar el status del cliente.",
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
 *         description: Email enviado (status sent)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, enum: [sent] }
 *                 error: { type: string, nullable: true }
 *       400:
 *         description: Error de validacion (status failed)
 *       500:
 *         description: Fallo SMTP u otro error al enviar (status failed)
 */
app.post("/api/email/send", async (req, res) => {
  const body = req.body || {};
  const { to, subject, text, html } = body;

  const toEmail = String(to || "").trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!emailRegex.test(toEmail)) {
    return res.status(400).json({
      status: "failed",
      error: "El campo 'to' debe ser un email valido.",
    });
  }
  if (!subject || typeof subject !== "string") {
    return res.status(400).json({
      status: "failed",
      error: "El campo 'subject' es obligatorio y debe ser string.",
    });
  }
  if (!text && !html) {
    return res.status(400).json({
      status: "failed",
      error: "Debes enviar 'text' o 'html'.",
    });
  }

  try {
    await sendEmail({ to: toEmail, subject, text, html });
    return res.json({
      status: "sent",
      error: null,
    });
  } catch (error) {
    return res.status(500).json({
      status: "failed",
      error: error.message || "No se pudo enviar el email.",
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
