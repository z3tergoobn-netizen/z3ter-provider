
"use strict";

/**
 *  ©© This project is just a test made by AI
 */

const PROVIDER_NAME = "Z3ter Provider";
const ALOOY_HOME = "https://fitnur.com/alooytv";
const ALOOY_FALLBACK = "https://alooytv.com";
const ELCINEMA_SEARCH = "https://elcinema.com/search/work/";

const TMDB_API_KEY = "09c002491851747716f94bd211a6681b";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

let cachedDomain = null;

// Cache مؤقت داخل ذاكرة المزود.
const requestCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

async function withCache(key, ttlMs, loader) {
  const now = Date.now();
  const cached = requestCache.get(key);

  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }

  const promise = Promise.resolve().then(loader);
  requestCache.set(key, {
    expiresAt: now + ttlMs,
    promise
  });

  try {
    return await promise;
  } catch (error) {
    if (requestCache.get(key)?.promise === promise) {
      requestCache.delete(key);
    }
    throw error;
  }
}

// تشغيل عدد محدود من المهام بالتوازي.
async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const index = nextIndex++;

        if (index >= items.length) return;

        results[index] = await mapper(items[index], index);
      }
    }
  );

  await Promise.all(workers);
  return results;
}

/* -------------------- Text utilities -------------------- */

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

function getAttribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(tag || "").match(
    new RegExp(
      "\\b" + escaped +
      "\\s*=\\s*(?:" +
      '"([^"]*)"' +
      "|'([^']*)'" +
      "|([^\\s>]+))",
      "i"
    )
  );

  return match
    ? decodeHtml(match[1] || match[2] || match[3] || "")
    : "";
}

function absoluteUrl(url, base) {
  const value = decodeHtml(String(url || "").trim());

  if (!value || /^(data:|blob:|javascript:)/i.test(value)) {
    return "";
  }

  try {
    return new URL(value, base).href;
  } catch (_) {
    return "";
  }
}

function normalizeTitle(value) {
  return stripTags(value)
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670ـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/\b(?:مدبلج|مترجم|كامل|حصريا|الحلقه|الحلقة)\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/* -------------------- HTTP -------------------- */

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/json,*/*",
      "Accept-Language": "ar,en;q=0.9"
    },
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error("HTTP " + response.status + " for " + url);
  }

  return {
    text: await response.text(),
    url: response.url || url,
    contentType: response.headers.get("content-type") || ""
  };
}

/* -------------------- Simple HTML parser -------------------- */

function parseHtml(html) {
  const source = String(html || "");
  const nodes = [];
  const stack = [];

  const tokenPattern =
    /<!--[\s\S]*?-->|<![^>]*>|<\/?[a-zA-Z][^>]*>/g;

  const voidTags = new Set([
    "area", "base", "br", "col", "embed", "hr",
    "img", "input", "link", "meta", "param",
    "source", "track", "wbr"
  ]);

  let match;

  while ((match = tokenPattern.exec(source)) !== null) {
    const token = match[0];

    if (token.startsWith("<!--") || token.startsWith("<!")) {
      continue;
    }

    const closing = /^<\//.test(token);
    const tagMatch = token.match(/^<\/?([a-zA-Z][\w:-]*)/);

    if (!tagMatch) continue;

    const tag = tagMatch[1].toLowerCase();

    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          stack[i].end = tokenPattern.lastIndex;
          stack[i].inner = source.slice(stack[i].openEnd, match.index);
          stack.length = i;
          break;
        }
      }
      continue;
    }

    const node = {
      tag,
      attrs: token,
      start: match.index,
      openEnd: tokenPattern.lastIndex,
      end: null,
      inner: "",
      parent: stack.length ? stack[stack.length - 1] : null,
      children: []
    };

    if (node.parent) node.parent.children.push(node);
    nodes.push(node);

    if (!voidTags.has(tag) && !/\/\s*>$/.test(token)) {
      stack.push(node);
    } else {
      node.end = tokenPattern.lastIndex;
    }
  }

  for (const node of stack) {
    node.end = source.length;
    node.inner = source.slice(node.openEnd);
  }

  return nodes;
}

