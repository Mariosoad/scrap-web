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
/** Tope de clientes por request (sin paginar con offset si no lo usás). */
const MAX_RESULTS_LIMIT = 2000;
const DISCOVERY_MULTIPLIER = 5;
/** Tope de POIs normalizados a acumular cuando scrapeWebsites intenta rellenar emails. */
const MAX_DISCOVERY_LIMIT = 15000;
/** Enrich-phones: cuántas webs scrapear por request (666 filas ⇒ varias llamadas). */
const ENRICH_PHONES_DEFAULT_LIMIT = 15;
const ENRICH_PHONES_MAX_LIMIT = 60;

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

function digitsOnlyPhone(value) {
  return String(value || "").replace(/\D/g, "");
}

/**
 * Un solo teléfono para guardar: si hay varios, prioriza el asociado a WhatsApp (enlace o tag OSM).
 */
function pickContactPhone(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const map = new Map();
  for (const c of candidates) {
    let digits;
    let whatsapp = false;
    if (c && typeof c === "object" && "digits" in c) {
      digits = digitsOnlyPhone(c.digits);
      whatsapp = Boolean(c.whatsapp);
    } else {
      digits = digitsOnlyPhone(c);
    }
    if (digits.length < 8) continue;
    const prev = map.get(digits);
    if (!prev || (whatsapp && !prev.whatsapp)) {
      map.set(digits, { digits, whatsapp: whatsapp || Boolean(prev?.whatsapp) });
    }
  }
  if (map.size === 0) return null;
  const list = [...map.values()];
  const preferred = list.find((x) => x.whatsapp);
  const chosen = preferred || list[0];
  return `+${chosen.digits}`;
}

