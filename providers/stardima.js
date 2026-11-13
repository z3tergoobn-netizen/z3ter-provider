
"use strict";

/**
 *  AI
 */

const PROVIDER_NAME = "Stardima";
const START_URL = "https://www.stardima.com/";
const FALLBACK_URL = "https://watch.stardima.com/";
const TMDB_API_KEY = "09c002491851747716f94bd211a6681b";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

const CACHE_TTL = 5 * 60 * 1000;
const TMDB_CACHE_TTL = 30 * 60 * 1000;
const MAX_PLAYER_PAGES = 12;

let cachedDomain = null;
let domainExpiresAt = 0;

const cache = new Map();

/* =========================================================
   CACHE
========================================================= */

async function withCache(key, ttl, loader) {
  const now = Date.now();
  const cached = cache.get(key);

  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }

  const promise = Promise.resolve().then(loader);

  cache.set(key, {
    expiresAt: now + ttl,
    promise
  });

  try {
    return await promise;
  } catch (error) {
    if (cache.get(key)?.promise === promise) {
      cache.delete(key);
    }
    throw error;
  }
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const index = next++;

        if (index >= items.length) return;

        try {
          results[index] = await mapper(items[index], index);
        } catch (_) {
          results[index] = null;
        }
      }
    }
  );

  await Promise.all(workers);
  return results;
}

/* =========================================================
   TEXT UTILITIES
========================================================= */

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCharCode(Number(n))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCharCode(parseInt(n, 16))
    );
}

function stripTags(value) {
  return decodeHtml(
    String(value || "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]*>/g, " ")
  ).replace(/\s+/g, " ").trim();
}

function normalizeTitle(value) {
  return stripTags(value)
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670ـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values) {
  const result = [];
  const seen = new Set();

  for (const value of values) {
    if (!value) continue;

    const key = String(value).trim().toLowerCase();

    if (!key || seen.has(key)) continue;

    seen.add(key);
    result.push(value);
  }

  return result;
}

function getAttr(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const match = String(tag || "").match(
    new RegExp(
      "\\b" + escaped +
      "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))",
      "i"
    )
  );

  return match
    ? decodeHtml(match[1] || match[2] || match[3] || "")
    : "";
}

function absoluteUrl(value, base) {
  const url = decodeHtml(String(value || "").trim());

  if (
    !url ||
    /^(javascript:|data:|blob:|mailto:|tel:)/i.test(url)
  ) {
    return "";
  }

  try {
    return new URL(url, base).href;
  } catch (_) {
    return "";
  }
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch (_) {
    return "";
  }
}

/* =========================================================
   HTTP
========================================================= */

async function request(url, referer) {
  const headers = {
    "User-Agent": USER_AGENT,
    "Accept":
      "text/html,application/xhtml+xml,application/json,*/*",
    "Accept-Language": "ar,en;q=0.9"
  };

  if (referer) {
    headers.Referer = referer;
  }

  const response = await fetch(url, {
    method: "GET",
    headers,
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error("HTTP " + response.status + ": " + url);
  }

  return {
    html: await response.text(),
    url: response.url || url,
    contentType: response.headers.get("content-type") || ""
  };
}

/* =========================================================
   DOMAIN DISCOVERY
========================================================= */

function isAllowedDomain(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();

    return (
      host === "stardima.com" ||
      host.endsWith(".stardima.com") ||
      host === "stardima.com.im" ||
      host.endsWith(".stardima.com.im")
    );
  } catch (_) {
    return false;
  }
}

function getOrigin(url) {
  try {
    return new URL(url).origin;
  } catch (_) {
    return "";
  }
}

function discoverLinks(html, baseUrl) {
  const links = [];
  const expression = /<a\b[^>]*>/gi;
  let match;

  while ((match = expression.exec(html))) {
    const href = getAttr(match[0], "href");

    if (!href) continue;

    const url = absoluteUrl(href, baseUrl);

    if (url && isAllowedDomain(url)) {
      links.push(url);
    }
  }

  // اكتشاف النطاقات الموجودة في JavaScript أو HTML.
  const domainExpression =
    /https?:\/\/(?:[a-z0-9-]+\.)*stardima\.com(?:\.im)?/gi;

  while ((match = domainExpression.exec(html))) {
    if (isAllowedDomain(match[0])) {
      links.push(match[0]);
    }
  }

  return unique(links);
}

async function validateDomain(origin) {
  if (!isAllowedDomain(origin)) return false;

  const tests = [
    origin + "/watch/movies/",
    origin + "/watch/tvshows/",
    origin + "/"
  ];

  for (const url of tests) {
    try {
      const page = await request(url, START_URL);

      const text = page.html.toLowerCase();

      if (
        /stardima|ستارديما/i.test(text) ||
        /watch\/movies|watch\/tvshows/i.test(text)
      ) {
        return getOrigin(page.url || url);
      }
    } catch (_) {}
  }

  return false;
}

async function discoverDomain(force) {
  if (
    !force &&
    cachedDomain &&
    Date.now() < domainExpiresAt
  ) {
    return cachedDomain;
  }

  const candidates = [];

  // المصدر الأساسي.
  try {
    const home = await request(START_URL);

    const redirectedOrigin = getOrigin(home.url);

    if (redirectedOrigin && isAllowedDomain(redirectedOrigin)) {
      candidates.push(redirectedOrigin);
    }

    candidates.push(
      ...discoverLinks(home.html, home.url)
        .map(getOrigin)
    );
  } catch (error) {
    console.log(
      "[Stardima] Main domain discovery:",
      error.message || String(error)
    );
  }

  // النطاق الاحتياطي الحالي.
  candidates.push(getOrigin(FALLBACK_URL));

  const uniqueCandidates = unique(candidates);

  for (const candidate of uniqueCandidates) {
    if (!candidate || !isAllowedDomain(candidate)) continue;

    const valid = await validateDomain(candidate);

    if (valid) {
      cachedDomain = valid;
      domainExpiresAt = Date.now() + CACHE_TTL;

      console.log("[Stardima] Active domain:", cachedDomain);

      return cachedDomain;
    }
  }

  throw new Error("Unable to discover a valid Stardima domain");
}

function siteUrl(domain, path) {
  return domain.replace(/\/+$/, "") + "/" +
    String(path || "").replace(/^\/+/, "");
}

/* =========================================================
   TMDB
========================================================= */

async function tmdbJson(path, language) {
  const url =
    "https://api.themoviedb.org/3/" +
    path +
    "?api_key=" + encodeURIComponent(TMDB_API_KEY) +
    "&language=" + encodeURIComponent(language);

  return withCache(
    "tmdb:" + url,
    TMDB_CACHE_TTL,
    async () => {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT
        }
      });

      if (!response.ok) {
        throw new Error("TMDB HTTP " + response.status);
      }

      return response.json();
    }
  );
}

