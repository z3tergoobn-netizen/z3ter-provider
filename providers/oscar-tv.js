
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

  if (!response.ok) {
    throw new Error("HTTP " + response.status + ": " + url);
  }

  return response.json();
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

/*
 * Oscar requires fresh X-Iron-* headers for API requests.
 * The helper prepares headers for the exact URL being requested.
 */
async function oscarCall(path) {
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

    const result = await fetchJson(url, {
      method: "GET",
      headers,
      redirect: "follow"
    });

    return result;
  });
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

  const tasks = [];

  for (const title of titles.slice(0, 6)) {
    for (const kind of kinds) {
      tasks.push({ title, kind });
    }
  }

  const groups = await mapLimit(tasks, 3, task =>
    searchOscar(task.kind, task.title)
  );

  const results = [];
  const seen = new Set();

  for (const group of groups) {
    for (const result of group || []) {
      const key = result.kind + ":" + result.id;

      if (!seen.has(key)) {
        seen.add(key);
        results.push(result);
      }
    }
  }

  let best = null;
  let bestScore = 0;

  for (const result of results) {
    for (const title of titles) {
      const score = titleScore(result.title, title);

      if (score > bestScore) {
        best = result;
        bestScore = score;
      }
    }
  }

  log("Candidates:", results.length, "best score:", bestScore);

  // Avoid selecting an unrelated work when titles are too different.
  return bestScore >= 45
    ? { ...best, score: bestScore }
    : null;
}

/* -------------------- Stream extraction -------------------- */

function getFormat(url) {
  const value = String(url).toLowerCase();

  if (/\.m3u8(?:$|[?#])/.test(value)) return "HLS";
  if (/\.mpd(?:$|[?#])/.test(value)) return "DASH";
  if (/\.mp4(?:$|[?#])/.test(value)) return "MP4";

  return "Direct";
}

function getQuality(value, url) {
  const match = (clean(value) + " " + url).match(
    /(?:^|\D)(2160|1440|1080|720|576|540|480|360)p?(?:\D|$)/i
  );

  return match ? match[1] + "p" : (clean(value) || "auto");
}

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
    const quality = getQuality(item.quality, url);

    streams.push({
      name: PROVIDER_NAME,
      title:
        "Oscar TV | " + item.server +
        " | " + quality +
        (format !== "Direct" ? " | " + format : ""),
      url,
      quality,
      headers: {
        "User-Agent": PLAY_UA,
        "Referer": OSCAR_HOME + "/"
      }
    });
  }

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
