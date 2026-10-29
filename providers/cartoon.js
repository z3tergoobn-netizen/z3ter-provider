
"use strict";


// * 🧸CaRtooN🧸 for Nuvio


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
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/[\u064B-\u065F\u0670ـ]/g, "")
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
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCharCode(Number(n))
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
    .replace(/&gt;/gi, ">");
}

function slugify(value) {
  return normalizeTitle(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
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
    "Accept": "*/*",
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
      " while requesting " + url
    );
  }

  return response;
}

async function fetchText(url, options = {}) {
  const response = await fetchResponse(url, options);
  const text = await response.text();

  return {
    text,
    url: response.url || url,
    contentType: response.headers?.get?.("content-type") || ""
  };
}

async function fetchJson(url, options = {}) {
  const page = await fetchText(url, options);

  try {
    return JSON.parse(page.text);
  } catch (_) {
    throw new Error(
      "Expected JSON but received another response from " + page.url
    );
  }
}

/*
 * Do not pretend that a DoH lookup changes the resolver used by fetch().
 * A real proxy must be deployed separately and configured here before
 * it can be used safely.
 */

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
            existing =>
              normalizeTitle(existing) === normalizeTitle(title)
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

/* -------------------- Search -------------------- */

function parseSearchItem(item, kind) {
  if (!item || typeof item !== "object") return null;

  const id = clean(item.id || item.anime_id || item.serie_id);
  const title = stripHtml(
    item.title ||
    item.name ||
    item.subtitle ||
    item.title_ar ||
    item.title_en
  );

  if (!id || !title) return null;

  const suppliedUrl = absoluteUrl(
    item.href || item.url || item.link,
    SITE + "/"
  );

  const slug = slugify(item.subtitle || title);
  const suffix = kind === "movie"
    ? "movies-streaming.html"
    : "anime-streaming.html";

  const url = suppliedUrl ||
    (SITE + "/" + slug + "-" + encodeURIComponent(id) + "-" + suffix);

  const poster = absoluteUrl(
    item.image || item.poster || item.thumbnail
  );

  return {
    id,
    title,
    url,
    poster,
    kind
  };
}

function getSearchItems(data) {
  const results = data?.results || data?.data || data || {};

  const series = Array.isArray(results.series)
    ? results.series
    : [];

  const movies = Array.isArray(results.movies)
    ? results.movies
    : [];

  const generic = Array.isArray(results)
    ? results
    : [];

  return [
    ...series.map(item => parseSearchItem(item, "tv")),
    ...movies.map(item => parseSearchItem(item, "movie")),
    ...generic.map(item => {
      const rawUrl = clean(item?.href || item?.url || item?.link);
      const isMovie = /movies-streaming\.html/i.test(rawUrl);

      return parseSearchItem(item, isMovie ? "movie" : "tv");
    })
  ].filter(Boolean);
}

async function searchArabicToons(query) {
  const key = "search:" + normalizeTitle(query);

  return cached(key, async () => {
    const url =
      SITE + "/search_results.php?q=" +
      encodeURIComponent(query) + "&ajax=1";

    const data = await fetchJson(url);

    const results = getSearchItems(data);
    const seen = new Set();

    const unique = results.filter(item => {
      const key = item.url.split("#")[0];

      if (seen.has(key)) return false;
      seen.add(key);

      return true;
    });

    log("Search:", query, "| results:", unique.length);

    return unique;
  });
}

function chooseBestResult(results, titles, mediaType) {
  let best = null;
  let bestScore = 0;

  for (const result of results) {
    if (mediaType === "movie" && result.kind !== "movie") {
      continue;
    }

    if (mediaType === "tv" && result.kind !== "tv") {
      continue;
    }

    for (const title of titles) {
      const score = titleScore(result.title, title);

      if (score > bestScore) {
        best = result;
        bestScore = score;
      }
    }
  }

  if (!best || bestScore < 45) return null;

  return { ...best, score: bestScore };
}

async function findBestResult(titles, mediaType) {
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

  const match = chooseBestResult(allResults, titles, mediaType);

  log(
    "Total candidates:", allResults.length,
    "| selected:", match?.title || "none",
    "| score:", match?.score || 0
  );

  return match;
}

