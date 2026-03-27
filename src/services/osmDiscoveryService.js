const axios = require("axios");
const {
  overpassUrl,
  overpassUrls,
  overpassTimeoutMs,
} = require("../config");

/** Siempre AMBA (Gran Buenos Aires); el rubro solo cambia los tags OSM. */
const FIXED_LOCATION = "Buenos Aires, Argentina";
// Bounding box AMBA: south, west, north, east.
const BUENOS_AIRES_BBOX = "-34.92,-58.86,-34.23,-58.15";

/**
 * Rubros opcionales: si el cliente envía `category`, el primer patrón que coincida define el filtro OSM.
 * Sin `category` se usa MERGED_SECTOR (todo el sector inmobiliario / construcción / arquitectura).
 */
const RUBROS = [
  {
    slug: "inmobiliaria",
    label: "Inmobiliaria / real estate",
    patterns:
      /inmobiliaria|real[\s_-]*estate|realtor|realty|estate[\s_-]*agent|propiedad|propiedades|housing|agencia[\s_-]*inmobiliaria|corredor[\s_-]*inmobiliario|venta[\s_-]*de[\s_-]*propiedades|alquiler/i,
    filters: ['["office"="estate_agent"]', '["shop"="real_estate"]'],
  },
  {
    slug: "arquitectura",
    label: "Arquitectura",
    patterns: /arquitecto|arquitectura|architecture|architect|estudio[\s_-]*de[\s_-]*arquitectura/i,
    filters: ['["office"="architect"]'],
  },
  {
    slug: "constructora",
    label: "Constructora / construcción",
    patterns:
      /constructora?|construcci[oó]n|construction|builder|contractor|contratista|desarrolladora|edilici|obras|master[\s_-]*builder/i,
    filters: ['["craft"="builder"]', '["office"="construction"]'],
  },
];

/** Filtros OSM únicos para búsqueda amplia: inmobiliarias, martilleros/remates, arquitectos, constructoras, etc. */
const ALL_SECTOR_FILTERS = (() => {
  const set = new Set();
  for (const r of RUBROS) {
    for (const f of r.filters) set.add(f);
  }
  set.add('["shop"="auction"]');
  set.add('["office"="property_management"]');
  return [...set];
})();

const MERGED_SECTOR = {
  slug: "sector-construccion-inmobiliario",
  label: "Inmobiliaria, construcción, arquitectura y afines (AMBA)",
  filters: ALL_SECTOR_FILTERS,
};

class RubroNotFoundError extends Error {
  constructor(category, examples) {
    super(
      `Rubro no reconocido. Omití category para buscar todo el sector, o usa palabras como: ${examples.join(", ")}. Recibido: "${category}".`
    );
    this.name = "RubroNotFoundError";
    this.examples = examples;
  }
}

/** Emails en tags OSM (contact:email es el estándar; email a veces aparece suelto). */
function extractOsmEmails(tags = {}) {
  const raw = tags["contact:email"] || tags["email"];
  if (!raw || typeof raw !== "string") return [];
  const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
  const matches = raw.match(EMAIL_REGEX);
  return matches ? [...new Set(matches.map((e) => e.trim().toLowerCase()))] : [];
}

function resolveWebsite(tags) {
  return tags.website || tags["contact:website"] || tags.url || null;
}

function resolveBusinessName(tags) {
  return (
    tags.name ||
    tags["name:es"] ||
    tags.operator ||
    tags.brand ||
    null
  );
}

/**
 * @param {string} [category] - Texto libre; vacío = sector completo (MERGED_SECTOR).
 */
function resolveRubro(category) {
  const raw = String(category ?? "").trim();
  if (!raw) {
    return {
      slug: MERGED_SECTOR.slug,
      label: MERGED_SECTOR.label,
      filters: MERGED_SECTOR.filters,
    };
  }
  const value = raw.toLowerCase();
  for (const rubro of RUBROS) {
    if (rubro.patterns.test(value)) {
      return {
        slug: rubro.slug,
        label: rubro.label,
        filters: rubro.filters,
      };
    }
  }
  throw new RubroNotFoundError(raw, [
    MERGED_SECTOR.slug,
    ...RUBROS.map((r) => r.slug),
  ]);
}

function listRubros() {
  return [
    {
      slug: MERGED_SECTOR.slug,
      label: `${MERGED_SECTOR.label} (por defecto si no envías category)`,
    },
    ...RUBROS.map((r) => ({
      slug: r.slug,
      label: r.label,
    })),
  ];
}

/** Instancias globales (wiki OSM). Mail.ru suele responder 403 a servidores/bots. */
const DEFAULT_OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

/** Parte el bbox en franjas horizontales para consultas más livianas (menos 504). */
function splitBbox(bboxStr, parts = 3) {
  const [south, west, north, east] = bboxStr.split(",").map(Number);
  const span = north - south;
  const out = [];
  for (let i = 0; i < parts; i += 1) {
    const s = south + (span * i) / parts;
    const n = south + (span * (i + 1)) / parts;
    out.push(`${s},${west},${n},${east}`);
  }
  return out;
}

