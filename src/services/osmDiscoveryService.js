const axios = require("axios");
const { overpassUrl, overpassUrls, requestTimeoutMs } = require("../config");

const FIXED_LOCATION = "Buenos Aires, Argentina";
// Bounding box for AMBA area: south, west, north, east.
const BUENOS_AIRES_BBOX = "-34.92,-58.86,-34.23,-58.15";
const DEFAULT_OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

function buildCategoryTagFilters(category) {
  const value = String(category || "").toLowerCase().trim();

  if (/(inmobiliaria|real estate|estate|propiedad)/i.test(value)) {
    return ['["office"="estate_agent"]', '["shop"="real_estate"]'];
  }
  if (/(arquitect|architecture|arquitectura)/i.test(value)) {
    return ['["office"="architect"]'];
  }
  if (/(constructor|constructora|builder|construction|desarrolladora)/i.test(value)) {
    return ['["craft"="builder"]', '["office"="company"]'];
  }

  return ['["office"]', '["shop"]'];
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

async function executeOverpassQuery(overpassQuery) {
  const candidateUrls = [...new Set([...overpassUrls, overpassUrl, ...DEFAULT_OVERPASS_URLS])];
  const errors = [];

  for (const endpoint of candidateUrls) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await axios.get(endpoint, {
          params: { data: overpassQuery },
          timeout: requestTimeoutMs * 3,
          headers: {
            "User-Agent": "LeadsEnrichmentBot/1.0",
          },
        });
        return response.data;
      } catch (error) {
        const status = error.response?.status || "NO_STATUS";
        errors.push(`${endpoint} (attempt ${attempt}): ${status}`);
        if (![429, 502, 503, 504].includes(Number(status))) {
          break;
        }
        await sleep(400 * attempt);
      }
    }
  }

  throw new Error(`Overpass no disponible. Detalle: ${errors.join(" | ")}`);
}

async function discoverBusinesses({ category, maxResults = 10 }) {
  if (!category) {
    throw new Error("category es obligatorio.");
  }
  const bbox = BUENOS_AIRES_BBOX;
  const filters = buildCategoryTagFilters(category);

  const queryParts = [];
  for (const filter of filters) {
    queryParts.push(`node${filter}["name"](${bbox});`);
    queryParts.push(`way${filter}["name"](${bbox});`);
    queryParts.push(`relation${filter}["name"](${bbox});`);
  }

  const overpassQuery = `
    [out:json][timeout:25];
    (
      ${queryParts.join("\n")}
    );
    out center tags;
  `;

  const data = await executeOverpassQuery(overpassQuery);
  const elements = data?.elements || [];
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

  return {
    searchArea: FIXED_LOCATION,
    businesses: normalized.slice(0, maxResults),
  };
}

module.exports = {
  discoverBusinesses,
};
