const axios = require("axios");
const { googlePlacesApiKey, requestTimeoutMs } = require("../config");

const GOOGLE_PLACES_BASE_URL = "https://maps.googleapis.com/maps/api/place";

function ensureApiKey() {
  if (!googlePlacesApiKey) {
    throw new Error("Falta GOOGLE_PLACES_API_KEY en variables de entorno.");
  }
}

async function searchPlacesByText({ query, maxResults = 10 }) {
  ensureApiKey();

  const response = await axios.get(`${GOOGLE_PLACES_BASE_URL}/textsearch/json`, {
    params: {
      query,
      key: googlePlacesApiKey,
    },
    timeout: requestTimeoutMs,
  });

  const results = response.data?.results || [];
  return results.slice(0, maxResults).map((place) => ({
    placeId: place.place_id,
    businessName: place.name || null,
    address: place.formatted_address || null,
  }));
}

async function getPlaceDetails(placeId) {
  ensureApiKey();

  const response = await axios.get(`${GOOGLE_PLACES_BASE_URL}/details/json`, {
    params: {
      place_id: placeId,
      fields: "name,formatted_address,international_phone_number,website",
      key: googlePlacesApiKey,
    },
    timeout: requestTimeoutMs,
  });

  const result = response.data?.result || {};
  return {
    placeId,
    businessName: result.name || null,
    address: result.formatted_address || null,
    phone: result.international_phone_number || null,
    website: result.website || null,
  };
}

module.exports = {
  searchPlacesByText,
  getPlaceDetails,
};
