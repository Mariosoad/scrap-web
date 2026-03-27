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
 * Rubros: el cliente envía `category` como texto libre; el primer patrón que coincida define el filtro OSM.
 * Orden importa (ej. "real estate" antes que reglas genéricas).
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

class RubroNotFoundError extends Error {
  constructor(category, examples) {
    super(
      `Rubro no reconocido. Usa palabras como: ${examples.join(", ")}. Recibido: "${category}".`
    );
    this.name = "RubroNotFoundError";
    this.examples = examples;
  }
}

function resolveRubro(category) {
  const raw = String(category || "").trim();
  if (!raw) {
    throw new Error("category es obligatorio.");
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
  throw new RubroNotFoundError(raw, RUBROS.map((r) => r.slug));
}

function listRubros() {
  return RUBROS.map((r) => ({
    slug: r.slug,
    label: r.label,
  }));
}

/** Instancias globales (wiki OSM). Mail.ru suele responder 403 a servidores/bots. */
const DEFAULT_OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

/** Parte el bbox en franjas horizontales para consultas más livianas (menos 504). */
function splitBbox(bboxStr, parts = 2) {
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

function buildOverpassQueryForBbox(bbox, filters) {
  const queryParts = [];
  for (const filter of filters) {
    queryParts.push(`node${filter}["name"](${bbox});`);
    queryParts.push(`way${filter}["name"](${bbox});`);
    queryParts.push(`relation${filter}["name"](${bbox});`);
  }

  return `
    [out:json][timeout:50];
    (
      ${queryParts.join("\n")}
    );
    out center tags;
  `;
}

async function discoverBusinesses({ category, maxResults = 10, offset = 0 }) {
  const rubro = resolveRubro(category);
  const { filters } = rubro;
  const bboxChunks = splitBbox(BUENOS_AIRES_BBOX, 2);
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
  const seen = new Set();
  const normalized = [];

  for (const element of elements) {
    const tags = element.tags || {};
    const businessName = tags.name || null;
    if (!businessName) continue;

    const website = tags.website || tags["contact:website"] || tags.url || null;
    const address = asAddress(tags);
    const key = `${businessName}|${address || ""}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    normalized.push({
      businessName,
      website,
      address,
      source: "openstreetmap-overpass",
    });
  }

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
};