async function getMetadata(tmdbId, mediaType) {
  const type = mediaType === "tv" ? "tv" : "movie";
  const id = encodeURIComponent(String(tmdbId));

  const titles = [];
  let year = null;
  const seasonCounts = {};

  function addTitle(value) {
    const title = stripTags(value || "");

    if (
      title &&
      !titles.some(
        item =>
          normalizeTitle(item) === normalizeTitle(title)
      )
    ) {
      titles.push(title);
    }
  }

  for (const language of ["ar-SA", "en-US"]) {
    try {
      const data = await tmdbJson(
        type + "/" + id,
        language
      );

      addTitle(type === "tv" ? data.name : data.title);
      addTitle(
        type === "tv"
          ? data.original_name
          : data.original_title
      );

      if (!year) {
        year = Number(
          String(data.release_date || data.first_air_date || "")
            .slice(0, 4)
        ) || null;
      }

      if (type === "tv") {
        (data.seasons || []).forEach(season => {
          const number = Number(season.season_number);
          const count = Number(season.episode_count);

          if (number > 0 && count > 0) {
            seasonCounts[number] = count;
          }
        });
      }
    } catch (error) {
      console.log(
        "[Stardima] TMDB " + language + ":",
        error.message || String(error)
      );
    }
  }

  try {
    const alternatives = await tmdbJson(
      type + "/" + id + "/alternative_titles",
      "en-US"
    );

    const list =
      type === "tv"
        ? alternatives.results || []
        : alternatives.titles || [];

    list.forEach(item => addTitle(item.title || item.name));
  } catch (_) {}

  if (!titles.length) {
    throw new Error("No TMDB titles found");
  }

  return {
    titles: unique(titles),
    year,
    seasonCounts
  };
}

/* =========================================================
   HTML LINK PARSER
========================================================= */