async function saveNewClients(leads) {
  if (!Array.isArray(leads) || leads.length === 0) {
    return { insertedCount: 0, skippedCount: 0, skippedMissingEmail: 0 };
  }

  let skippedMissingEmail = 0;
  const uniqueLeadsByEmail = new Map();
  for (const lead of leads) {
    const normalizedEmail = normalizeEmail(lead.email);
    if (!normalizedEmail) {
      skippedMissingEmail += 1;
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
    return { insertedCount: 0, skippedCount: 0, skippedMissingEmail };
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
    return {
      insertedCount: 0,
      skippedCount: candidateLeads.length,
      skippedMissingEmail,
    };
  }

  const values = leadsToInsert.map((lead) => [
    lead.businessName || null,
    lead.email,
    lead.address || null,
    lead.sourceWebsite || null,
    lead.phone != null && String(lead.phone).trim() !== ""
      ? String(lead.phone).trim()
      : null,
  ]);

  await pool.query(
    "INSERT INTO clients (`name`, `email`, `address`, `web`, `phone`) VALUES ?",
    [values]
  );

  return {
    insertedCount: leadsToInsert.length,
    skippedCount: candidateLeads.length - leadsToInsert.length,
    skippedMissingEmail,
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
 *     summary: Descubre empresas por OSM (parada al alcanzar la pagina; email opcional salvo scrapeWebsites)
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
 *                 maximum: 2000
 *                 description: "Cantidad de leads a devolver (ej. 1500). Tambien se acepta maxResult como alias. Offset opcional; por defecto 0."
 *                 example: 1500
 *               offset:
 *                 type: integer
 *                 minimum: 0
 *                 example: 0
 *               scrapeWebsites:
 *                 type: boolean
 *                 default: false
 *                 description: "Si es true, intenta extraer email desde la web cuando no viene en OSM (mucho mas lento). Por defecto solo se usa OSM y el email puede ser null."
 *           example:
 *             maxResults: 25
 *             offset: 0
 *             scrapeWebsites: false
 *     responses:
 *       200:
 *         description: Leads procesados
 *       400:
 *         description: Error de validacion
 */
app.post("/api/leads/scrape", async (req, res) => {
  const body = req.body || {};
  const { category: rawCategory, offset = 0 } = body;
  const rawMax = body.maxResults ?? body.maxResult;
  const maxResults =
    rawMax !== undefined && rawMax !== null ? rawMax : DEFAULT_MAX_RESULTS;
  const scrapeWebsites = body.scrapeWebsites === true;
  const category =
    typeof rawCategory === "string" ? rawCategory.trim() : "";

  const safeMaxResults = Math.max(
    1,
    Math.min(Number(maxResults) || DEFAULT_MAX_RESULTS, MAX_RESULTS_LIMIT)
  );
  const safeOffset = Math.max(0, Number(offset) || 0);

  try {
    const needNormalized = safeOffset + safeMaxResults;
    const discoveryPoolLimit = scrapeWebsites
      ? Math.min(needNormalized * DISCOVERY_MULTIPLIER, MAX_DISCOVERY_LIMIT)
      : needNormalized;

    const {
      businesses,
      searchArea,
      totalBusinesses,
      rubro,
      rubroLabel,
      discoveryExhausted,
    } = await discoverBusinesses({
      category,
      maxResults: scrapeWebsites ? discoveryPoolLimit : safeMaxResults,
      offset: scrapeWebsites ? 0 : safeOffset,
      stopAfterNormalizedCount: discoveryPoolLimit,
    });

    const leads = [];
    let scanIndex = safeOffset;

    if (!scrapeWebsites) {
      for (const business of businesses) {
        const osmPhones = business.osmPhoneCandidates || [];
        leads.push({
          businessName: business.businessName || null,
          email: pickContactEmail(business.osmEmails) || null,
          address: business.address || null,
          sourceWebsite: business.website || null,
          phone: pickContactPhone(osmPhones),
        });
      }
      scanIndex = safeOffset + businesses.length;
    } else {
      while (scanIndex < businesses.length && leads.length < safeMaxResults) {
        const business = businesses[scanIndex];
        scanIndex += 1;

        let primaryEmail = pickContactEmail(business.osmEmails);
        const osmPhones = business.osmPhoneCandidates || [];
        let webPhones = [];

        if (business.website) {
          const websiteContacts = await scrapeWebsiteContacts(business.website);
          webPhones = websiteContacts.phoneCandidates || [];
          if (!primaryEmail) {
            primaryEmail = pickContactEmail(websiteContacts.emails);
          }
        }

        const phone = pickContactPhone([...osmPhones, ...webPhones]);

        leads.push({
          businessName: business.businessName || null,
          email: primaryEmail,
          address: business.address || null,
          sourceWebsite: business.website || null,
          phone,
        });
      }
    }

    const saveSummary = await saveNewClients(leads);
    const nextOffset = safeOffset + leads.length;
    const hasMore =
      nextOffset < totalBusinesses || !discoveryExhausted;
    const scannedBusinessesCount = Math.max(0, scanIndex - safeOffset);

    return res.json({
      category: category || null,
      rubro,
      rubroLabel,
      scrapeWebsites,
      location: FIXED_LOCATION,
      searchArea,
      maxResults: safeMaxResults,
      offset: safeOffset,
      nextOffset,
      hasMore,
      discoveryExhausted,
      totalBusinessesDiscovered: totalBusinesses,
      scannedBusinessesCount,
      count: leads.length,
      insertedCount: saveSummary.insertedCount,
      skippedCount: saveSummary.skippedCount,
      skippedMissingEmail: saveSummary.skippedMissingEmail,
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
 * /api/clients/enrich-phones:
 *   post:
 *     summary: Rellena phone en clientes existentes (scraping por web, una fila tras otra)
 *     tags: [Clients]
 *     description: |
 *       Busca filas con `web` no vacío y `phone` NULL o vacío, ordenadas por `id`.
 *       Por cada una llama al mismo scraper que usa `/api/leads/scrape` (tel / WhatsApp) y hace UPDATE solo del campo `phone`.
 *       No inserta filas ni modifica el flujo de leads. Usá `limit` acotado y repetí la llamada hasta `remainingWithoutPhone` sea 0.
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               limit:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 60
 *                 default: 15
 *                 description: Cantidad máxima de sitios a procesar en esta petición
 *     responses:
 *       200:
 *         description: Resultado del lote
 *       500:
 *         description: Error del servidor
 */
app.post("/api/clients/enrich-phones", async (req, res) => {
  const body = req.body || {};
  const rawLimit = body.limit;
  const limit = Math.min(
    ENRICH_PHONES_MAX_LIMIT,
    Math.max(1, Number(rawLimit) || ENRICH_PHONES_DEFAULT_LIMIT)
  );

  const phoneEmptySql = `(c.phone IS NULL OR TRIM(COALESCE(c.phone, '')) = '')`;
  const webPresentSql = `(c.web IS NOT NULL AND TRIM(COALESCE(c.web, '')) != '')`;

  try {
    const [rows] = await pool.query(
      `SELECT c.id, c.email, c.name, c.web FROM clients c
       WHERE ${phoneEmptySql} AND ${webPresentSql}
       ORDER BY c.id ASC
       LIMIT ?`,
      [limit]
    );

    let updated = 0;
    let noPhoneFound = 0;
    const errors = [];

    for (const row of rows) {
      try {
        const contacts = await scrapeWebsiteContacts(row.web);
        const phone = pickContactPhone(contacts.phoneCandidates || []);
        if (phone) {
          await pool.query("UPDATE clients SET phone = ? WHERE id = ?", [
            phone,
            row.id,
          ]);
          updated += 1;
        } else {
          noPhoneFound += 1;
        }
      } catch (err) {
        errors.push({
          id: row.id,
          email: row.email,
          message: err.message || String(err),
        });
      }
    }

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS remaining FROM clients c
       WHERE ${phoneEmptySql} AND ${webPresentSql}`
    );
    const remainingWithoutPhone = Number(countRows?.[0]?.remaining ?? 0);

    return res.json({
      limit,
      attempted: rows.length,
      updated,
      noPhoneFound,
      errors,
      remainingWithoutPhone,
      hasMore: remainingWithoutPhone > 0,
    });
  } catch (error) {
    return res.status(500).json({
      message: "No se pudo enriquecer telefonos.",
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
 *     summary: Envia un email (Resend por HTTPS si RESEND_API_KEY; si no, SMTP)
 *     description: |
 *       Contrato habitual del frontend: solo `to`, `subject` y `text`. El backend convierte `text` a HTML seguro,
 *       llama a Resend/SMTP con ese HTML y agrega la firma GEMDAM (imagen clicable). No hace falta enviar `html` desde el cliente.
 *       Opcional: `html` si algun dia queres cuerpo HTML propio; en ese caso se concatena la misma firma al final.
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
 *                 description: "Cuerpo del mensaje en texto plano (lo que envia el frontend). Obligatorio salvo que envies `html`."
 *                 example: "Hola, te comparto nuestra propuesta."
 *               html:
 *                 type: string
 *                 description: "Opcional. Si se envia, reemplaza la conversion desde `text` como cuerpo principal (la firma se agrega igual)."
 *                 example: "<p>Hola, te comparto nuestra <strong>propuesta</strong>.</p>"
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
 *         description: Fallo al enviar (Resend, SMTP u otro) (status failed)
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
