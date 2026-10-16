//
// ©© made by AI
//

"use strict";

const PROVIDER_NAME = "Oscar TV";
const OSCAR_HOME = "https://ostv-11-11.xyz";
const HEADER_HELPER =
  "https://flech.tn/scrapefinal/dramabox/step1_prepare_oscar.php";

const TMDB_API_KEY = "09c002491851747716f94bd211a6681b";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const PLAY_UA = "TDMuaHLS99";

const cache = new Map();
const CACHE_TTL = 3 * 60 * 1000;

function log(...args) {
  console.log("[Oscar TV]", ...args);
}

function clean(value) {
  return String(value ?? "").trim();
}

function absoluteUrl(value, base = OSCAR_HOME) {
  const raw = clean(value);
  if (!raw || /^(data:|blob:|javascript:)/i.test(raw)) return "";

  try {
    return new URL(raw, base).href;
  } catch (_) {
    return "";
  }
}

function normalizeTitle(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670ـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function titleScore(candidate, target) {
  const a = normalizeTitle(candidate);
  const b = normalizeTitle(target);

  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.startsWith(b) || b.startsWith(a)) return 82;

  const targetWords = b.split(" ");
  const candidateWords = new Set(a.split(" "));
  const common = targetWords.filter(word => candidateWords.has(word));

  return targetWords.length
    ? (common.length / targetWords.length) * 70
    : 0;
}

async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    const source = url.startsWith(HEADER_HELPER) ? "helper"
                 : url.startsWith(OSCAR_HOME)   ? "api"
                 : "other";
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();   // نقرأ النص أولاً بدلاً من response.json()

    if (!response.ok) {
        const error = new Error(source + " HTTP " + response.status + ": " + url);
        error.status = response.status;
        error.source = source;
        error.contentType = contentType;
        if (/text\/html/i.test(contentType) || /^\s*</.test(text)) {
            console.warn("[Oscar TV][diag] " + source + " HTML (status " +
                response.status + ", ct=" + contentType + "): " +
                text.slice(0, 200).replace(/\s+/g, " "));
        }
        throw error;
    }

    try {
        return JSON.parse(text);
    } catch (parseError) {
        const error = new Error(source + " non-JSON (status " + response.status +
            ", ct=" + contentType + ")");
        error.status = response.status;
        error.source = source;
        error.contentType = contentType;
        if (/text\/html/i.test(contentType) || /^\s*</.test(text)) {
            console.warn("[Oscar TV][diag] " + source + " HTML body snippet: " +
                text.slice(0, 200).replace(/\s+/g, " "));
        }
        throw error;
    }
}

async function cached(key, loader, ttl = CACHE_TTL) {
  const existing = cache.get(key);

  if (existing && existing.expires > Date.now()) {
    return existing.promise;
  }

  const promise = Promise.resolve().then(loader);
  cache.set(key, { expires: Date.now() + ttl, promise });

  try {
    return await promise;
  } catch (error) {
    if (cache.get(key)?.promise === promise) {
      cache.delete(key);
    }
    throw error;
  }
}

/* -------------------- Oscar API -------------------- */

async function oscarCallOnce(path) {
  const url =
    OSCAR_HOME + "/" + String(path).replace(/^\/+/, "");

  return cached("api:" + url, async () => {
    const prepared = await fetchJson(HEADER_HELPER, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json, text/plain, */*"
      },
      body: "url=" + encodeURIComponent(url)
    });

    const sourceHeaders = prepared?.headers;

    if (!sourceHeaders || typeof sourceHeaders !== "object") {
      throw new Error("Oscar header helper returned no headers");
    }

    const headers = {};

    for (const [key, value] of Object.entries(sourceHeaders)) {
      if (value == null) continue;
      if (/^(host|connection)$/i.test(key)) continue;
      headers[key] = String(value);
    }

    headers["User-Agent"] = headers["User-Agent"] || USER_AGENT;
    headers["Accept"] =
      headers["Accept"] || "application/json, text/plain, */*";

    return fetchJson(url, {
      method: "GET",
      headers,
      redirect: "follow"
    });
  });
}

/* Serialized throttle: one request starts at a time, at least `gap` ms apart. */
let gate = Promise.resolve();
let lastStart = 0;
let blockedUntil = 0;

function throttle(gap = 350) {
  const turn = gate.then(async () => {
    const wait = lastStart + gap - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastStart = Date.now();
  });

  gate = turn.catch(() => {});
  return turn;
}

/* Retry with FRESH signed headers (the cache drops failed calls, so the helper
   is asked again). After repeated 403/429 we pause 90s instead of hammering. */
async function oscarCall(path) {
  if (Date.now() < blockedUntil) {
    throw new Error("Oscar requests paused after repeated 403/429");
  }

  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await throttle();

      if (attempt > 1) {
        await new Promise(r =>
          setTimeout(r, 700 * attempt + Math.random() * 400)
        );
      }

      return await oscarCallOnce(path);
    } catch (error) {
      lastError = error;

      log(
        "attempt " + attempt + "/3 failed [" + (error.source || "net") + "]:",
        error.message || String(error)
      );

      const retryable =
        !error.status ||
        error.status === 403 ||
        error.status === 429 ||
        error.status >= 500;

      if (!retryable) throw error;
    }
  }

  if (lastError && (lastError.status === 403 || lastError.status === 429)) {
    blockedUntil = Date.now() + 90 * 1000;
    log(
      "blocked (" + lastError.source + " " + lastError.status +
      ") - pausing requests for 90s"
    );
  }

  throw lastError;
}