function hasClass(node, className) {
  return getAttribute(node.attrs, "class")
    .split(/\s+/)
    .includes(className);
}

function descendants(node, predicate) {
  const found = [];

  function visit(current) {
    for (const child of current.children || []) {
      if (predicate(child)) found.push(child);
      visit(child);
    }
  }

  visit(node);
  return found;
}

function nodeText(node) {
  return stripTags(node && node.inner || "");
}

function getNodeUrl(node, attribute, base) {
  return absoluteUrl(getAttribute(node.attrs, attribute), base);
}

/* -------------------- AlooyTV domain -------------------- */

async function getAlooyDomain() {
  if (cachedDomain) return cachedDomain;

  try {
    const page = await fetchText(ALOOY_HOME);
    const anchors = page.text.match(/<a\b[^>]*>/gi) || [];

    for (const anchor of anchors) {
      const href = getAttribute(anchor, "href");

      if (
        /alooytv/i.test(href) &&
        /\.com(?:[/:?#]|$)/i.test(href)
      ) {
        const url = absoluteUrl(href, page.url);
        const match = url.match(/^(https?:\/\/[^/]+)/i);

        if (match) {
          cachedDomain = match[1];
          console.log("[Z3ter] AlooyTV domain:", cachedDomain);
          return cachedDomain;
        }
      }
    }
  } catch (error) {
    console.error(
      "[Z3ter] Domain discovery failed:",
      error.message || String(error)
    );
  }

  cachedDomain = ALOOY_FALLBACK;
  console.log("[Z3ter] Using fallback domain:", cachedDomain);
  return cachedDomain;
}

/* -------------------- TMDB official API -------------------- */

async function tmdbJson(path, language) {
  const url =
    "https://api.themoviedb.org/3/" + path +
    "?api_key=" + encodeURIComponent(TMDB_API_KEY) +
    "&language=" + encodeURIComponent(language);

  return withCache("tmdb:" + url, 30 * 60 * 1000, async () => {
    const response = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": USER_AGENT
      },
      redirect: "follow"
    });

    if (!response.ok) {
      throw new Error(
        "TMDB API HTTP " + response.status + " for " + path
      );
    }

    return response.json();
  });
}

async function getTmdbTitles(tmdbId, mediaType) {
  const type = mediaType === "tv" ? "tv" : "movie";
  const id = encodeURIComponent(String(tmdbId));
  const titles = [];

  function addTitle(value) {
    const title = stripTags(value || "").trim();

    if (
      title &&
      !titles.some(
        existing =>
          normalizeTitle(existing) === normalizeTitle(title)
      )
    ) {
      titles.push(title);
    }
  }

  // العناوين العربية والإنجليزية والاسم الأصلي.
  for (const language of ["ar-SA", "en-US"]) {
    try {
      const data = await tmdbJson(type + "/" + id, language);

      addTitle(type === "tv" ? data.name : data.title);
      addTitle(type === "tv" ? data.original_name : data.original_title);

      console.log(
        "[Z3ter] TMDB " + language + ":",
        type === "tv" ? data.name : data.title
      );
    } catch (error) {
      console.error(
        "[Z3ter] TMDB lookup " + language + ":",
        error.message || String(error)
      );
    }
  }

  // أسماء بديلة من TMDB، إن توفرت.
  try {
    const data = await tmdbJson(
      type + "/" + id + "/alternative_titles",
      "en-US"
    );

    const alternatives =
      type === "tv" ? (data.results || []) : (data.titles || []);

    for (const item of alternatives) {
      addTitle(item.title || item.name);
    }
  } catch (error) {
    console.log(
      "[Z3ter] TMDB alternative titles unavailable:",
      error.message || String(error)
    );
  }

  if (!titles.length) {
    throw new Error(
      "TMDB returned no titles. Check the API key and TMDB ID."
    );
  }

  return titles;
}

/* -------------------- AlooyTV search -------------------- */

