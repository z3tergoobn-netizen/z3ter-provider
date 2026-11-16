
"use strict";

/*
 * AI
 */

const PROVIDER_NAME = "Stardima";

const TMDB_API_KEY = "09c002491851747716f94bd211a6681b";

const API_KEY =
  "vGIu8q9aap55zyANSD3jvmbttClhuRmykbQjzsIQxoWloFmp29W2qqdTSrwR";

const APP_UA = "jcartoonApp/1.0.8 (Android)";

const API_CANDIDATES = [
  "https://f5f-efgeg59852-zfz2d-mmltizwwcvb5567r2r63e-zd46.stardima.app",
  "https://app.stardima.com",
  "https://jcartoonapp.wiib.top"
];

const CACHE_TTL = 5 * 60 * 1000;
const TMDB_CACHE_TTL = 30 * 60 * 1000;
const MATCH_THRESHOLD = 45;

let activeApiBase = null;
let apiBaseExpiresAt = 0;

const cache = new Map();

/* =====================================================
   CACHE
===================================================== */

async function cached(key, ttl, loader) {
  const now = Date.now();
  const item = cache.get(key);

  if (item && item.expiresAt > now) {
    return item.promise;
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

/* =====================================================
   GENERAL UTILITIES
===================================================== */

function cleanText(value) {
  return String(value || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTitle(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670ـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    if (!value) continue;

    const key = String(value).trim().toLowerCase();

    if (!key || seen.has(key)) continue;

    seen.add(key);
    result.push(value);
  }

  return result;
}

function encodeQuery(params) {
  return Object.keys(params)
    .map(key =>
      encodeURIComponent(key) +
      "=" +
      encodeURIComponent(String(params[key]))
    )
    .join("&");
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function getArray(value) {
  return Array.isArray(value) ? value : [];
}

function getNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/* =====================================================
   HTTP
===================================================== */

function apiHeaders() {
  return {
    "User-Agent": APP_UA,
    "Accept": "application/json",
    "Accept-Language": "ar",
    "x-api-key": API_KEY,
    "x-app-version": "1.0.8",
    "x-app-name": "stardima",
    "x-device": "Xiaomi M2006C3MG",
    "x-platform": "Android 14",
    "X-Secure-Token": "HACKER_DETECTED_TAMPERED_APK",
    "X-Timestamp": String(Math.floor(Date.now() / 1000))
  };
}

async function request(url, headers) {
  const response = await fetch(url, {
    method: "GET",
    headers: headers || apiHeaders(),
    redirect: "follow"
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      "HTTP " + response.status + " at " + url
    );
  }

  return {
    text,
    json: safeJsonParse(text),
    url: response.url || url,
    contentType:
      response.headers.get("content-type") || ""
  };
}

async function getJson(url) {
  const response = await request(url);

  if (!response.json || typeof response.json !== "object") {
    throw new Error("Invalid JSON response");
  }

  return response.json;
}

/* =====================================================
   API HOST DISCOVERY
===================================================== */

function normalizeBase(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

async function discoverApiBase(force) {
  if (
    !force &&
    activeApiBase &&
    Date.now() < apiBaseExpiresAt
  ) {
    return activeApiBase;
  }

  for (const candidate of API_CANDIDATES) {
    try {
      const info = await getJson(
        candidate + "/api/app/info"
      );

      const data = info.data || {};

      const serverUrl = normalizeBase(data.server_url);

      const selected = serverUrl || candidate;

      if (!/^https:\/\//i.test(selected)) {
        continue;
      }

      activeApiBase = selected;
      apiBaseExpiresAt = Date.now() + CACHE_TTL;

      console.log(
        "[Stardima] API host:",
        activeApiBase
      );

      return activeApiBase;

    } catch (error) {
      console.log(
        "[Stardima] Host unavailable:",
        candidate,
        error.message || String(error)
      );
    }
  }

  throw new Error("Unable to discover Stardima API host");
}

/* =====================================================
   TMDB METADATA
===================================================== */

async function tmdbJson(path, language) {
  const url =
    "https://api.themoviedb.org/3/" +
    path +
    "?api_key=" +
    encodeURIComponent(TMDB_API_KEY) +
    "&language=" +
    encodeURIComponent(language);

  return cached(
    "tmdb:" + url,
    TMDB_CACHE_TTL,
    async () => {
      const response = await request(url, {
        "Accept": "application/json",
        "User-Agent": APP_UA
      });

      if (!response.json) {
        throw new Error("TMDB returned invalid JSON");
      }

      return response.json;
    }
  );
}

async function getMetadata(tmdbId, mediaType) {
  const type = mediaType === "tv" ? "tv" : "movie";
  const id = encodeURIComponent(String(tmdbId));

  const titles = [];
  let year = null;

  function addTitle(value) {
    const title = cleanText(value);

    if (!title) return;

    const normalized = normalizeTitle(title);

    if (
      normalized &&
      !titles.some(
        item => normalizeTitle(item) === normalized
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
          String(
            data.release_date ||
            data.first_air_date ||
            ""
          ).slice(0, 4)
        ) || null;
      }

    } catch (error) {
      console.log(
        "[Stardima] TMDB metadata:",
        language,
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
        ? getArray(alternatives.results)
        : getArray(alternatives.titles);

    list.forEach(item => {
      addTitle(item.title || item.name);
    });

  } catch (_) {}

  if (!titles.length) {
    throw new Error("No TMDB titles found");
  }

  return {
    titles: unique(titles),
    year
  };
}

/* =====================================================
   STARDIMA SEARCH
===================================================== */

async function searchStardima(base, title) {
  const params = {
    "categories[]": "all",
    query: title,
    language: "all",
    media: "all",
    status: "all",
    premium: "all",
    per_page: 40,
    page: 1,
    gener: "all",
    sort: "newest",
    year: "all"
  };

  const url =
    base +
    "/api/search?" +
    encodeQuery(params);

  const json = await getJson(url);

  return getArray(json.videos);
}

function scoreTitle(candidate, titles, year) {
  const normalized = normalizeTitle(candidate);

  if (!normalized) return 0;

  let best = 0;

  for (const title of titles) {
    const expected = normalizeTitle(title);

    if (!expected) continue;

    if (normalized === expected) {
      best = Math.max(best, 100);
      continue;
    }

    if (
      normalized.includes(expected) ||
      expected.includes(normalized)
    ) {
      best = Math.max(best, 82);
      continue;
    }

    const words = expected.split(" ").filter(Boolean);
    const found = new Set(normalized.split(" "));

    if (words.length) {
      const hits = words.filter(word => found.has(word)).length;
      best = Math.max(best, (hits / words.length) * 70);
    }
  }

  if (
    year &&
    best > 0 &&
    new RegExp("(^|\\D)" + year + "(\\D|$)").test(
      String(candidate)
    )
  ) {
    best += 5;
  }

  return best;
}

function isSeriesItem(item) {
  return (
    item.is_series === true ||
    item.episode_id != null ||
    getNumber(item.seasons_count, 0) > 0
  );
}

async function findBestMatch(base, metadata, mediaType) {
  const all = [];

  for (const title of metadata.titles.slice(0, 8)) {
    try {
      const results = await searchStardima(base, title);
      all.push(...results);
    } catch (error) {
      console.log(
        "[Stardima] Search failed:",
        title,
        error.message || String(error)
      );
    }
  }

  const candidates = [];
  const seen = new Set();

  for (const item of all) {
    if (!item || item.id == null) continue;

    const id = String(item.id);

    if (seen.has(id)) continue;
    seen.add(id);

    if (
      mediaType === "tv" &&
      !isSeriesItem(item)
    ) {
      continue;
    }

    if (
      mediaType === "movie" &&
      isSeriesItem(item)
    ) {
      continue;
    }

    const title = cleanText(item.title);

    const score = scoreTitle(
      title,
      metadata.titles,
      metadata.year
    );

    candidates.push({
      id,
      title,
      score,
      item
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0];

  if (!best || best.score < MATCH_THRESHOLD) {
    console.log(
      "[Stardima] No suitable match:",
      candidates.slice(0, 5)
    );

    return null;
  }

  console.log(
    "[Stardima] Match:",
    best.title,
    "score:",
    best.score
  );

  return best;
}

/* =====================================================
   VIDEO DETAILS
===================================================== */

async function getVideoDetails(base, id) {
  const json = await getJson(
    base + "/api/video/" + encodeURIComponent(id)
  );

  if (json.data && typeof json.data === "object") {
    return json.data;
  }

  return json;
}

function isSeriesDetails(detail) {
  const type = String(detail.type || "").toLowerCase();

  return type === "series" || type === "tv";
}

/* =====================================================
   EPISODE SELECTION
===================================================== */

async function getSeasonEpisodes(base, seasonId) {
  const url =
    base +
    "/api/episodes/" +
    encodeURIComponent(String(seasonId)) +
    "?page=1&per_page=200&q=";

  const json = await getJson(url);

  if (Array.isArray(json.data)) {
    return json.data;
  }

  if (json.data && Array.isArray(json.data.data)) {
    return json.data.data;
  }

  return [];
}

async function findRequestedEpisode(
  base,
  detail,
  wantedSeason,
  wantedEpisode
) {
  const seasons = getArray(detail.seasons);

  const seasonNumber = Number(wantedSeason);
  const episodeNumber = Number(wantedEpisode);

  if (
    !Number.isFinite(seasonNumber) ||
    !Number.isFinite(episodeNumber)
  ) {
    throw new Error("Invalid season or episode number");
  }

  const season = seasons.find((item, index) => {
    const number = getNumber(
      item.season_number,
      index + 1
    );

    return number === seasonNumber;
  });

  if (!season || season.id == null) {
    throw new Error(
      "Season " + seasonNumber + " not found"
    );
  }

  const episodes = await getSeasonEpisodes(
    base,
    season.id
  );

  const episode = episodes.find((item, index) => {
    const number = getNumber(
      item.episode_number,
      index + 1
    );

    return number === episodeNumber;
  });

  if (!episode || episode.id == null) {
    throw new Error(
      "Episode " +
      episodeNumber +
      " in season " +
      seasonNumber +
      " not found"
    );
  }

  return episode;
}

/* =====================================================
   SERVER EXTRACTION
===================================================== */

function unwrapStrema(url) {
  try {
    const parsed = new URL(url);

    if (
      !parsed.hostname.toLowerCase().includes("strema.top") ||
      !parsed.pathname.toLowerCase().includes("/embed")
    ) {
      return url;
    }

    const embedded = parsed.searchParams.get("id");

    if (embedded && /^https?:\/\//i.test(embedded)) {
      return embedded;
    }

    return url;

  } catch (_) {
    return url;
  }
}

function isDirectVideo(url, server) {
  const value = String(url || "").trim();

  if (!/^https?:\/\//i.test(value)) {
    return false;
  }

  const type = String(server.type || "").toLowerCase();
  const label = String(server.label || "").toLowerCase();

  if (
    type === "backup" ||
    label === "backup" ||
    value.toLowerCase().includes("worldnow.top")
  ) {
    return true;
  }

  return /\.(m3u8|mp4|mkv|mpd|webm)(?:[?#]|$)/i.test(value);
}

function detectQuality(url, server) {
  const text = (
    String(url || "") +
    " " +
    String(server.label || "") +
    " " +
    String(server.quality || "")
  ).toLowerCase();

  if (/2160|4k/.test(text)) return "2160p";
  if (/1080/.test(text)) return "1080p";
  if (/720/.test(text)) return "720p";
  if (/480/.test(text)) return "480p";
  if (/360/.test(text)) return "360p";

  return "Auto";
}

function getServerArray(json) {
  if (Array.isArray(json)) return json;

  if (json && Array.isArray(json.servers)) {
    return json.servers;
  }

  if (
    json &&
    json.data &&
    Array.isArray(json.data.servers)
  ) {
    return json.data.servers;
  }

  if (json && Array.isArray(json.data)) {
    return json.data;
  }

  return [];
}

async function getMovieServers(base, movieId) {
  const detail = await getVideoDetails(base, movieId);
  return getServerArray(detail);
}

async function getEpisodeServers(base, episodeId) {
  const url =
    base +
    "/api/episodes/" +
    encodeURIComponent(String(episodeId)) +
    "/servers";

  const json = await getJson(url);

  return getServerArray(json);
}

/* =====================================================
   STREAM BUILDING
===================================================== */

function buildStreams(servers, referer) {
  const results = [];
  const seen = new Set();

  for (const server of servers) {
    if (!server) continue;

    let url = String(server.url || "").trim();

    if (!url) continue;

    url = unwrapStrema(url);

    if (!isDirectVideo(url, server)) {
      console.log(
        "[Stardima] External player skipped:",
        server.label || url
      );
      continue;
    }

    if (seen.has(url)) continue;
    seen.add(url);

    const label = cleanText(server.label || "Server");
    const quality = detectQuality(url, server);

    results.push({
      name: PROVIDER_NAME,
      title: label + " | " + quality,
      url,
      quality,
      headers: {
        Referer: referer,
        "User-Agent": APP_UA
      }
    });
  }

  return results;
}

/* =====================================================
   MAIN NUVIO ENTRY POINT
===================================================== */

async function getStreams(
  tmdbId,
  mediaType,
  season,
  episode
) {
  let stage = "validation";

  try {
    if (!tmdbId) {
      console.log("[Stardima] Missing TMDB ID");
      return [];
    }

    if (mediaType !== "movie" && mediaType !== "tv") {
      console.log(
        "[Stardima] Unsupported media type:",
        mediaType
      );
      return [];
    }

    if (
      mediaType === "tv" &&
      (
        !Number.isFinite(Number(season)) ||
        !Number.isFinite(Number(episode))
      )
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

    stage = "API discovery";

    let base = await discoverApiBase(false);

    stage = "TMDB metadata";

    const metadata = await getMetadata(
      tmdbId,
      mediaType
    );

    console.log(
      "[Stardima] Search titles:",
      metadata.titles
    );

    stage = "Content search";

    let match = await findBestMatch(
      base,
      metadata,
      mediaType
    );

    if (!match) {
      console.log(
        "[Stardima] Refreshing API discovery"
      );

      base = await discoverApiBase(true);

      match = await findBestMatch(
        base,
        metadata,
        mediaType
      );
    }

    if (!match) {
      console.log("[Stardima] Content not found");
      return [];
    }

    stage = "Video details";

    const detail = await getVideoDetails(
      base,
      match.id
    );

    let servers = [];

    if (mediaType === "movie") {
      if (isSeriesDetails(detail)) {
        console.log(
          "[Stardima] Type mismatch: expected movie"
        );
        return [];
      }

      stage = "Movie servers";

      servers = await getMovieServers(
        base,
        match.id
      );

    } else {
      if (!isSeriesDetails(detail)) {
        console.log(
          "[Stardima] Type mismatch: expected series"
        );
        return [];
      }

      stage = "Episode selection";

      const selectedEpisode = await findRequestedEpisode(
        base,
        detail,
        season,
        episode
      );

      stage = "Episode servers";

      servers = await getEpisodeServers(
        base,
        selectedEpisode.id
      );
    }

    stage = "Stream extraction";

    const streams = buildStreams(
      servers,
      base + "/"
    );

    console.log(
      "[Stardima] Servers:",
      servers.length,
      "| Direct streams:",
      streams.length
    );

    return streams;

  } catch (error) {
    console.log(
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