function getDataObject(response) {
  const data = response?.data;

  return data && !Array.isArray(data) && typeof data === "object"
    ? data
    : null;
}

function getDataArray(response) {
  return Array.isArray(response?.data) ? response.data : [];
}

function getString(object, ...keys) {
  for (const key of keys) {
    const value = clean(object?.[key]);

    if (value && value !== "null" && value !== "undefined") {
      return value;
    }
  }

  return "";
}

function getNumber(object, ...keys) {
  for (const key of keys) {
    const number = Number(object?.[key]);

    if (Number.isFinite(number) && number > 0) {
      return number;
    }
  }

  return null;
}

/* -------------------- TMDB titles -------------------- */

async function getTitles(tmdbId, mediaType) {
  const type = mediaType === "tv" ? "tv" : "movie";

  return cached(
    "tmdb:" + type + ":" + tmdbId,
    async () => {
      const titles = [];

      const addTitle = value => {
        const title = clean(value);

        if (
          title &&
          !titles.some(
            item => normalizeTitle(item) === normalizeTitle(title)
          )
        ) {
          titles.push(title);
        }
      };

      for (const language of ["ar-SA", "en-US"]) {
        try {
          const url =
            "https://api.themoviedb.org/3/" +
            type + "/" + encodeURIComponent(tmdbId) +
            "?api_key=" + encodeURIComponent(TMDB_API_KEY) +
            "&language=" + encodeURIComponent(language);

          const data = await fetchJson(url, {
            headers: {
              "User-Agent": USER_AGENT,
              "Accept": "application/json"
            }
          });

          addTitle(type === "tv" ? data.name : data.title);
          addTitle(
            type === "tv" ? data.original_name : data.original_title
          );
        } catch (error) {
          log("TMDB lookup failed:", error.message || String(error));
        }
      }

      if (!titles.length) {
        throw new Error("No titles returned by TMDB");
      }

      return titles;
    },
    30 * 60 * 1000
  );
}

/* -------------------- Oscar search -------------------- */

async function searchOscar(kind, query) {
  const prefix =
    kind === "movie"
      ? "api/movies"
      : kind === "anime"
        ? "api/anime"
        : "api/series";

  const response = await oscarCall(
    prefix +
    "/?page=1&limit=20&search=" +
    encodeURIComponent(query)
  );

  return getDataArray(response)
    .map(item => {
      const id = getNumber(item, "id", "item_id");
      const title = getString(
        item, "title_ar", "title_en", "name", "series_title"
      );

      if (!id || !title) return null;

      return {
        id,
        kind,
        title,
        poster: absoluteUrl(
          getString(item, "poster", "image")
        )
      };
    })
    .filter(Boolean);
}

async function mapLimit(items, limit, callback) {
  const results = new Array(items.length);
  let next = 0;

  await Promise.all(
    Array.from(
      { length: Math.min(limit, items.length) },
      async () => {
        while (true) {
          const index = next++;

          if (index >= items.length) return;

          try {
            results[index] = await callback(items[index]);
          } catch (error) {
            log("Search task failed:", error.message || String(error));
            results[index] = [];
          }
        }
      }
    )
  );

  return results;
}