function isLikelyAlooyWorkUrl(url, baseUrl) {
  try {
    const parsed = new URL(url);
    const base = new URL(baseUrl);

    if (parsed.hostname !== base.hostname) return false;

    if (
      /\/search|\/category|\/genre|\/page\/|\/login|\/register|\/contact/i
        .test(parsed.pathname)
    ) {
      return false;
    }

    return /\/watch\//i.test(parsed.pathname) ||
      /\.html?$/i.test(parsed.pathname);
  } catch (_) {
    return false;
  }
}

function parseAlooyResults(html, baseUrl) {
  const nodes = parseHtml(html);
  const results = [];
  const seen = new Set();

  function add(anchor, titleOverride, urlOverride) {
    const title = stripTags(
      titleOverride || nodeText(anchor) ||
      getAttribute(anchor.attrs, "title")
    );

    const url = urlOverride ||
      getNodeUrl(anchor, "href", baseUrl);

    if (
      !title ||
      !url ||
      !isLikelyAlooyWorkUrl(url, baseUrl)
    ) {
      return;
    }

    const key = url.split("#")[0];

    if (seen.has(key)) return;
    seen.add(key);

    results.push({ title, url, poster: "" });
  }

  // أولًا: بنية بطاقات الموقع المعروفة.
  const containers = nodes.filter(
    node =>
      node.tag === "div" &&
      hasClass(node, "movie-container")
  );

  for (const container of containers) {
    for (const card of container.children || []) {
      if (card.tag !== "div") continue;

      const all = [card, ...descendants(card, () => true)];
      const titleBox = all.find(
        node =>
          node.tag === "div" &&
          hasClass(node, "movie-title")
      );

      const anchor = titleBox &&
        descendants(titleBox, node => node.tag === "a")[0];

      if (anchor) add(anchor);
    }
  }

  // احتياط: قوالب HTML مختلفة للنتائج العربية.
  if (!results.length) {
    for (const anchor of nodes.filter(node => node.tag === "a")) {
      const url = getNodeUrl(anchor, "href", baseUrl);
      const title = nodeText(anchor) ||
        getAttribute(anchor.attrs, "title");

      if (
        url &&
        title &&
        isLikelyAlooyWorkUrl(url, baseUrl)
      ) {
        add(anchor, title, url);
      }
    }
  }

  return results;
}

function scoreTitle(candidateTitle, targetTitle) {
  const candidate = normalizeTitle(candidateTitle);
  const target = normalizeTitle(targetTitle);

  if (!candidate || !target) return 0;
  if (candidate === target) return 100;

  if (
    candidate.startsWith(target) ||
    target.startsWith(candidate)
  ) {
    return 82;
  }

  const targetWords = target.split(" ").filter(Boolean);
  const candidateWords = new Set(
    candidate.split(" ").filter(Boolean)
  );

  const common = targetWords.filter(
    word => candidateWords.has(word)
  );

  return targetWords.length
    ? (common.length / targetWords.length) * 70
    : 0;
}

function chooseBestResult(results, targetTitles) {
  let best = null;
  let bestScore = 0;

  for (const result of results) {
    for (const target of targetTitles) {
      const score = scoreTitle(result.title, target);

      if (score > bestScore) {
        best = result;
        bestScore = score;
      }
    }
  }

  return bestScore >= 45
    ? { ...best, score: bestScore }
    : null;
}

async function searchAlooy(title, domain) {
  const key =
    "alooy-search:" + domain + ":" + normalizeTitle(title);

  return withCache(key, 5 * 60 * 1000, async () => {
    const page = await fetchText(
      domain + "/search?q=" + encodeURIComponent(title)
    );

    const results = parseAlooyResults(
      page.text,
      page.url || domain
    );

    console.log(
      "[Z3ter] Alooy results for",
      title + ":",
      results.length
    );

    return results;
  });
}

/* -------------------- elCinema optional aliases -------------------- */