/* -------------------- Episodes -------------------- */

function extractEpisodeLinks(html, pageUrl) {
  const results = [];
  const seen = new Set();

  const anchorRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorRegex.exec(html)) !== null) {
    const attrs = match[1];
    const inner = match[2];

    const hrefMatch = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) continue;

    const href = decodeHtml(hrefMatch[1]).trim();

    if (!/\.html(?:[?#]|$)/i.test(href)) continue;

    const numberMatch =
      inner.match(/class=["'][^"']*episode-number[^"']*["'][^>]*>\s*(\d+)/i) ||
      inner.match(/(?:episode|الحلقة|حلقة)\s*[-:#]?\s*(\d+)/i) ||
      attrs.match(/(?:episode|ep)[-_ ]?(\d+)/i);

    if (!numberMatch) continue;

    const url = absoluteUrl(href, pageUrl);
    if (!url || seen.has(url.split("#")[0])) continue;

    seen.add(url.split("#")[0]);

    results.push({
      number: Number(numberMatch[1]),
      url,
      title: stripHtml(inner)
    });
  }

  // Fallback for the site's known #sets episode-link pattern.
  if (!results.length) {
    const fallback =
      /<a\b[^>]*href=["']([^"']+\.html#sets)["'][^>]*>[\s\S]*?class=["']episode-number["'][^>]*>\s*(\d+)\s*<\/div>/gi;

    while ((match = fallback.exec(html)) !== null) {
      const url = absoluteUrl(decodeHtml(match[1]), pageUrl);
      const number = Number(match[2]);

      if (url && !seen.has(url.split("#")[0])) {
        seen.add(url.split("#")[0]);
        results.push({ number, url, title: "Episode " + number });
      }
    }
  }

  return results.sort((a, b) => a.number - b.number);
}

async function chooseEpisode(seriesUrl, season, episode) {
  const page = await fetchText(seriesUrl);
  const episodes = extractEpisodeLinks(page.text, page.url);

  log("Episode links:", episodes.length);

  if (!episodes.length) {
    // Some pages themselves represent a single video.
    return seriesUrl;
  }

  const wantedEpisode = Number(episode);

  if (!Number.isFinite(wantedEpisode) || wantedEpisode < 1) {
    throw new Error("Invalid or missing episode number");
  }

  let matches = episodes.filter(item => item.number === wantedEpisode);

  if (matches.length === 1) return matches[0].url;

  if (matches.length > 1 && season != null) {
    const seasonPattern = new RegExp(
      "(?:season|الموسم|موسم)[\\s_-]*" +
      Number(season),
      "i"
    );

    const seasonMatches = matches.filter(item =>
      seasonPattern.test(normalizeTitle(item.title))
    );

    if (seasonMatches.length === 1) {
      return seasonMatches[0].url;
    }
  }

  if (matches.length > 1) {
    throw new Error(
      "More than one link matches episode " + wantedEpisode
    );
  }

  throw new Error(
    "Episode " + wantedEpisode + " was not found"
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

  // Older player configuration may encode the source components.
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

  return candidates.find(url =>
    /\.m3u8(?:$|[?#])/i.test(url)
  ) || candidates.find(url =>
    /\.mp4(?:$|[?#])/i.test(url)
  ) || "";
}

async function extractStreams(pageUrl) {
  const page = await fetchText(pageUrl);
  const videoUrl = extractVideoUrl(page.text, page.url);

  if (!videoUrl) {
    log("No direct video URL found on", page.url);
    return [];
  }

  const format = /\.m3u8(?:$|[?#])/i.test(videoUrl)
    ? "HLS"
    : "MP4";

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
    if (
      !tmdbId ||
      !["movie", "tv"].includes(mediaType)
    ) {
      log("Unsupported request:", tmdbId, mediaType);
      return [];
    }

    stage = "TMDB title lookup";

    const titles = await getTmdbTitles(tmdbId, mediaType);

    log("Titles to search:", titles);

    stage = "Arabic-Toons search";

    const match = await findBestResult(titles, mediaType);

    if (!match) {
      log("No matching cartoon found.");
      return [];
    }

    log(
      "Selected:", match.title,
      "| score:", match.score,
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
