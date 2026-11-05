
"use strict";

/**
 * Egywatch Provider for Nuvio
 * Quality display styled after Oscar TV.
 */

const PROVIDER_NAME = "Egywatch";

const API_CODE = "p2lbgWkFrykA4QyUmpHihzmc5BNzIABq";

const API_BASES = [
  "https://gateway.egywatch.live/egywatchapp/public/api/",
  "https://rn62mwg.com/egywatchapp/public/api/"
];

const SCRAPER_BASE = "https://mawdhou3.com/";

const TMDB_API_KEY = "09c002491851747716f94bd211a6681b";

const APP_UA =
  "EasyPlex (Android 14; M2006C3MG; Redmi angelica; en)";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/141.0.0.0 Safari/537.36";

const API_HEADERS = {
  "User-Agent": APP_UA,
  "packagename": "com.linkletter.app",
  "Accept": "application/json"
};

const ACCEPT_LANGUAGE = "en-US,en;q=0.9";

const CACHE = new Map();
const CACHE_TTL = 5 * 60 * 1000;
const SOURCE_TIMEOUT = 12000;

const DIRECT_FILE =
  /^https?:\/\/.+?\.(mp4|m3u8|mkv|webm)(\?.*)?$/i;

const DEAD_HOSTS = [
  "ostvapp.cam",
  "admin.dramaramadan.net"
];

/* -------------------- Utilities -------------------- */

function log(...args) {
  console.log("[Egywatch]", ...args);
}

function clean(value) {
  return String(value ?? "").trim();
}