// مصدر مساعد فقط. فشل البحث هنا لا يوقف المزود.
async function fetchElcinemaAliases(query) {
  try {
    const page = await fetchText(
      ELCINEMA_SEARCH + "?q=" + encodeURIComponent(query)
    );

    const nodes = parseHtml(page.text);
    const aliases = [];
    const seen = new Set();

    for (const anchor of nodes.filter(node => node.tag === "a")) {
      const url = getNodeUrl(
        anchor,
        "href",
        page.url || ELCINEMA_SEARCH
      );

      const title = nodeText(anchor) ||
        getAttribute(anchor.attrs, "title");

      if (!url || !title) continue;

      let parsed;

      try {
        parsed = new URL(url);
      } catch (_) {
        continue;
      }

      if (
        !/(^|\.)elcinema\.com$/i.test(parsed.hostname) ||
        !/\/work\/\d+\/?/i.test(parsed.pathname)
      ) {
        continue;
      }

      const normalized = normalizeTitle(title);

      if (!normalized || seen.has(normalized)) continue;

      seen.add(normalized);
      aliases.push(title);

      if (aliases.length >= 8) break;
    }

    console.log(
      "[Z3ter] elCinema aliases for",
      query + ":",
      aliases.length
    );

    return aliases;
  } catch (error) {
    console.log(
      "[Z3ter] elCinema unavailable:",
      error.message || String(error)
    );

    return [];
  }
}

async function getElcinemaAliases(query) {
  return withCache(
    "elcinema:" + normalizeTitle(query),
    30 * 60 * 1000,
    () => fetchElcinemaAliases(query)
  );
}

/* -------------------- Episode selection -------------------- */

