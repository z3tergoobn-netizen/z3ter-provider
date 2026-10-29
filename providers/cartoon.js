
"use strict";

// 🧸CaRtooN🧸 for Nuvio

const PROVIDER_NAME = "🧸CaRtooN🧸";
const SITE = "https://www.arabic-toons.com";
const TMDB_API_KEY = "09c002491851747716f94bd211a6681b";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function log(...args) {
  console.log("[CaRtooN]", ...args);
}

function clean(value) {
  return String(value ?? "").trim();
}

function absoluteUrl(value, base = SITE + "/") {
  const raw = clean(value)
    .replace(/&amp;/g, "&")
    .replace(/\\\//g, "/");

  if (!raw || /^(javascript:|data:|blob:)/i.test(raw)) {
    return "";
  }

  try {
    return new URL(raw, base).href;
  } catch (_) {
    return "";
  }
}

function normalizeTitle(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/[ًٌٍَُِّْٰـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function stripHtml(value) {
  return clean(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCharCode(Number(n))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCharCode(parseInt(n, 16))
    )
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value) {
  return clean(value)
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCharCode(Number(n))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCharCode(parseInt(n, 16))
    );
}

function titleScore(candidate, target) {
  const a = normalizeTitle(candidate);
  const b = normalizeTitle(target);

  if (!a || !b) return 0;
  if (a === b) return 100;

  if (a.startsWith(b) || b.startsWith(a)) {
    return 82;
  }

  const words = b.split(" ").filter(Boolean);
  const candidateWords = new Set(a.split(" "));
  const common = words.filter(word => candidateWords.has(word));

  return words.length
    ? (common.length / words.length) * 70
    : 0;
}

/*
 * Arabic-Toons episode URLs commonly look like:
 * /pinky-wa-brain-s1-1449531559-4503.html
 * /nmwsh-aljz-2-1692354802-39340.html
 *
 * The last two numeric groups are treated as timestamp and content ID.
 */

function extractSeason(value) {
  const text = normalizeTitle(value);

  const patterns = [
    /\bseason\s*([0-9]{1,2})\b/i,
    /\bs([0-9]{1,2})\b/i,
    /(?:الموسم|موسم|الجزء|جزء)\s*([0-9]{1,2})/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }

  return null;
}

function sitePageInfo(value) {
  const url = absoluteUrl(value);
  if (!url) return null;

  try {
    const parsed = new URL(url);

    if (!/(^|\.)arabic-toons\.com$/i.test(parsed.hostname)) {
      return null;
    }

    const path = decodeURIComponent(parsed.pathname);
    const match = path.match(/^\/(.+)-(\d+)-(\d+)\.html$/i);

    if (!match) return null;

    return {
      url: parsed.origin + parsed.pathname,
      slug: match[1],
      timestamp: match[2],
      id: match[3],
      season: extractSeason(match[1])
    };
  } catch (_) {
    return null;
  }
}

async function cached(key, loader, ttl = CACHE_TTL) {
  const existing = cache.get(key);

  if (existing && existing.expires > Date.now()) {
    return existing.promise;
  }

  const promise = Promise.resolve().then(loader);

  cache.set(key, {
    expires: Date.now() + ttl,
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

/* -------------------- HTTP -------------------- */

async function fetchResponse(url, options = {}) {
  const headers = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/json,*/*",
    "Accept-Language": "ar,en;q=0.9",
    ...(options.headers || {})
  };

  const response = await fetch(url, {
    ...options,
    headers,
    redirect: "follow"
  });

  if (!response || !response.ok) {
    throw new Error(
      "HTTP " + (response?.status || "network error") +
      " requesting " + url
    );
  }

  return response;
}

async function fetchText(url, options = {}) {
  const response = await fetchResponse(url, options);

  return {
    text: await response.text(),
    url: response.url || url,
    contentType: response.headers?.get?.("content-type") || ""
  };
}

async function fetchJson(url, options = {}) {
  const page = await fetchText(url, options);

  try {
    return JSON.parse(page.text);
  } catch (_) {
    throw new Error("Expected JSON from " + page.url);
  }
}

/* -------------------- TMDB titles -------------------- */

async function getTmdbTitles(tmdbId, mediaType) {
  const type = mediaType === "tv" ? "tv" : "movie";

  return cached(
    "tmdb:" + type + ":" + tmdbId,
    async () => {
      const titles = [];

      function addTitle(value) {
        const title = stripHtml(value);

        if (
          title &&
          !titles.some(
            item => normalizeTitle(item) === normalizeTitle(title)
          )
        ) {
          titles.push(title);
        }
      }

      for (const language of ["ar-SA", "en-US"]) {
        const url =
          "https://api.themoviedb.org/3/" +
          type + "/" + encodeURIComponent(String(tmdbId)) +
          "?api_key=" + encodeURIComponent(TMDB_API_KEY) +
          "&language=" + encodeURIComponent(language);

        try {
          const data = await fetchJson(url);

          addTitle(type === "tv" ? data.name : data.title);
          addTitle(
            type === "tv"
              ? data.original_name
              : data.original_title
          );
        } catch (error) {
          log("TMDB lookup failed:", error.message);
        }
      }

      if (!titles.length) {
        throw new Error("TMDB did not return a usable title");
      }

      return titles;
    },
    30 * 60 * 1000
  );
}

/* -------------------- Search parsing -------------------- */

function parseSearchItem(item, kind) {
  if (!item || typeof item !== "object") return null;

  const title = stripHtml(
    item.title ||
    item.name ||
    item.subtitle ||
    item.title_ar ||
    item.title_en
  );

  if (!title) return null;

  const suppliedUrl = absoluteUrl(
    item.href || item.url || item.link,
    SITE + "/"
  );

  const info = sitePageInfo(suppliedUrl);

  // Prefer the actual URL supplied by the site.
  // Do not fabricate a URL if the site's real URL is unavailable.
  if (info) {
    return {
      id: info.id,
      title,
      url: info.url,
      poster: absoluteUrl(item.image || item.poster || item.thumbnail),
      kind: kind || "tv",
      season: info.season
    };
  }

  // Retain compatibility with older search API results.
  const id = clean(item.id || item.anime_id || item.serie_id);
  if (!id || !suppliedUrl) return null;

  if (!/(?:anime|movies)-streaming\.html(?:[?#]|$)/i.test(suppliedUrl)) {
    return null;
  }

  return {
    id,
    title,
    url: suppliedUrl,
    poster: absoluteUrl(item.image || item.poster || item.thumbnail),
    kind: kind || (
      /movies-streaming\.html/i.test(suppliedUrl) ? "movie" : "tv"
    ),
    season: extractSeason(title)
  };
}

function getSearchItems(data) {
  const results = data?.results || data?.data || data || {};

  const series = Array.isArray(results.series) ? results.series : [];
  const movies = Array.isArray(results.movies) ? results.movies : [];
  const generic = Array.isArray(results) ? results : [];

  return [
    ...series.map(item => parseSearchItem(item, "tv")),
    ...movies.map(item => parseSearchItem(item, "movie")),
    ...generic.map(item => {
      const rawUrl = clean(item?.href || item?.url || item?.link);
      const kind = /movies-streaming\.html/i.test(rawUrl)
        ? "movie"
        : "tv";

      return parseSearchItem(item, kind);
    })
  ].filter(Boolean);
}

/*
 * HTML fallback for Arabic-Toons' real per-episode URLs.
 * The old parser accepted only anime-streaming.html and
 * movies-streaming.html, which could discard valid results.
 */

function parseSearchHtml(html, pageUrl) {
  const results = [];
  const seen = new Set();
  const anchorRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorRegex.exec(html)) !== null) {
    const attrs = match[1];
    const inner = match[2];

    const hrefMatch = attrs.match(
      /\bhref\s*=\s*["']([^"']+)["']/i
    );

    if (!hrefMatch) continue;

    const url = absoluteUrl(decodeHtml(hrefMatch[1]), pageUrl);
    const info = sitePageInfo(url);
    const title = stripHtml(inner);

    if (!info || !title || title.length < 2) continue;

    const key = info.url;

    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      id: info.id,
      title,
      url: info.url,
      poster: "",
      kind: /movies-streaming\.html/i.test(url) ? "movie" : "tv",
      season: info.season
    });
  }

  return results;
}

/* -------------------- Search -------------------- */

async function searchArabicToons(query) {
  const key = "search:" + normalizeTitle(query);

  return cached(key, async () => {
    const url =
      SITE + "/search_results.php?q=" +
      encodeURIComponent(query) + "&ajax=1";

    const page = await fetchText(url);
    let results = [];

    try {
      results = getSearchItems(JSON.parse(page.text));
    } catch (_) {
      results = parseSearchHtml(page.text, page.url);
    }

    const seen = new Set();

    const unique = results.filter(item => {
      const key = item.url.split("#")[0];

      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    log(
      "Search:", query,
      "| response:", page.contentType || "unknown",
      "| results:", unique.length
    );

    return unique;
  });
}

function chooseBestResult(results, titles, mediaType, requestedSeason) {
  let best = null;
  let bestScore = 0;

  const wantedSeason =
    requestedSeason == null ? null : Number(requestedSeason);

  for (const result of results) {
    if (mediaType === "movie" && result.kind !== "movie") continue;
    if (mediaType === "tv" && result.kind !== "tv") continue;

    const info = sitePageInfo(result.url);
    const foundSeason =
      result.season ??
      info?.season ??
      extractSeason(result.title);

    let seasonAdjustment = 0;

    if (
      mediaType === "tv" &&
      wantedSeason != null &&
      Number.isFinite(wantedSeason)
    ) {
      if (foundSeason != null && foundSeason !== wantedSeason) {
        seasonAdjustment = -100;
      } else if (foundSeason === wantedSeason) {
        seasonAdjustment = 18;
      }
    }

    for (const title of titles) {
      const rawScore = titleScore(result.title, title);
      const score = rawScore + seasonAdjustment;

      log(
        "Candidate:", result.title,
        "| season:", foundSeason ?? "unknown",
        "| title score:", rawScore,
        "| adjusted score:", score
      );

      if (score > bestScore) {
        best = { ...result, season: foundSeason };
        bestScore = score;
      }
    }
  }

  if (!best || bestScore < 45) return null;

  return { ...best, score: bestScore };
}

async function findBestResult(titles, mediaType, season) {
  const allResults = [];
  const seen = new Set();

  for (const title of titles.slice(0, 4)) {
    try {
      const results = await searchArabicToons(title);

      for (const item of results) {
        const key = item.url.split("#")[0];

        if (seen.has(key)) continue;
        seen.add(key);
        allResults.push(item);
      }
    } catch (error) {
      log("Search failed for", title, error.message);
    }
  }

  const match = chooseBestResult(
    allResults,
    titles,
    mediaType,
    season
  );

  log(
    "Total candidates:", allResults.length,
    "| selected:", match?.title || "none",
    "| score:", match?.score || 0
  );

  return match;
}

/* -------------------- Episode extraction -------------------- */

function extractEpisodeLinks(html, pageUrl) {
  const results = [];
  const seen = new Set();
  const anchorRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorRegex.exec(html)) !== null) {
    const attrs = match[1];
    const inner = match[2];

    const hrefMatch = attrs.match(
      /\bhref\s*=\s*["']([^"']+)["']/i
    );

    if (!hrefMatch) continue;

    const url = absoluteUrl(decodeHtml(hrefMatch[1]), pageUrl);
    const info = sitePageInfo(url);

    // Ignore navigation, external links, category pages and player URLs.
    if (!info) continue;

    const visible = stripHtml(inner);
    const combined = normalizeTitle(visible + " " + inner + " " + attrs);

    const numberMatch =
      inner.match(
        /class=["'][^"']*episode-number[^"']*["'][^>]*>\s*([0-9٠-٩۰-۹]+)\s*</i
      ) ||
      combined.match(
        /(?:episode|الحلقة|حلقة)\s*[-:#]?\s*([0-9٠-٩۰-۹]+)/i
      ) ||
      attrs.match(/(?:episode|ep)[-_ ]?([0-9٠-٩۰-۹]+)/i) ||
      visible.match(/^\s*([0-9٠-٩۰-۹]+)\s*$/);

    if (!numberMatch) continue;

    const number = Number(normalizeTitle(numberMatch[1]));

    if (!Number.isInteger(number) || number < 1) continue;
    if (seen.has(info.url)) continue;

    seen.add(info.url);

    results.push({
      number,
      url: info.url,
      title: visible || ("Episode " + number),
      season: info.season
    });
  }

  return results.sort((a, b) => a.number - b.number);
}

async function chooseEpisode(seriesUrl, season, episode) {
  const page = await fetchText(seriesUrl);
  const pageInfo = sitePageInfo(page.url) || sitePageInfo(seriesUrl);

  const titleMatch = page.text.match(
    /<title[^>]*>([\s\S]*?)<\/title>/i
  );

  const pageTitle = stripHtml(titleMatch?.[1] || "");
  const pageSeason =
    pageInfo?.season ??
    extractSeason(pageTitle);

  const wantedSeason =
    season == null ? null : Number(season);

  log(
    "Episode page:", page.url,
    "| title:", pageTitle,
    "| page season:", pageSeason ?? "unknown",
    "| requested season:", wantedSeason ?? "unknown"
  );

  if (
    wantedSeason != null &&
    pageSeason != null &&
    pageSeason !== wantedSeason
  ) {
    throw new Error(
      "Season mismatch: requested " + wantedSeason +
      ", page indicates " + pageSeason
    );
  }

  const episodes = extractEpisodeLinks(page.text, page.url);

  log("Episode links found:", episodes.length);

  // Do not silently return a season page as if it were a playable episode.
  if (!episodes.length) {
    throw new Error(
      "No episode links detected on the selected Arabic-Toons page"
    );
  }

  const wantedEpisode = Number(episode);

  if (!Number.isInteger(wantedEpisode) || wantedEpisode < 1) {
    throw new Error("Invalid or missing episode number");
  }

  const seasonScoped = wantedSeason == null
    ? episodes
    : episodes.filter(item =>
        item.season == null || item.season === wantedSeason
      );

  const matches = seasonScoped.filter(
    item => item.number === wantedEpisode
  );

  if (matches.length === 1) {
    log(
      "Selected episode:", matches[0].number,
      "| title:", matches[0].title,
      "| URL:", matches[0].url
    );

    return matches[0].url;
  }

  if (matches.length > 1) {
    throw new Error(
      "Ambiguous episode " + wantedEpisode +
      " in requested season " + (wantedSeason ?? "unknown")
    );
  }

  throw new Error(
    "Episode " + wantedEpisode +
    " not found for season " + (wantedSeason ?? "unknown")
  );
}

/* -------------------- Playback extraction -------------------- */

function extractVideoUrl(html, pageUrl) {
  const candidates = [];

  const patterns = [
    /<source\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi,
    /<video\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi,
    /\bvideoSrc\s*=\s*["']([^"']+)["']/gi
  ];

  for (const pattern of patterns) {
    let match;

    while ((match = pattern.exec(html)) !== null) {
      const url = absoluteUrl(decodeHtml(match[1]), pageUrl);

      if (
        url &&
        /^https?:\/\//i.test(url) &&
        /\.(?:m3u8|mp4)(?:$|[?#])/i.test(url)
      ) {
        candidates.push(url);
      }
    }
  }

  // Older Arabic-Toons player configuration.
  if (!candidates.length) {
    const configPattern =
      /(?:jC1kO|protocol)\s*:\s*["']([^"']+)["'][\s\S]*?(?:hF3nV|host)\s*:\s*["']([^"']+)["'][\s\S]*?(?:iA5pX|path)\s*:\s*["']([^"']+)["'][\s\S]*?(?:tN4qY|query)\s*:\s*["']([^"']*)["']/i;

    const match = configPattern.exec(html);

    if (match) {
      const protocol = match[1];
      const host = match[2];
      const path = match[3].replace(/^\/+/, "");
      const query = match[4];

      const url = absoluteUrl(
        protocol + "://" + host + "/" + path +
        (query ? "?" + query : ""),
        pageUrl
      );

      if (url) candidates.push(url);
    }
  }

  return (
    candidates.find(url => /\.m3u8(?:$|[?#])/i.test(url)) ||
    candidates.find(url => /\.mp4(?:$|[?#])/i.test(url)) ||
    ""
  );
}

async function extractStreams(pageUrl) {
  const page = await fetchText(pageUrl);

  log(
    "Stream extraction page:", page.url,
    "| content type:", page.contentType || "unknown",
    "| page length:", page.text.length
  );

  const videoUrl = extractVideoUrl(page.text, page.url);

  if (!videoUrl) {
    log(
      "No direct MP4/M3U8 URL found. The player may use an iframe, " +
      "JavaScript request, or another protected player format."
    );
    return [];
  }

  const format = /\.m3u8(?:$|[?#])/i.test(videoUrl)
    ? "HLS"
    : "MP4";

  log("Video URL extracted:", format);

  return [{
    name: PROVIDER_NAME,
    title: "🇸🇦 Arabic-Toons · " + format,
    url: videoUrl,
    quality: "auto",
    headers: {
      "Origin": SITE,
      "Referer": SITE + "/",
      "User-Agent": USER_AGENT
    }
  }];
}

/* -------------------- Nuvio entry point -------------------- */

async function getStreams(tmdbId, mediaType, season, episode) {
  let stage = "validation";

  try {
    if (!tmdbId || !["movie", "tv"].includes(mediaType)) {
      log("Unsupported request:", tmdbId, mediaType);
      return [];
    }

    stage = "TMDB title lookup";

    const titles = await getTmdbTitles(tmdbId, mediaType);
    log("Titles to search:", titles);

    stage = "Arabic-Toons search";

    const match = await findBestResult(titles, mediaType, season);

    if (!match) {
      log("No matching Arabic-Toons page found.");
      return [];
    }

    log(
      "Selected page:", match.title,
      "| score:", match.score,
      "| season:", match.season ?? "unknown",
      "| URL:", match.url
    );

    let playbackUrl = match.url;

    if (mediaType === "tv") {
      stage = "episode selection";

      if (episode == null) {
        log("TV request is missing the episode number.");
        return [];
      }

      playbackUrl = await chooseEpisode(
        match.url,
        season,
        episode
      );
    }

    stage = "stream extraction";

    const streams = await extractStreams(playbackUrl);

    log("Finished. Streams:", streams.length);

    return streams;
  } catch (error) {
    log(
      "Failed at stage:", stage,
      "|", error?.message || String(error)
    );

    return [];
  }
}

module.exports = {
  getStreams
};