async function findBestMatch(titles, mediaType) {
  const kinds = mediaType === "movie"
    ? ["movie"]
    : ["series", "anime"];

  const results = [];
  const seen = new Set();
  let best = null;
  let bestScore = 0;
  let calls = 0;
  let failures = 0;
  let lastError = null;

  // One title at a time; stop as soon as we have a confident match
  // (far fewer requests per play than searching every title x kind).
  for (const title of titles.slice(0, 3)) {
    const groups = await Promise.all(
      kinds.map(async kind => {
        calls++;

        try {
          return await searchOscar(kind, title);
        } catch (error) {
          failures++;
          lastError = lastError || error; // keep the FIRST (real) cause, not the later "paused" one
          log("Search failed:", error.message || String(error));
          return [];
        }
      })
    );

    for (const group of groups) {
      for (const result of group) {
        const key = result.kind + ":" + result.id;

        if (seen.has(key)) continue;
        seen.add(key);
        results.push(result);

        for (const target of titles) {
          const score = titleScore(result.title, target);

          if (score > bestScore) {
            best = result;
            bestScore = score;
          }
        }
      }
    }

    if (bestScore >= 88) break;
  }

  // Every search failed -> surface the real error instead of "no match".
  if (!best && calls > 0 && failures === calls && lastError) {
    throw lastError;
  }

  log("Candidates:", results.length, "best score:", bestScore);

  return bestScore >= 45
    ? { ...best, score: bestScore }
    : null;
}

/* -------------------- Stream formatting -------------------- */