function extractAnchors(html, baseUrl) {
  const anchors = [];
  const expression =
    /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;

  let match;

  while ((match = expression.exec(html))) {
    const attrs = match[1];
    const inner = match[2];

    const href = getAttr(attrs, "href");

    if (!href) continue;

    const url = absoluteUrl(href, baseUrl);

    if (!url) continue;

    const title =
      getAttr(attrs, "title") ||
      getAttr(attrs, "aria-label") ||
      stripTags(inner);

    anchors.push({
      url,
      title: stripTags(title),
      text: stripTags(inner)
    });
  }

  return anchors;
}

/* =========================================================
   SEARCH
========================================================= */

function isContentUrl(url, mediaType) {
  try {
    const path = new URL(url).pathname.toLowerCase();

    if (mediaType === "movie") {
      return /\/watch\/movies\/[^/]+/.test(path);
    }

    return (
      /\/watch\/tvshows\/[^/]+/.test(path) ||
      /\/watch\/seasons\/[^/]+/.test(path)
    );
  } catch (_) {
    return false;
  }
}

function titleScore(candidate, targets, year) {
  const normalized = normalizeTitle(candidate);

  if (!normalized) return 0;

  let best = 0;

  targets.forEach(target => {
    const expected = normalizeTitle(target);

    if (!expected) return;

    if (normalized === expected) {
      best = Math.max(best, 100);
      return;
    }

    if (
      normalized.includes(expected) ||
      expected.includes(normalized)
    ) {
      best = Math.max(best, 82);
      return;
    }

    const words = expected.split(" ").filter(Boolean);
    const found = new Set(normalized.split(" "));

    const hits = words.filter(word => found.has(word)).length;

    if (words.length) {
      best = Math.max(best, (hits / words.length) * 70);
    }
  });

  if (
    year &&
    best > 0 &&
    new RegExp("(^|\\D)" + year + "(\\D|$)").test(candidate)
  ) {
    best += 5;
  }

  return best;
}

async function searchSite(domain, query, mediaType) {
  const searchPaths = [
    "/?s=" + encodeURIComponent(query),
    "/watch/?s=" + encodeURIComponent(query),
    "/watch/movies/?s=" + encodeURIComponent(query),
    "/watch/tvshows/?s=" + encodeURIComponent(query)
  ];

  const found = [];
  const seen = new Set();

  for (const path of searchPaths) {
    try {
      const page = await request(
        siteUrl(domain, path),
        domain + "/"
      );

      const anchors = extractAnchors(page.html, page.url);

      for (const anchor of anchors) {
        if (!isContentUrl(anchor.url, mediaType)) continue;

        const key = anchor.url.split("#")[0];

        if (seen.has(key)) continue;
        seen.add(key);

        found.push({
          title: anchor.title || anchor.text,
          url: anchor.url
        });
      }

      if (found.length >= 5) break;
    } catch (_) {}
  }

  return found;
}

async function findBestMatch(domain, metadata, mediaType) {
  const groups = await mapLimit(
    metadata.titles.slice(0, 8),
    3,
    title => searchSite(domain, title, mediaType)
  );

  const candidates = [];
  const seen = new Set();

  groups.forEach(group => {
    (group || []).forEach(item => {
      if (seen.has(item.url)) return;

      seen.add(item.url);
      candidates.push(item);
    });
  });

  let best = null;
  let bestScore = 0;

  candidates.forEach(candidate => {
    const score = titleScore(
      candidate.title,
      metadata.titles,
      metadata.year
    );

    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  });

  if (!best || bestScore < 45) {
    console.log(
      "[Stardima] No matching content. Candidates:",
      candidates.length
    );

    return null;
  }

  console.log(
    "[Stardima] Match:",
    best.title,
    "| Score:",
    bestScore
  );

  return best;
}

/* =========================================================
   SEASONS AND EPISODES
========================================================= */

function getSeasonNumber(value) {
  const text = normalizeTitle(value);

  const patterns = [
    /(?:season|الموسم|موسم)\s*(\d+)/i,
    /s\s*(\d+)(?:\s|$)/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match) return Number(match[1]);
  }

  return null;
}

function getEpisodeNumber(value) {
  const text = normalizeTitle(value);

  const patterns = [
    /(?:episode|ep|الحلقة|حلقه)\s*(\d+)/i,
    /(?:الحلقه)\s*(\d+)/i,
    /^\s*(\d+)\s*$/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match) return Number(match[1]);
  }

  return null;
}

