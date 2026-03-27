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

function inferContactPages(baseUrl, $) {
  const candidates = new Set([baseUrl]);
  const keywords = ["contact", "contacto", "about", "nosotros"];

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

  return [...candidates].slice(0, 5);
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
  return { emails };
}

async function scrapeWebsiteContacts(rawWebsiteUrl) {
  const website = normalizeWebsiteUrl(rawWebsiteUrl);
  if (!website) {
    return {
      emails: [],
      addressCandidates: [],
      visitedPages: [],
    };
  }

  try {
    const html = await fetchHtml(website);
    const $ = cheerio.load(html);
    const pages = inferContactPages(website, $);

    const allEmails = [];

    for (const pageUrl of pages) {
      try {
        const pageHtml = pageUrl === website ? html : await fetchHtml(pageUrl);
        const { emails } = extractFromHtml(pageHtml);
        allEmails.push(...emails);
      } catch (_) {
        // Continue with other URLs if one fails.
      }
    }

    return {
      emails: uniqueValues(allEmails),
      addressCandidates: [],
      visitedPages: pages,
    };
  } catch (_) {
    return {
      emails: [],
      addressCandidates: [],
      visitedPages: [],
    };
  }
}

module.exports = {
  scrapeWebsiteContacts,
};
