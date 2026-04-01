const axios = require("axios");
const {
  overpassUrl,
  overpassUrls,
  overpassTimeoutMs,
} = require("../config");

/** Ámbito de búsqueda OSM: Argentina (continental + Tierra del Fuego aprox.). */
const FIXED_LOCATION = "Argentina";
// Bounding box Argentina: south, west, north, east (recorte aproximado del país).
const ARGENTINA_BBOX = "-55.3,-73.65,-21.7,-53.55";


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
  {
    slug: "muebleria",
    label: "Mueblería / mobiliario y hogar",
    patterns:
      /muebler[ií]a|muebles|furniture|mobiliario|decoraci[oó]n[\s_-]*hogar|kitchen[\s_-]*studio|dise[nñ]o[\s_-]*de[\s_-]*cocinas/i,
    filters: [
      '["shop"="furniture"]',
      '["shop"="kitchen"]',
      '["shop"="flooring"]',
      '["shop"="curtain"]',
    ],
  },
  {
    slug: "ferreteria",
    label: "Ferretería / bricolaje / materiales",
    patterns:
      /ferreter[ií]a|bricolaje|herramientas|materiales[\s_-]*de[\s_-]*construcci[oó]n|corral[oó]n|sanitarios[\s_-]*y[\s_-]*ferreter/i,
    filters: [
      '["shop"="hardware"]',
      '["shop"="doityourself"]',
      '["shop"="builder_merchants"]',
    ],
  },
  {
    slug: "pintureria",
    label: "Pinturería / revestimientos",
    patterns: /pinturer[ií]a|pinturas|revestimiento|impermeabiliz/i,
    filters: ['["shop"="paint"]'],
  },
  {
    slug: "vidrieria",
    label: "Vidriería / cerramientos",
    patterns: /vidrier[ií]a|cristaler|cerramiento|ventanas[\s_-]*y[\s_-]*puertas/i,
    filters: [
      '["shop"="glaziery"]',
      '["craft"="window_construction"]',
    ],
  },
  {
    slug: "cerrajeria",
    label: "Cerrajería",
    patterns: /cerrajer[ií]a|cerrajero|llavero/i,
    filters: ['["shop"="locksmith"]'],
  },
  {
    slug: "iluminacion",
    label: "Iluminación",
    patterns: /iluminaci[oó]n|l[aá]mparas|lighting/i,
    filters: ['["shop"="lighting"]'],
  },
  {
    slug: "banos-cocinas",
    label: "Baños, cocinas y grifería",
    patterns: /grifer[ií]a|sanitarios|ba[nñ]o|bathroom|kitchen[\s_-]*fitting/i,
    filters: ['["shop"="bathroom_fittings"]'],
  },
  {
    slug: "interiorismo",
    label: "Interiorismo / diseño de interiores",
    patterns:
      /interiorismo|dise[nñ]o[\s_-]*de[\s_-]*interiores|interior[\s_-]*design|decoraci[oó]n[\s_-]*interior/i,
    filters: [
      '["shop"="interior_decoration"]',
      '["office"="interior_design"]',
      '["office"="interior_designer"]',
    ],
  },
  {
    slug: "ingenieria-topografia",
    label: "Ingeniería / agrimensura / mensuras",
    patterns:
      /ingenier[ií]a|ingeniero|estructur|civil|agrimensor|topograf|mensur|surveyor/i,
    filters: ['["office"="engineer"]', '["office"="surveyor"]'],
  },
  {
    slug: "oficios-construccion",
    label: "Oficios de obra (electricidad, plomería, carpintería, etc.)",
    patterns:
      /electricista|plomer[ií]a|fontaner[ií]a|carpinter[ií]a|ebanist|pintor[\s_-]*de|techista|marmol|yeso|alba[iñ]il|azulej|impermeabiliz|instalador/i,
    filters: [
      '["craft"="electrician"]',
      '["craft"="plumber"]',
      '["craft"="carpenter"]',
      '["craft"="joiner"]',
      '["craft"="painter"]',
      '["craft"="roofer"]',
      '["craft"="stonemason"]',
      '["craft"="tiler"]',
      '["craft"="glaziery"]',
      '["craft"="metal_construction"]',
      '["craft"="dry_plasterer"]',
    ],
  },
];

/** Filtros OSM únicos para búsqueda amplia (sector vivienda / construcción / obra). */
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
  label:
    "Inmobiliaria, construcción, arquitectura, mueblerías, ferreterías, oficios, materiales y afines (Argentina)",
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

function digitsOnlyPhone(value) {
  return String(value || "").replace(/\D/g, "");
}

/**
 * Candidatos de teléfono desde tags OSM; `whatsapp: true` si el tag indica WhatsApp explícito.
 */