function asAddress(tags = {}) {
  const parts = [
    [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" ").trim(),
    tags["addr:city"] || tags["addr:town"] || tags["addr:village"],
    tags["addr:state"],
    tags["addr:country"],
  ].filter(Boolean);

  return parts.length ? parts.join(", ") : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableHttpStatus(status) {
  return [408, 429, 500, 502, 503, 504].includes(Number(status));
}

function isRetryableNetworkError(error) {
  if (error.response) return false;
  const code = error.code || "";
  return (
    code === "ECONNABORTED" ||
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "EAI_AGAIN" ||
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED" ||
    code === "EPIPE"
  );
}

async function fetchOverpassFromEndpoint(endpoint, overpassQuery) {
  const base = {
    timeout: overpassTimeoutMs,
    headers: {
      "User-Agent": "LeadsEnrichmentBot/1.0",
      Accept: "application/json",
    },
    maxRedirects: 5,
  };

  try {
    const response = await axios.get(endpoint, {
      ...base,
      params: { data: overpassQuery },
    });
    return response.data;
  } catch (getErr) {
    if (getErr.response?.status !== 414) {
      throw getErr;
    }
    const body = new URLSearchParams({ data: overpassQuery }).toString();
    const response = await axios.post(endpoint, body, {
      ...base,
      headers: {
        ...base.headers,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    return response.data;
  }
}

async function executeOverpassQuery(overpassQuery) {
  const candidateUrls = [...new Set([...overpassUrls, overpassUrl, ...DEFAULT_OVERPASS_URLS])];
  const errors = [];
  const maxAttempts = 2;

  for (const endpoint of candidateUrls) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await fetchOverpassFromEndpoint(endpoint, overpassQuery);
      } catch (error) {
        const status = error.response?.status;
        const detail =
          status != null
            ? String(status)
            : `NO_STATUS${error.code ? `(${error.code})` : ""}`;
        errors.push(`${endpoint} (attempt ${attempt}): ${detail}`);
        const retryHttp = status != null && isRetryableHttpStatus(status);
        const retryNet = status == null && isRetryableNetworkError(error);
        if (!retryHttp && !retryNet) {
          break;
        }
        await sleep(600 * attempt);
      }
    }
  }

  throw new Error(`Overpass no disponible. Detalle: ${errors.join(" | ")}`);
}

/** Sin filtro ["name"]: incluye POIs solo con email o web en OSM. */
function buildOverpassQueryForBbox(bbox, filters) {
  const queryParts = [];
  for (const filter of filters) {
    queryParts.push(`node${filter}(${bbox});`);
    queryParts.push(`way${filter}(${bbox});`);
    queryParts.push(`relation${filter}(${bbox});`);
  }

  return `
    [out:json][timeout:90];
    (
      ${queryParts.join("\n")}
    );
    out center tags;
  `;
}

function leadYieldScore(entry) {
  const hasOsm = entry.osmEmails?.length > 0;
  const hasWeb = Boolean(entry.website);
  return (hasOsm ? 4 : 0) + (hasWeb ? 2 : 0) + (entry.businessName ? 1 : 0);
}

async function discoverBusinesses({ category, maxResults = 10, offset = 0 }) {
  const rubro = resolveRubro(category);
  const { filters } = rubro;
  const bboxChunks = splitBbox(BUENOS_AIRES_BBOX, 3);
  const mergedElements = [];
  const seenIds = new Set();

  for (const bbox of bboxChunks) {
    const overpassQuery = buildOverpassQueryForBbox(bbox, filters);
    const data = await executeOverpassQuery(overpassQuery);
    for (const el of data?.elements || []) {
      const idKey = `${el.type}/${el.id}`;
      if (seenIds.has(idKey)) continue;
      seenIds.add(idKey);
      mergedElements.push(el);
    }
  }

  const elements = mergedElements;
  const normalized = [];

  for (const element of elements) {
    const tags = element.tags || {};
    const osmEmails = extractOsmEmails(tags);
    const website = resolveWebsite(tags);
    if (osmEmails.length === 0 && !website) {
      continue;
    }

    normalized.push({
      businessName: resolveBusinessName(tags),
      website,
      address: asAddress(tags),
      osmEmails,
      source: "openstreetmap-overpass",
    });
  }

  normalized.sort((a, b) => leadYieldScore(b) - leadYieldScore(a));

  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeMaxResults = Math.max(1, Number(maxResults) || 10);
  const paginatedBusinesses = normalized.slice(
    safeOffset,
    safeOffset + safeMaxResults
  );

  return {
    searchArea: FIXED_LOCATION,
    rubro: rubro.slug,
    rubroLabel: rubro.label,
    totalBusinesses: normalized.length,
    businesses: paginatedBusinesses,
  };
}

module.exports = {
  discoverBusinesses,
  resolveRubro,
  listRubros,
  RubroNotFoundError,
  FIXED_LOCATION,
  extractOsmEmails,
};