function findSeasonUrl(html, pageUrl, wantedSeason) {
  const anchors = extractAnchors(html, pageUrl);
  const matches = [];

  for (const anchor of anchors) {
    if (!/\/watch\/seasons\//i.test(anchor.url)) continue;

    const number = getSeasonNumber(
      anchor.title + " " + anchor.text + " " + anchor.url
    );

    if (number === Number(wantedSeason)) {
      matches.push(anchor.url);
    }
  }

  return unique(matches)[0] || "";
}

function findEpisodeUrl(html, pageUrl, wantedEpisode) {
  const anchors = extractAnchors(html, pageUrl);
  const matches = [];

  for (const anchor of anchors) {
    if (!/\/watch\/episodes\//i.test(anchor.url)) continue;

    const number = getEpisodeNumber(
      anchor.title + " " + anchor.text
    );

    if (number === Number(wantedEpisode)) {
      matches.push(anchor.url);
    }
  }

  return unique(matches)[0] || "";
}

async function selectEpisode(seriesUrl, season, episode) {
  const seriesPage = await request(seriesUrl);

  let seasonUrl = findSeasonUrl(
    seriesPage.html,
    seriesPage.url,
    season
  );

  if (!seasonUrl && Number(season) === 1) {
    seasonUrl = seriesUrl;
  }

  if (!seasonUrl) {
    throw new Error("Season " + season + " was not found");
  }

  let seasonPage;

  if (seasonUrl === seriesUrl) {
    seasonPage = seriesPage;
  } else {
    seasonPage = await request(seasonUrl, seriesUrl);
  }

  const episodeUrl = findEpisodeUrl(
    seasonPage.html,
    seasonPage.url,
    episode
  );

  if (episodeUrl) return episodeUrl;

  // بعض صفحات  تعرض الحلقات مباشرة داخل صفحة المسلسل.
  const fallbackUrl = findEpisodeUrl(
    seriesPage.html,
    seriesPage.url,
    episode
  );

  if (fallbackUrl) return fallbackUrl;

  throw new Error(
    "Episode " + episode + " in season " + season + " was not found"
  );
}

/* =========================================================
   PLAYER DISCOVERY
========================================================= */

function extractPlayerReferences(html, pageUrl) {
  const refs = [];
  const seen = new Set();

  function add(value, label) {
    const url = absoluteUrl(value, pageUrl);

    if (!url || seen.has(url)) return;

    if (!/^https?:\/\//i.test(url)) return;

    seen.add(url);

    refs.push({
      url,
      label: label || "Server"
    });
  }

  // Iframes.
  const iframeExpression = /<iframe\b[^>]*>/gi;
  let match;

  while ((match = iframeExpression.exec(html))) {
    const tag = match[0];

    add(
      getAttr(tag, "src") ||
      getAttr(tag, "data-src") ||
      getAttr(tag, "data-lazy-src"),
      "Player"
    );
  }

  // Lazy-loaded player containers.
  const elementExpression = /<(?:div|a|button)\b[^>]*>/gi;

  while ((match = elementExpression.exec(html))) {
    const tag = match[0];

    const className = getAttr(tag, "class");
    const id = getAttr(tag, "id");
    const label =
      getAttr(tag, "title") ||
      getAttr(tag, "aria-label") ||
      stripTags(tag);

    const playerLike =
      /player|server|watch|embed|video/i.test(
        className + " " + id
      );

    if (!playerLike) continue;

    const source =
      getAttr(tag, "data-src") ||
      getAttr(tag, "data-url") ||
      getAttr(tag, "data-embed") ||
      getAttr(tag, "data-link");

    if (source) {
      add(source, label || "Server");
    }
  }

  return refs.slice(0, MAX_PLAYER_PAGES);
}

function extractDirectMedia(html, pageUrl) {
  const results = [];
  const seen = new Set();

  function add(value, label) {
    const url = absoluteUrl(value, pageUrl);

    if (!url || seen.has(url)) return;

    if (!/\.(m3u8|mp4|mpd|webm)(?:[?#]|$)/i.test(url)) {
      return;
    }

    seen.add(url);

    let quality = "Auto";

    if (/2160/i.test(url)) quality = "2160p";
    else if (/1080/i.test(url)) quality = "1080p";
    else if (/720/i.test(url)) quality = "720p";
    else if (/480/i.test(url)) quality = "480p";

    results.push({
      url,
      quality,
      label: label || "Direct"
    });
  }

  const sourceExpression = /<(?:source|video)\b[^>]*>/gi;
  let match;

  while ((match = sourceExpression.exec(html))) {
    const tag = match[0];

    add(
      getAttr(tag, "src") ||
      getAttr(tag, "data-src"),
      "Direct"
    );
  }

  // روابط الفيديو الموجودة في الصفحة أو JavaScript.
  const urlExpression =
    /(?:https?:)?\/\/[^"'<>\\\s]+?\.(?:m3u8|mp4|mpd|webm)(?:\?[^"'<>\\\s]*)?/gi;

  while ((match = urlExpression.exec(html))) {
    add(match[0].replace(/&amp;/g, "&"), "Direct");
  }

  return results;
}

async function inspectPlayer(reference, parentUrl) {
  try {
    const page = await request(reference.url, parentUrl);

    const media = extractDirectMedia(
      page.html,
      page.url
    );

    return media.map(item => ({
      ...item,
      referer: page.url,
      server: reference.label
    }));
  } catch (error) {
    console.log(
      "[Stardima] Player failed:",
      reference.url,
      error.message || String(error)
    );

    return [];
  }
}

async function extractStreams(pageUrl) {
  console.log("[Stardima] Inspecting:", pageUrl);

  const page = await request(pageUrl);
  const html = page.html;

  const streams = [];

  // الروابط المباشرة الموجودة في صفحة العمل.
  const direct = extractDirectMedia(html, page.url);

  direct.forEach(item => {
    streams.push({
      ...item,
      referer: page.url,
      server: "Direct"
    });
  });

  // اكتشاف مشغلات الموقع.
  const players = extractPlayerReferences(
    html,
    page.url
  );

  console.log(
    "[Stardima] Player references:",
    players.length
  );

  const playerResults = await mapLimit(
    players,
    4,
    reference => inspectPlayer(reference, page.url)
  );

  playerResults.forEach(group => {
    (group || []).forEach(item => streams.push(item));
  });

  const seen = new Set();

  return streams
    .filter(item => {
      if (!item.url || seen.has(item.url)) return false;

      seen.add(item.url);
      return true;
    })
    .map(item => ({
      name: PROVIDER_NAME,
      title:
        item.server + " | " + item.quality,
      url: item.url,
      quality: item.quality,
      headers: {
        Referer: item.referer || page.url,
        "User-Agent": USER_AGENT
      }
    }));
}

/* =========================================================
   NUVIO ENTRY POINT
========================================================= */

async function getStreams(tmdbId, mediaType, season, episode) {
  let stage = "validation";

  try {
    if (!tmdbId) return [];

    if (mediaType !== "movie" && mediaType !== "tv") {
      return [];
    }

    if (
      mediaType === "tv" &&
      (!Number.isFinite(Number(season)) ||
       !Number.isFinite(Number(episode)))
    ) {
      console.log("[Stardima] Missing season or episode");
      return [];
    }

    console.log(
      "[Stardima] Request:",
      tmdbId,
      mediaType,
      season,
      episode
    );

    // 1. اكتشاف النطاق الحالي.
    stage = "domain discovery";

    let domain = await discoverDomain(false);

    // 2. جلب أسماء العمل من TMDB.
    stage = "TMDB metadata";

    const metadata = await getMetadata(
      tmdbId,
      mediaType
    );

    console.log(
      "[Stardima] Search titles:",
      metadata.titles
    );

    // 3. البحث عن العمل.
    stage = "content search";

    let match = await findBestMatch(
      domain,
      metadata,
      mediaType
    );

    // إذا فشل البحث، نعيد اكتشاف النطاق مرة واحدة.
    if (!match) {
      console.log("[Stardima] Retrying after domain refresh");

      domain = await discoverDomain(true);

      match = await findBestMatch(
        domain,
        metadata,
        mediaType
      );
    }

    if (!match) {
      console.log("[Stardima] Content not found");
      return [];
    }

    // 4. اختيار صفحة الفيلم أو الحلقة.
    stage = "episode selection";

    let playbackUrl = match.url;

    if (mediaType === "tv") {
      playbackUrl = await selectEpisode(
        match.url,
        Number(season),
        Number(episode)
      );
    }

    console.log(
      "[Stardima] Playback page:",
      playbackUrl
    );

    // 5. استخراج المصادر.
    stage = "stream extraction";

    const streams = await extractStreams(playbackUrl);

    console.log(
      "[Stardima] Streams found:",
      streams.length
    );

    return streams;

  } catch (error) {
    console.error(
      "[Stardima] Failed at:",
      stage,
      "|",
      error && error.message
        ? error.message
        : String(error)
    );

    return [];
  }
}

module.exports = {
  getStreams
};