function getEpisodeNumber(label) {
  const text = stripTags(label);

  const patterns = [
    /(?:episode|ep|الحلقة|حلقة|الحلقه)\s*[-:#]?\s*(\d+)/i,
    /^\s*(\d+)\s*$/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }

  return null;
}

async function getEpisodeUrl(seriesUrl, season, episode) {
  const page = await withCache(
    "episode-page:" + seriesUrl,
    CACHE_TTL_MS,
    () => fetchText(seriesUrl)
  );

  const nodes = parseHtml(page.text);

  const episodeLinks = nodes.filter(
    node =>
      node.tag === "a" &&
      (
        hasClass(node, "btn-ep") ||
        /episode|الحلقة|حلقة|الحلقه/i.test(nodeText(node))
      )
  );

  const candidates = episodeLinks
    .map(node => ({
      label: nodeText(node),
      url: getNodeUrl(node, "href", page.url || seriesUrl)
    }))
    .filter(
      item =>
        item.url &&
        getEpisodeNumber(item.label) !== null
    );

  console.log(
    "[Z3ter] Episode links found:",
    candidates.length
  );

  const wanted = Number(episode);

  const matches = candidates.filter(
    item => getEpisodeNumber(item.label) === wanted
  );

  if (matches.length === 1) return matches[0].url;

  if (matches.length > 1) {
    const wantedSeason = Number(season);

    const seasonMatches = matches.filter(item =>
      new RegExp(
        "(?:season|الموسم|موسم)\\s*" + wantedSeason,
        "i"
      ).test(normalizeTitle(item.label))
    );

    if (seasonMatches.length === 1) {
      return seasonMatches[0].url;
    }

    throw new Error("Multiple links match episode " + wanted);
  }

  if (candidates.length === 1) return candidates[0].url;

  if (!candidates.length) {
    console.log("[Z3ter] No episode links detected; trying series page.");
    return seriesUrl;
  }

  throw new Error("Requested episode " + wanted + " was not found");
}

/* -------------------- Stream extraction -------------------- */

async function extractStreams(pageUrl, domain) {
  const page = await fetchText(pageUrl);
  const nodes = parseHtml(page.text);
  const streams = [];

  const sources = nodes.filter(node => node.tag === "source");

  console.log("[Z3ter] Source elements found:", sources.length);

  for (const source of sources) {
    const parent = source.parent;

    const isVideoSource =
      (parent && parent.tag === "video") ||
      (parent && parent.parent && parent.parent.tag === "video");

    if (!isVideoSource) continue;

    const url = absoluteUrl(
      getAttribute(source.attrs, "src"),
      page.url || pageUrl
    );

    if (!url || !/^https?:\/\//i.test(url)) continue;

    const type = getAttribute(source.attrs, "type").toLowerCase();
    const lower = url.toLowerCase();

    let format = "";

    if (/\.m3u8(?:$|[?#])/.test(lower) || type.includes("mpegurl")) {
      format = "HLS";
    } else if (/\.mpd(?:$|[?#])/.test(lower) || type.includes("dash")) {
      format = "DASH";
    } else if (/\.mp4(?:$|[?#])/.test(lower) || type.includes("mp4")) {
      format = "MP4";
    }

    const quality = /1080/.test(lower)
      ? "1080p"
      : /720/.test(lower)
        ? "720p"
        : /480/.test(lower)
          ? "480p"
          : "auto";

    streams.push({
      name: PROVIDER_NAME + " - AlooyTV",
      title:
        "AlooyTV | " + quality +
        (format ? " | " + format : ""),
      url,
      quality,
      headers: {
        Referer: domain + "/",
        "User-Agent": USER_AGENT
      }
    });
  }

  const unique = streams.filter(
    (stream, index, all) =>
      all.findIndex(item => item.url === stream.url) === index
  );

  console.log("[Z3ter] Valid streams extracted:", unique.length);
  return unique;
}

/* -------------------- Nuvio entry point -------------------- */

async function getStreams(tmdbId, mediaType, season, episode) {
  let stage = "validation";

  try {
    if (!tmdbId || !["movie", "tv"].includes(mediaType)) {
      console.log("[Z3ter] Invalid input:", {
        tmdbId,
        mediaType,
        season,
        episode
      });

      return [];
    }

    stage = "domain discovery";
    const domain = await getAlooyDomain();

    console.log("[Z3ter] Active domain:", domain);

    stage = "TMDB API title lookup";
    const tmdbTitles = await getTmdbTitles(tmdbId, mediaType);
    const searchTitles = [...tmdbTitles];

    // جلب أسماء elCinema بالتوازي المحدود.
    const aliasGroups = await mapLimit(
      tmdbTitles,
      3,
      title => getElcinemaAliases(title)
    );

    for (const aliases of aliasGroups) {
      for (const alias of aliases) {
        if (
          !searchTitles.some(
            existing =>
              normalizeTitle(existing) === normalizeTitle(alias)
          )
        ) {
          searchTitles.push(alias);
        }
      }
    }

    console.log("[Z3ter] Titles to search:", searchTitles);

    stage = "AlooyTV search";

    const allResults = [];
    const seenUrls = new Set();

    // البحث عن العناوين بالتوازي بدلًا من انتظار كل عنوان منفردًا.
    const resultGroups = await mapLimit(
      searchTitles,
      4,
      async title => {
        try {
          return await searchAlooy(title, domain);
        } catch (error) {
          console.log(
            "[Z3ter] Search failed for",
            title + ":",
            error.message || String(error)
          );

          return [];
        }
      }
    );

    for (const results of resultGroups) {
      for (const result of results) {
        if (!seenUrls.has(result.url)) {
          seenUrls.add(result.url);
          allResults.push(result);
        }
      }
    }

    const match = chooseBestResult(allResults, searchTitles);

    if (!match) {
      console.log(
        "[Z3ter] No matching AlooyTV title. Candidates:",
        allResults.length
      );

      return [];
    }

    console.log(
      "[Z3ter] Selected title:",
      match.title,
      "| score:",
      match.score,
      "| URL:",
      match.url
    );

    let playbackPage = match.url;

if (mediaType === "tv") {
  stage = "episode selection";

  if (episode == null) {
    console.log("[Z3ter] TV request has no episode number.");
    return [];
  }

  playbackPage = await getEpisodeUrl(
    match.url,
    season,
    episode
  );

  console.log("[Z3ter] Selected episode page:", playbackPage);

} else if (mediaType === "movie") {
  stage = "movie playback selection";

  playbackPage = await getEpisodeUrl(
    match.url,
    1,
    1
  );

  console.log("[Z3ter] Selected movie playback page:", playbackPage);
}

    stage = "stream extraction";

    const streams = await extractStreams(playbackPage, domain);

    console.log("[Z3ter] Finished. Stream count:", streams.length);

    return streams;
  } catch (error) {
    console.error(
      "[Z3ter] Failed at stage:",
      stage,
      "| Error:",
      error && error.message ? error.message : String(error)
    );

    return [];
  }
}

module.exports = {
  getStreams
};
