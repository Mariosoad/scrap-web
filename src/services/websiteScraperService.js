const axios = require("axios");
const cheerio = require("cheerio");
const { requestTimeoutMs } = require("../config");

const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

function normalizeWebsiteUrl(rawUrl) {
  if (!rawUrl) return null;
  if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
    return rawUrl;
  }
  return `https://${rawUrl}`;
}

function cleanEmail(email) {
  return email.trim().toLowerCase();
}

function uniqueValues(list) {
  return [...new Set(list.filter(Boolean))];
}

function digitsOnlyPhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function mergePhoneCandidates(list) {
  const map = new Map();
  for (const item of list) {
    if (!item || item.digits == null) continue;
    const d = digitsOnlyPhone(item.digits);
    if (d.length < 8) continue;
    const w = Boolean(item.whatsapp);
    const prev = map.get(d);
    if (!prev || (w && !prev.whatsapp)) {
      map.set(d, { digits: d, whatsapp: w || Boolean(prev?.whatsapp) });
    }
  }
  return [...map.values()];
}

function extractTelFromHref(href) {
  const path = href.replace(/^tel:/i, "").split("?")[0];
  const decoded = decodeURIComponent(path);
  const digits = digitsOnlyPhone(decoded);
  if (digits.length < 8) return null;
  return { digits, whatsapp: false };
}

function extractWhatsAppFromHref(href) {
  const raw = String(href || "").trim();
  if (!raw) return null;
  try {
    if (/^whatsapp:/i.test(raw)) {
      const u = new URL(raw);
      const phone = u.searchParams.get("phone");
      const d = digitsOnlyPhone(phone || "");
      if (d.length >= 8) return { digits: d, whatsapp: true };
    }
    const u = new URL(raw, "https://example.com");
    const host = u.hostname.toLowerCase();
    if (host === "wa.me" || host === "www.wa.me") {
      const d = digitsOnlyPhone(u.pathname.replace(/\//g, ""));
      if (d.length >= 8) return { digits: d, whatsapp: true };
    }
    if (host.includes("whatsapp.com")) {
      const phone = u.searchParams.get("phone");
      const d = digitsOnlyPhone(phone || "");
      if (d.length >= 8) return { digits: d, whatsapp: true };
    }
  } catch (_) {
    // ignore
  }
  return null;
}

function extractPhoneLinksFromCheerio($) {
  const out = [];
  $('a[href^="tel:"]').each((_, el) => {
    const href = ($(el).attr("href") || "").trim();
    const parsed = extractTelFromHref(href);
    if (parsed) out.push(parsed);
  });
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") || "").trim();
    if (!href) return;
    const lower = href.toLowerCase();
    if (!lower.includes("wa.me") && !lower.includes("whatsapp.com") && !lower.startsWith("whatsapp:")) {
      return;
    }
    const parsed = extractWhatsAppFromHref(href);
    if (parsed) out.push(parsed);
  });
  return out;
}

function extractPhonesFromHtmlRaw(html) {
  const out = [];
  const waRe = /https?:\/\/(?:api\.|web\.)?whatsapp\.com\/[^\s"'<>]+/gi;
  const waMeRe = /https?:\/\/(?:www\.)?wa\.me\/[^\s"'<>]+/gi;
  let m;
  const haystack = String(html || "");
  while ((m = waRe.exec(haystack)) !== null) {
    const parsed = extractWhatsAppFromHref(m[0]);
    if (parsed) out.push(parsed);
  }
  while ((m = waMeRe.exec(haystack)) !== null) {
    const parsed = extractWhatsAppFromHref(m[0]);
    if (parsed) out.push(parsed);
  }
  return out;
}

function extractMailtoEmails($) {
  const out = [];
  $('a[href^="mailto:"]').each((_, el) => {
    const href = ($(el).attr("href") || "").trim();
    const path = href.replace(/^mailto:/i, "").split("?")[0];
    const decoded = decodeURIComponent(path);
    const match = decoded.match(EMAIL_REGEX);
    if (match) out.push(...match);
  });
  return uniqueValues(out.map(cleanEmail));
}

function inferContactPages(baseUrl, $) {
  const candidates = new Set([baseUrl]);
  const keywords = [
    "contact",
    "contacto",
    "about",
    "nosotros",
    "ubicacion",
    "ubicación",
    "escribinos",
    "escríbenos",
    "consultas",
    "ventas",
    "cotizacion",
    "cotización",
    "presupuesto",
    "comercial",
  ];

  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") || "").trim();
    const text = ($(el).text() || "").toLowerCase();
    const probe = `${href} ${text}`;

    if (keywords.some((k) => probe.includes(k))) {
      try {
        const nextUrl = new URL(href, baseUrl).toString();
        candidates.add(nextUrl);
      } catch (_) {
        // Ignore malformed links.
      }
    }
  });

  return [...candidates].slice(0, 8);
}

async function fetchHtml(url) {
  const response = await axios.get(url, {
    timeout: requestTimeoutMs,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; LeadsBot/1.0; +https://example.com/bot)",
    },
    maxRedirects: 5,
  });
  return String(response.data || "");
}

function extractFromHtml(html) {
  const emails = uniqueValues((html.match(EMAIL_REGEX) || []).map(cleanEmail));
  const phoneRaw = extractPhonesFromHtmlRaw(html);
  return { emails, phoneRaw };
}

async function scrapeWebsiteContacts(rawWebsiteUrl) {
  const website = normalizeWebsiteUrl(rawWebsiteUrl);
  if (!website) {
    return {
      emails: [],
      phoneCandidates: [],
      addressCandidates: [],
      visitedPages: [],
    };
  }

  try {
    const html = await fetchHtml(website);
    const $ = cheerio.load(html);
    const pages = inferContactPages(website, $);

    const allEmails = [...extractMailtoEmails($)];
    const allPhones = [
      ...extractPhoneLinksFromCheerio($),
      ...extractPhonesFromHtmlRaw(html),
    ];

    for (const pageUrl of pages) {
      try {
        const pageHtml = pageUrl === website ? html : await fetchHtml(pageUrl);
        const $page = cheerio.load(pageHtml);
        allEmails.push(...extractMailtoEmails($page));
        const { emails, phoneRaw } = extractFromHtml(pageHtml);
        allEmails.push(...emails);
        allPhones.push(...extractPhoneLinksFromCheerio($page), ...phoneRaw);
      } catch (_) {
        // Continue with other URLs if one fails.
      }
    }

    return {
      emails: uniqueValues(allEmails),
      phoneCandidates: mergePhoneCandidates(allPhones),
      addressCandidates: [],
      visitedPages: pages,
    };
  } catch (_) {
    return {
      emails: [],
      phoneCandidates: [],
      addressCandidates: [],
      visitedPages: [],
    };
  }
}

module.exports = {
  scrapeWebsiteContacts,
};