function extractOsmPhoneCandidates(tags = {}) {
  const entries = [
    ["contact:whatsapp", true],
    ["whatsapp", true],
    ["contact:phone", false],
    ["contact:mobile", false],
    ["phone", false],
  ];
  const out = [];
  for (const [key, whatsapp] of entries) {
    const raw = tags[key];
    if (!raw || typeof raw !== "string") continue;
    for (const part of raw.split(/[;,|]/)) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      let digits = digitsOnlyPhone(trimmed);
      if (/^https?:\/\//i.test(trimmed) || trimmed.toLowerCase().includes("wa.me")) {
        try {
          const u = new URL(trimmed, "https://example.com");
          if (u.hostname.toLowerCase().includes("wa.me")) {
            digits = digitsOnlyPhone(u.pathname.replace(/\//g, ""));
          } else if (u.hostname.toLowerCase().includes("whatsapp.com")) {
            digits = digitsOnlyPhone(u.searchParams.get("phone") || "");
          }
        } catch (_) {
          // ignore
        }
      }
      if (digits.length >= 8) {
        out.push({ digits, whatsapp: whatsapp || /wa\.me|whatsapp/i.test(trimmed) });
      }
    }
  }
  return out;
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
      label: `${MERGED_SECTOR.label} — por defecto si no envías category (bbox Argentina)`,
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

/**
 * Parte el bbox en una grilla lat×lon para consultas Overpass más livianas (menos 504/timeouts).
 */
function splitBboxGrid(bboxStr, latParts, lonParts) {
  const [south, west, north, east] = bboxStr.split(",").map(Number);
  const latSpan = north - south;
  const lonSpan = east - west;
  const latN = Math.max(1, Math.floor(latParts));
  const lonN = Math.max(1, Math.floor(lonParts));
  const out = [];
  for (let i = 0; i < latN; i += 1) {
    const s = south + (latSpan * i) / latN;
    const n = south + (latSpan * (i + 1)) / latN;
    for (let j = 0; j < lonN; j += 1) {
      const w = west + (lonSpan * j) / lonN;
      const e = west + (lonSpan * (j + 1)) / lonN;
      out.push(`${s},${w},${n},${e}`);
    }
  }
  return out;
}

/** Más filtros OSM ⇒ celdas más chicas (más peticiones, menos peso por request). */
function gridDimensionsForFilterCount(filterCount) {
  const n = Math.max(1, Number(filterCount) || 0);
  if (n > 28) return { lat: 8, lon: 6 };
  if (n > 18) return { lat: 7, lon: 5 };
  if (n > 10) return { lat: 6, lon: 4 };
  if (n > 4) return { lat: 5, lon: 4 };
  return { lat: 4, lon: 3 };
}

/** Si OSM trae país explícito en el borde del bbox, descartamos vecinos obvios. */
function passesArgentinaCountryHint(tags = {}) {
  const raw = String(tags["addr:country"] || "").trim();
  if (!raw) return true;
  const lower = raw.toLowerCase();
  const ascii = lower.normalize("NFD").replace(/\p{M}/gu, "");
  if (/argent|argentina/.test(ascii) || /^(ar|arg)$/i.test(raw.trim())) {
    return true;
  }
  if (
    /\b(chile|brasil|brazil|uruguay|paraguay|bolivia)\b/i.test(ascii) ||
    /^(cl|uy|py|bo|br)$/i.test(raw.trim())
  ) {
    return false;
  }
  return true;
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

function normalizeOsmElement(element) {
  const tags = element.tags || {};
  if (!passesArgentinaCountryHint(tags)) {
    return null;
  }
  const osmEmails = extractOsmEmails(tags);
  const website = resolveWebsite(tags);
  if (osmEmails.length === 0 && !website) {
    return null;
  }
  return {
    businessName: resolveBusinessName(tags),
    website,
    address: asAddress(tags),
    osmEmails,
    osmPhoneCandidates: extractOsmPhoneCandidates(tags),
    source: "openstreetmap-overpass",
  };
}

/**
 * @param {object} opts
 * @param {string} [opts.category]
 * @param {number} [opts.maxResults] - tamaño de página devuelta
 * @param {number} [opts.offset] - offset de página
 * @param {number|null} [opts.stopAfterNormalizedCount] - si se indica, deja de consultar celdas Overpass al alcanzar esta cantidad de POIs normalizados (acelera la respuesta).
 */
async function discoverBusinesses({
  category,
  maxResults = 10,
  offset = 0,
  stopAfterNormalizedCount = null,
}) {
  const rubro = resolveRubro(category);
  const { filters } = rubro;
  const { lat, lon } = gridDimensionsForFilterCount(filters.length);
  const bboxChunks = splitBboxGrid(ARGENTINA_BBOX, lat, lon);
  const normalized = [];
  const seenIds = new Set();

  const stopAt =
    stopAfterNormalizedCount != null && Number.isFinite(Number(stopAfterNormalizedCount))
      ? Math.max(1, Math.floor(Number(stopAfterNormalizedCount)))
      : Infinity;

  let discoveryExhausted = true;

  for (const bbox of bboxChunks) {
    const overpassQuery = buildOverpassQueryForBbox(bbox, filters);
    const data = await executeOverpassQuery(overpassQuery);
    for (const el of data?.elements || []) {
      const idKey = `${el.type}/${el.id}`;
      if (seenIds.has(idKey)) continue;
      seenIds.add(idKey);
      const row = normalizeOsmElement(el);
      if (row) normalized.push(row);
    }

    normalized.sort((a, b) => leadYieldScore(b) - leadYieldScore(a));

    if (normalized.length >= stopAt) {
      discoveryExhausted = false;
      break;
    }
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
    discoveryExhausted,
  };
}

module.exports = {
  discoverBusinesses,
  resolveRubro,
  listRubros,
  RubroNotFoundError,
  FIXED_LOCATION,
  extractOsmEmails,
  extractOsmPhoneCandidates,
};