function getFormat(url) {
  const value = String(url || "").toLowerCase();

  if (/\.m3u8(?:$|[?#])/.test(value)) return "HLS";
  if (/\.mpd(?:$|[?#])/.test(value)) return "DASH";
  if (/\.mp4(?:$|[?#])/.test(value)) return "MP4";
  if (/\.mkv(?:$|[?#])/.test(value)) return "MKV";

  return "Direct";
}

function getQualityInfo(value, url) {
  const source = clean(value);
  const combined = source + " " + String(url || "");

  const match = combined.match(
    /(?:^|\D)(2160|1440|1080|720|576|540|480|360)p?(?:\D|$)/i
  );

  if (match) {
    const resolution = Number(match[1]);

    let label;
    if (resolution >= 2160) label = "4K UHD";
    else if (resolution >= 1440) label = "QHD";
    else if (resolution >= 1080) label = "FHD";
    else if (resolution >= 720) label = "HD";
    else label = "SD";

    return {
      resolution,
      quality: resolution + "p",
      label
    };
  }

  if (/\b(?:4k|uhd|ultra[\s-]*hd)\b/i.test(combined)) {
    return {
      resolution: 2160,
      quality: "2160p",
      label: "4K UHD"
    };
  }

  if (/\b(?:fhd|full[\s-]*hd)\b/i.test(combined)) {
    return {
      resolution: 1080,
      quality: "1080p",
      label: "FHD"
    };
  }

  if (/\bqhd\b/i.test(combined)) {
    return {
      resolution: 1440,
      quality: "1440p",
      label: "QHD"
    };
  }

  if (/\bhd\b/i.test(combined)) {
    return {
      resolution: 0,
      quality: "HD",
      label: "HD"
    };
  }

  if (/\b(?:sd|low|mobile)\b/i.test(combined)) {
    return {
      resolution: 480,
      quality: "480p",
      label: "SD"
    };
  }

  return {
    resolution: 0,
    quality: "Auto",
    label: "Auto"
  };
}

function qualityRank(stream) {
  return Number(stream?.resolution) || -1;
}

function getQualityEmoji(resolution) {
  if (resolution >= 2160) return "👑";
  if (resolution >= 1440) return "💎";
  if (resolution >= 1080) return "⚡";
  if (resolution >= 720) return "🔥";
  if (resolution >= 576) return "🎯";
  if (resolution >= 540) return "🟣";
  if (resolution >= 480) return "📺";
  if (resolution > 0) return "📱";
  return "❔";
}

/* -------------------- Stream extraction -------------------- */

async function resolveSpecialHost(url) {
  if (!url.includes("newcdn.seriesmp4.com")) return url;

  try {
    const response = await fetch(url, {
      headers: { "User-Agent": PLAY_UA },
      redirect: "follow"
    });

    if (!response.ok) return "";

    const html = await response.text();
    const match = html.match(
      /src=["'](https:\/\/downloader\.disk\.yandex\.ru[^"']+)["']/i
    );

    return match ? match[1].replace(/&amp;/g, "&") : "";
  } catch (error) {
    log("Special host resolution failed:", error.message || String(error));
    return "";
  }
}

async function extractStreams(detail) {
  const candidates = [];

  for (const item of detail?.watch_links || []) {
    candidates.push({
      url: getString(item, "url"),
      server: getString(item, "server_name") || "Oscar TV",
      quality: getString(item, "quality")
    });
  }

  for (const item of detail?.download_links || []) {
    candidates.push({
      url: getString(item, "url"),
      server: getString(item, "server_name") || "Download",
      quality: getString(item, "quality")
    });
  }

  const streams = [];
  const seen = new Set();

  for (const item of candidates) {
    let url = absoluteUrl(item.url);

    if (!/^https?:\/\//i.test(url)) continue;

    url = await resolveSpecialHost(url);

    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) {
      continue;
    }

    seen.add(url);

    const format = getFormat(url);
    const info = getQualityInfo(item.quality, url);
    const emoji = getQualityEmoji(info.resolution);

    streams.push({
      name: emoji + " " + info.label + " | 👴🏻✌🏻515",
      title: "🎬 Oscar TV · 🎞️ " + info.quality,
      url,
      quality: info.quality,
      resolution: info.resolution,
      headers: {
        "User-Agent": PLAY_UA,
        "Referer": OSCAR_HOME + "/"
      }
    });
  }

  streams.sort((a, b) => qualityRank(b) - qualityRank(a));

  return streams;
}

async function getMovieStreams(match) {
  const response = await oscarCall(
    "api/movies/show.php?id=" + encodeURIComponent(match.id)
  );

  const detail = getDataObject(response);

  return detail ? extractStreams(detail) : [];
}

async function getEpisodeStreams(match, season, episode) {
  const isAnime = match.kind === "anime";
  const base = isAnime ? "api/anime" : "api/series";

  const showResponse = await oscarCall(
    base + "/show.php?id=" + encodeURIComponent(match.id)
  );

  const show = getDataObject(showResponse);

  if (!show) return [];

  const seasons = Array.isArray(show.seasons) ? show.seasons : [];
  const wantedSeason = Number(season || 1);
  const wantedEpisode = Number(episode);

  let selectedSeasons = seasons.filter(
    item => Number(item.season_number || 1) === wantedSeason
  );

  if (!selectedSeasons.length && seasons.length) {
    selectedSeasons = seasons.filter(
      item => Number(item.season_number || 1) === 1
    );
  }

  if (!selectedSeasons.length) {
    selectedSeasons = seasons.slice(0, 1);
  }

  const groups = await mapLimit(selectedSeasons, 3, async item => {
    const seasonId = getNumber(item, "season_id", "id");

    if (!seasonId) return [];

    const episodePath = isAnime
      ? "api/anime/episodes/"
      : "api/episodes/";

    const response = await oscarCall(
      episodePath + "?season_id=" + encodeURIComponent(seasonId)
    );

    return getDataArray(response).map((ep, index) => ({
      id: getNumber(ep, "id"),
      number: getNumber(ep, "episode_number") || index + 1,
      season: getNumber(item, "season_number") || 1
    })).filter(ep => ep.id);
  });

  const episodes = groups.flat();

  let selected = episodes.find(
    ep => ep.season === wantedSeason && ep.number === wantedEpisode
  );

  if (!selected) {
    selected = episodes.find(ep => ep.number === wantedEpisode);
  }

  if (!selected && episodes.length === 1) {
    selected = episodes[0];
  }

  if (!selected) {
    log("Episode not found:", wantedSeason, wantedEpisode);
    return [];
  }

  const detailPath = isAnime
    ? "api/anime/episodes/show.php"
    : "api/episodes/show.php";

  const response = await oscarCall(
    detailPath + "?id=" + encodeURIComponent(selected.id)
  );

  const detail = getDataObject(response);

  return detail ? extractStreams(detail) : [];
}

/* -------------------- Nuvio entry point -------------------- */

async function getStreams(tmdbId, mediaType, season, episode) {
  let stage = "validation";

  try {
    if (!tmdbId || !["movie", "tv"].includes(mediaType)) {
      return [];
    }

    stage = "TMDB title lookup";
    const titles = await getTitles(tmdbId, mediaType);

    stage = "Oscar search";
    const match = await findBestMatch(titles, mediaType);

    if (!match) {
      log("No confident title match:", titles);
      return [];
    }

    log(
      "Selected:", match.kind, match.title,
      "ID:", match.id, "score:", match.score
    );

    stage = "Stream extraction";

    if (mediaType === "movie") {
      return await getMovieStreams(match);
    }

    if (episode == null) {
      log("TV request has no episode number");
      return [];
    }

    return await getEpisodeStreams(match, season, episode);
  } catch (error) {
    console.error(
      "[Oscar TV] Failed at " + stage + ":",
      error?.message || String(error)
    );

    return [];
  }
}

module.exports = {
  getStreams
};