function absoluteUrl(value, base) {
  const raw = clean(value);

  if (!raw || /^(data:|blob:|javascript:)/i.test(raw)) {
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

  if (a.startsWith(b) || b.startsWith(a)) {
    return 82;
  }

  const targetWords = b.split(" ");
  const candidateWords = new Set(a.split(" "));

  const common = targetWords.filter(
    word => candidateWords.has(word)
  );

  return targetWords.length
    ? (common.length / targetWords.length) * 70
    : 0;
}

function unique(values) {
  const seen = new Set();

  return values.filter(value => {
    const key = normalizeTitle(value);

    if (!key || seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function cached(key, loader, ttl = CACHE_TTL) {
  const current = CACHE.get(key);

  if (current && current.expires > Date.now()) {
    return current.promise;
  }

  const promise = Promise.resolve().then(loader);

  CACHE.set(key, {
    expires: Date.now() + ttl,
    promise
  });

  try {
    return await promise;
  } catch (error) {
    if (CACHE.get(key)?.promise === promise) {
      CACHE.delete(key);
    }

    throw error;
  }
}

async function mapLimit(items, limit, mapper) {
  const output = new Array(items.length);
  let next = 0;

  await Promise.all(
    Array.from(
      { length: Math.min(limit, items.length) },
      async () => {
        while (true) {
          const index = next++;

          if (index >= items.length) return;

          try {
            output[index] = await mapper(items[index], index);
          } catch (error) {
            log("Task failed:", error.message || String(error));
            output[index] = null;
          }
        }
      }
    )
  );

  return output;
}

/* -------------------- HTTP -------------------- */

async function requestText(url, options = {}) {
  const response = await fetch(url, {
    redirect: "follow",
    ...options
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      "HTTP " + response.status + " - " + url +
      " - " + body.slice(0, 120)
    );
  }

  return {
    text: body,
    url: response.url || url,
    headers: response.headers
  };
}

async function requestJson(url, options = {}) {
  const result = await requestText(url, options);

  try {
    return JSON.parse(result.text);
  } catch (_) {
    throw new Error(
      "Invalid JSON from " + url +
      ": " + result.text.slice(0, 120)
    );
  }
}

/* -------------------- Egywatch API -------------------- */

async function getJson(path) {
  const cleanPath = String(path).replace(/^\/+/, "");
  let lastError = null;

  return cached("api:" + cleanPath, async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      for (const base of API_BASES) {
        try {
          const data = await requestJson(base + cleanPath, {
            headers: API_HEADERS
          });

          if (
            data &&
            Object.keys(data).length === 1 &&
            Object.prototype.hasOwnProperty.call(data, "message")
          ) {
            lastError = new Error("Empty API response");
            continue;
          }

          return data;
        } catch (error) {
          lastError = error;
        }
      }

      if (attempt < 3) await sleep(400);
    }

    throw lastError || new Error("Egywatch API unavailable");
  });
}

function getArray(json, ...keys) {
  for (const key of keys) {
    if (Array.isArray(json?.[key])) {
      return json[key];
    }
  }

  return [];
}

function getString(object, ...keys) {
  for (const key of keys) {
    const value = clean(object?.[key]);

    if (
      value &&
      value !== "null" &&
      value !== "undefined"
    ) {
      return value;
    }
  }

  return "";
}

function getNumber(object, ...keys) {
  for (const key of keys) {
    const value = Number(object?.[key]);

    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  return null;
}

/* -------------------- TMDB -------------------- */

async function tmdbJson(path, language) {
  const url =
    "https://api.themoviedb.org/3/" + path +
    "?api_key=" + encodeURIComponent(TMDB_API_KEY) +
    "&language=" + encodeURIComponent(language);

  return cached("tmdb:" + url, () =>
    requestJson(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": BROWSER_UA
      }
    }),
    30 * 60 * 1000
  );
}

async function getTmdbTitles(tmdbId, mediaType) {
  const type = mediaType === "tv" ? "tv" : "movie";
  const id = encodeURIComponent(String(tmdbId));
  const titles = [];

  const add = value => {
    const title = clean(value);

    if (title) titles.push(title);
  };

  for (const language of ["ar-SA", "en-US"]) {
    try {
      const data = await tmdbJson(
        type + "/" + id,
        language
      );

      add(type === "tv" ? data.name : data.title);

      add(
        type === "tv"
          ? data.original_name
          : data.original_title
      );
    } catch (error) {
      log("TMDB title failed:", error.message);
    }
  }

  try {
    const data = await tmdbJson(
      type + "/" + id + "/alternative_titles",
      "en-US"
    );

    const alternatives = type === "tv"
      ? getArray(data, "results")
      : getArray(data, "titles");

    for (const item of alternatives) {
      add(item.title || item.name);
    }
  } catch (error) {
    log("TMDB alternatives unavailable:", error.message);
  }

  const result = unique(titles);

  if (!result.length) {
    throw new Error("No titles returned by TMDB");
  }

  return result;
}

/* -------------------- Search -------------------- */

function detectKind(item) {
  const type = clean(
    item?.type || item?.media_type || item?.category
  ).toLowerCase();

  if (
    type.includes("live") ||
    type.includes("stream")
  ) return "live";

  if (
    type.includes("anime") &&
    (type.includes("movie") || type.includes("film"))
  ) return "anime_movie";

  if (type.includes("anime")) return "anime";

  if (
    type.includes("serie") ||
    type.includes("series") ||
    type.includes("tv")
  ) return "series";

  return "movie";
}

function parseSearchItem(item) {
  const id = getNumber(item, "id", "media_id");

  const title = getString(
    item,
    "name",
    "title",
    "original_name"
  );

  if (!id || !title) return null;

  return {
    id,
    title,
    kind: detectKind(item),
    poster: getString(
      item,
      "poster_path",
      "poster",
      "backdrop_path"
    )
  };
}

function allowedForMediaType(item, mediaType) {
  if (mediaType === "movie") {
    return [
      "movie",
      "anime_movie"
    ].includes(item.kind);
  }

  if (mediaType === "tv") {
    return [
      "series",
      "anime"
    ].includes(item.kind);
  }

  if (mediaType === "live") {
    return item.kind === "live";
  }

  return false;
}

async function searchEgywatch(query) {
  const q = encodeURIComponent(query).replace(/%20/g, "%20");

  const json = await getJson(
    "search/" + q + "/" + API_CODE
  );

  const items = [
    ...getArray(json, "search"),
    ...getArray(json, "data"),
    ...getArray(json, "results")
  ];

  const seen = new Set();

  return items
    .map(parseSearchItem)
    .filter(Boolean)
    .filter(item => {
      const key = item.kind + ":" + item.id;

      if (seen.has(key)) return false;

      seen.add(key);
      return true;
    });
}

async function findBestMatch(titles, mediaType) {
  const groups = await mapLimit(
    titles.slice(0, 5),
    3,
    title => searchEgywatch(title)
  );

  const candidates = [];
  const seen = new Set();

  for (const group of groups) {
    for (const item of group || []) {
      if (!allowedForMediaType(item, mediaType)) continue;

      const key = item.kind + ":" + item.id;

      if (seen.has(key)) continue;

      seen.add(key);
      candidates.push(item);
    }
  }

  let best = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    for (const title of titles) {
      const score = titleScore(candidate.title, title);

      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
  }

  log(
    "Search candidates:",
    candidates.length,
    "best score:",
    bestScore
  );

  return bestScore >= 45
    ? { ...best, score: bestScore }
    : null;
}

/* -------------------- Detail data -------------------- */

async function getMovieDetail(id) {
  return getJson("media/detail/" + id + "/" + API_CODE);
}

async function getLiveDetail(id) {
  return getJson("stream/show/" + id + "/" + API_CODE);
}

async function getSeriesDetail(id, kind) {
  const path = kind === "anime"
    ? "animes/show/"
    : "series/show/";

  return getJson(path + id + "/" + API_CODE);
}

async function getSeasonDetail(seasonId, kind) {
  const path = kind === "anime"
    ? "animes/season/"
    : "series/season/";

  return getJson(path + seasonId + "/" + API_CODE);
}

/* -------------------- Video list -------------------- */

function getVideos(json) {
  return getArray(json, "videos");
}

async function getEpisodeVideos(match, season, episode) {
  const show = await getSeriesDetail(match.id, match.kind);
  const seasons = getArray(show, "seasons");

  const wantedSeason = Number(season || 1);
  const wantedEpisode = Number(episode);

  const selectedSeason = seasons.find(
    (item, index) =>
      Number(item.season_number || index + 1) === wantedSeason
  );

  if (!selectedSeason) {
    log("Season not found:", wantedSeason);
    return [];
  }

  const seasonId = getNumber(selectedSeason, "id");

  if (!seasonId) return [];

  const seasonData = await getSeasonDetail(
    seasonId,
    match.kind
  );

  const episodes = getArray(seasonData, "episodes");

  const selectedEpisode = episodes.find(
    (item, index) =>
      Number(item.episode_number || index + 1) === wantedEpisode
  );

  if (!selectedEpisode) {
    log("Episode not found:", wantedEpisode);
    return [];
  }

  return getVideos(selectedEpisode);
}

async function getContentVideos(match, season, episode, mediaType) {
  if (mediaType === "movie") {
    const detail = await getMovieDetail(match.id);
    return getVideos(detail);
  }

  if (mediaType === "live") {
    const detail = await getLiveDetail(match.id);
    return getVideos(detail);
  }

  return getEpisodeVideos(match, season, episode);
}

/* -------------------- Host extractor -------------------- */

const RULES = {
  earnvids: ["scrapefinal/earnvids.php", "POST"],
  "earnvids.xyz": ["scrapefinal/earnvids.php", "POST"],
  minochinos: ["scrapefinal/earnvids.php", "POST"],
  callistanise: ["scrapefinal/earnvids.php", "POST"],
  hanerix: ["scrapefinal/earnvids.php", "POST"],
  morencius: ["scrapefinal/earnvids.php", "POST"],
  streamwish: ["scrapefinal/earnvids.php", "POST"],
  mp4plus: ["scrapefinal/earnvids.php", "POST"],
  stmruby: ["scrapefinal/earnvids.php", "POST"],
  streamruby: ["scrapefinal/earnvids.php", "POST"],
  vidspeed: ["scrapefinal/earnvids.php", "POST"],
  vidspeeds: ["scrapefinal/earnvids.php", "POST"],

  upzur: ["scrapefinal/upzur.php", "POST"],
  vidaraa: ["scrapefinal/vidaara.php", "POST"],
  vidara: ["scrapefinal/vidaara.php", "POST"],
  luluvdo: ["scrapefinal/extractm3u8.php", "POST"],
  lulustream: ["scrapefinal/extractm3u8.php", "POST"],
  vidtube: ["scrapefinal/vidtubepost.php", "POST"],
  vidtubejdid: ["scrapefinal/vidtubepost.php", "POST"],
  seriesmp4: ["scrapefinal/dramaramadanPost.php", "POST"],
  seriemp4: ["scrapefinal/dramaramadanPost.php", "POST"],
  forafile: ["recuperepost.php", "POST"],
  okprime: ["scrapefinal/okprimePost.php", "POST"],
  faselpost: ["scrapefinal/faselpost.php", "POST"],
  firestream: ["scrapefinal/fastream.php", "POST"],
  fastream: ["scrapefinal/fastream.php", "POST"],
  vidobahd: ["scrapefinal/turki.php", "POST"],
  vidoba: ["scrapefinal/turki.php", "POST"],
  film77: ["scrapefinal/turki.php", "POST"],
  okhd: ["scrapefinal/turki.php", "POST"],
  laroza: ["scrapefinal/turki.php", "POST"],
  turkiiiijdid: ["scrapefinal/turki.php", "POST"],

  uqload: ["scrapefinal/uqload.php", "GET"],
  updown: ["scrapefinal/updown.php", "GET"],
  "fasel-hd": ["scripttestfasel.php", "GET"],
  faselapikey: ["scripttestfasel.php", "GET"],
  google: ["aminegoogle/extract_qualite.php", "GET"],
  "71stream": ["scrapefinal/71stream.php", "GET"],
  ukrcdn: ["scrapefinal/ukrcdn.php", "GET"],
  videasjdid: ["scrapefinal/vedasjdid.php", "GET"],
  videas: ["scrapefinal/vedas.php", "GET"],
  fdewsdcpro: ["test.php", "GET"],
  videoland: ["test.php", "GET"],
  egybestvid: ["test.php", "GET"],
  vidhidepre: ["test.php", "GET"],
  vudeo: ["test.php", "GET"],
  liiivideo: ["scrapefinal/scriptalvid.php", "GET"],
  aparat: ["scriptapart.php", "GET"],
  dnscheckr: ["fasel/geturl.php", "GET"],
  cartoony: ["decrypt_cartoony.php", "GET"],
  hdup20: ["scrapefinal/hdup20.php", "GET"],
  vidnest: ["scrapefinal/vidnest.php", "GET"],
  turbovidhls: ["scrapefinal/turbovidhls.php", "GET"],
  channel: ["scrapefinal/channel.php", "GET"]
};

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (_) {
    return "";
  }
}

function hostLabel(host) {
  const parts = clean(host).toLowerCase().split(".");
  return parts.length >= 2
    ? parts[parts.length - 2]
    : parts[0] || "";
}

function getHostRule(host) {
  const label = hostLabel(host);
  return RULES[label] || RULES[host] || null;
}

function scraperQueryKey(endpoint) {
  if (
    endpoint.includes("extract_qualite") ||
    endpoint.includes("channel") ||
    endpoint.includes("scriptapart")
  ) return "url";

  if (endpoint.includes("geturl")) return "api";
  if (endpoint.includes("decrypt_cartoony")) return "apiurl";

  return "api";
}

function parseExtractedLinks(body) {
  if (!body) return [];

  const text = String(body).trim();
  const links = [];

  if (text.startsWith("{")) {
    try {
      const json = JSON.parse(text);

      const arrays = [
        json.availableQualities,
        json.sources,
        json.links
      ];

      for (const array of arrays) {
        if (!Array.isArray(array)) continue;

        for (const item of array) {
          const url = typeof item === "string"
            ? item
            : item?.url || item?.file;

          if (url && /^https?:\/\//i.test(url)) {
            links.push({
              url,
              quality: item?.quality || item?.label || ""
            });
          }
        }
      }

      const single = json.file || json.url;

      if (
        single &&
        /^https?:\/\//i.test(single)
      ) {
        links.push({ url: single, quality: "" });
      }
    } catch (_) {}
  }

  const regex =
    /file\s*:\s*["'](https?:\/\/[^"']+)["']/gi;

  let match;

  while ((match = regex.exec(text)) !== null) {
    const rest = text.slice(regex.lastIndex);
    const label = rest.match(/label\s*:\s*["']([^"']+)["']/i);

    links.push({
      url: match[1].replace(/&amp;/g, "&"),
      quality: label?.[1] || ""
    });
  }

  return links.filter(
    (item, index, all) =>
      all.findIndex(other => other.url === item.url) === index
  );
}

function buildScraperUrl(endpoint, link) {
  return (
    SCRAPER_BASE +
    endpoint +
    "?" +
    scraperQueryKey(endpoint) +
    "=" +
    encodeURIComponent(link)
  );
}

function parseVideoHeaders(video) {
  const raw = clean(video.header);

  let referer = "";
  let origin = "";

  if (raw.startsWith("http") && !raw.includes("|")) {
    return {
      referer: raw,
      origin
    };
  }

  for (const part of raw.split("|")) {
    const index = part.indexOf(":");

    if (index < 1) continue;

    const key = part.slice(0, index).trim().toLowerCase();
    const value = part.slice(index + 1).trim();

    if (
      ["referer", "referrer"].includes(key) &&
      value.startsWith("http")
    ) {
      referer = value;
    }

    if (key === "origin" && value.startsWith("http")) {
      origin = value;
    }
  }

  return { referer, origin };
}

/* -------------------- Oscar TV style quality -------------------- */

function getQualityInfo(value, url) {
  const source = clean(value);
  const combined = source + " " + clean(url);

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

function getFormat(url) {
  const value = clean(url).toLowerCase();

  if (/\.m3u8(?:$|[?#])/.test(value)) return "HLS";
  if (/\.mpd(?:$|[?#])/.test(value)) return "DASH";
  if (/\.mp4(?:$|[?#])/.test(value)) return "MP4";
  if (/\.mkv(?:$|[?#])/.test(value)) return "MKV";
  if (/\.webm(?:$|[?#])/.test(value)) return "WEBM";

  return "Direct";
}

function qualityRank(stream) {
  const resolution = Number(stream?.resolution) || 0;

  if (resolution > 0) return resolution;
  if (stream?.quality === "HD") return 700;

  return -1;
}

function createStream(url, server, quality, headers) {
  const info = getQualityInfo(quality, url);
  const format = getFormat(url);
  const emoji = getQualityEmoji(info.resolution);
  const serverName = clean(server) || PROVIDER_NAME;

  const details =
    "🎞️ " + info.quality +
    " · " + format +
    " · 🎬 " + PROVIDER_NAME +
    " · 🖥️ " + serverName +
    "\nmade by 👴🏻✌🏻⁵¹⁵";

  return {
    name: "\u200E" + emoji + " " + info.label,
    title: details,
    description: details,
    size: details,
    url,
    quality: info.quality,
    resolution: info.resolution,
    headers: headers || {}
  };
}

/* -------------------- Host extraction -------------------- */

async function extractHost(video, callback) {
  const link = clean(video.link);

  if (!/^https?:\/\//i.test(link)) return false;

  const host = hostOf(link);

  if (DEAD_HOSTS.some(item => host.includes(item))) {
    return false;
  }

  const server = getString(video, "server") || PROVIDER_NAME;
  const userAgent = getString(video, "useragent") || BROWSER_UA;
  const { referer, origin } = parseVideoHeaders(video);

  const cdnHeaders = {
    "User-Agent": userAgent,
    "Accept-Language": ACCEPT_LANGUAGE
  };

  if (origin) cdnHeaders.Origin = origin;

  const embedOrigin = "https://" + host + "/";
  const playReferer =
    referer && hostLabel(hostOf(referer)) === hostLabel(host)
      ? referer
      : embedOrigin;

  const playbackHeaders = {
    ...cdnHeaders,
    Referer: playReferer
  };

  if (DIRECT_FILE.test(link)) {
    callback(
      createStream(
        link,
        server,
        video.quality,
        playbackHeaders
      )
    );

    return true;
  }

  let embedHtml = "";

  try {
    const embed = await requestText(link, {
      headers: {
        ...cdnHeaders,
        ...(referer ? { Referer: referer } : {})
      }
    });

    embedHtml = embed.text;
  } catch (error) {
    log("Embed fetch failed:", host, error.message);
  }

  const rule = getHostRule(host);

  async function tryDirectEmbed() {
    if (!embedHtml) return false;

    const links = parseExtractedLinks(embedHtml);
    let found = false;

    for (const item of links) {
      callback(
        createStream(
          item.url,
          server,
          item.quality,
          playbackHeaders
        )
      );

      found = true;
    }

    return found;
  }

  if (!rule) {
    return tryDirectEmbed();
  }

  const [endpoint, method] = rule;
  let scraperBody = "";

  if (method === "POST" && embedHtml) {
    try {
      const body = new URLSearchParams({
        content: embedHtml,
        url: link
      }).toString();

      const result = await requestText(
        SCRAPER_BASE + endpoint,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": BROWSER_UA,
            "Referer": SCRAPER_BASE
          },
          body
        }
      );

      scraperBody = result.text;
    } catch (error) {
      log("POST scraper failed:", host, error.message);
    }
  }

  if (!scraperBody) {
    try {
      const result = await requestText(
        buildScraperUrl(endpoint, link),
        {
          headers: {
            "User-Agent": BROWSER_UA,
            "Referer": SCRAPER_BASE
          }
        }
      );

      scraperBody = result.text;
    } catch (error) {
      log("GET scraper failed:", host, error.message);
    }
  }

  const extracted = parseExtractedLinks(scraperBody);

  if (extracted.length) {
    for (const item of extracted) {
      callback(
        createStream(
          item.url,
          server,
          item.quality || video.quality,
          playbackHeaders
        )
      );
    }

    return true;
  }

  return tryDirectEmbed();
}

/* -------------------- Stream resolution -------------------- */

async function resolveVideo(video, callback) {
  const link = clean(video?.link);

  if (!link) return false;

  return extractHost(video, callback);
}

async function resolveAllVideos(videos) {
  if (!Array.isArray(videos) || !videos.length) {
    return [];
  }

  const streams = [];
  const seen = new Set();

  await mapLimit(videos, 4, async video => {
    let completed = false;

    const timer = new Promise(resolve =>
      setTimeout(() => resolve(false), SOURCE_TIMEOUT)
    );

    const task = resolveVideo(video, stream => {
      const key = stream.url.split("?")[0];

      if (seen.has(key)) return;

      seen.add(key);
      streams.push(stream);
      completed = true;
    });

    await Promise.race([
      task.catch(error => {
        log("Source extraction failed:", error.message);
        return false;
      }),
      timer
    ]);

    return completed;
  });

  streams.sort(
    (a, b) => qualityRank(b) - qualityRank(a)
  );

  log("Resolved streams:", streams.length);

  return streams;
}

/* -------------------- Nuvio entry point -------------------- */

async function getStreams(
  tmdbId,
  mediaType,
  season,
  episode
) {
  let stage = "validation";

  try {
    const type = clean(mediaType).toLowerCase();

    if (
      !tmdbId ||
      !["movie", "tv", "live"].includes(type)
    ) {
      log("Unsupported request:", tmdbId, mediaType);
      return [];
    }

    stage = "TMDB titles";

    const titles = type === "live"
      ? [clean(tmdbId)]
      : await getTmdbTitles(tmdbId, type);

    stage = "Egywatch search";

    const match = await findBestMatch(titles, type);

    if (!match) {
      log("No matching title:", titles);
      return [];
    }

    log(
      "Selected:",
      match.kind,
      match.title,
      "ID:",
      match.id,
      "score:",
      match.score
    );

    stage = "Content lookup";

    if (
      type === "tv" &&
      (season == null || episode == null)
    ) {
      log("TV request missing season or episode");
      return [];
    }

    const videos = await getContentVideos(
      match,
      season,
      episode,
      type
    );

    if (!videos.length) {
      log("No video entries found for selected content");
      return [];
    }

    stage = "Host extraction";

    return await resolveAllVideos(videos);
  } catch (error) {
    console.error(
      "[Egywatch] Failed at:",
      stage,
      "|",
      error?.message || String(error)
    );

    return [];
  }
}

module.exports = {
  getStreams
};
