
"use strict";

/**
 ©© This project is just a test made by AI
 * Z3ter Provider - AlooyTV
 * Nuvio contract: getStreams(tmdbId, mediaType, season, episode)
 *
 * Adapted from:
 * https://github.com/mo7AmMeD64/cs-ar/tree/main/Alooytv
 *
 * Supports Arabic and English title searches.
 * Uses global fetch. No Node.js built-ins or external packages.
 */

const PROVIDER_NAME = "Z3ter Provider";
const ALOOY_HOME = "https://fitnur.com/alooytv";
const ALOOY_FALLBACK = "https://n.alooytv14.xyz";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

let cachedDomain = null;

/* -------------------- HTML utilities -------------------- */

function decodeHtml(value) {
  return String(value || "")
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
    .replace(/&nbsp;/gi, " ");
}

function stripTags(value) {
  return decodeHtml(
    String(value || "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]*>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function getAttribute(tag, name) {
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

function absoluteUrl(url, base) {
  const value = decodeHtml(String(url || "").trim());

  if (!value) return "";

  if (/^(https?:)?\/\//i.test(value)) {
    return value.startsWith("//")
      ? "https:" + value
      : value;
  }

  if (/^(data:|blob:|javascript:)/i.test(value)) {
    return "";
  }

  try {
    return new URL(value, base).href;
  } catch (_) {
    return "";
  }
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "User-Agent": USER_AGENT,
      "Accept":
        "text/html,application/xhtml+xml,application/json,*/*",
      "Accept-Language": "ar,en;q=0.9",
      ...(options.headers || {})
    },
    body: options.body,
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(
      "HTTP " + response.status + " for " + url
    );
  }

  return {
    text: await response.text(),
    url: response.url || url,
    contentType: response.headers.get("content-type") || ""
  };
}

/* -------------------- HTML parser -------------------- */

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
          const node = stack[i];

          node.end = tokenPattern.lastIndex;
          node.inner = source.slice(node.openEnd, match.index);

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
      parent: stack.length
        ? stack[stack.length - 1]
        : null,
      children: []
    };

    if (node.parent) {
      node.parent.children.push(node);
    }

    nodes.push(node);

    if (
      !voidTags.has(tag) &&
      !/\/\s*>$/.test(token)
    ) {
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
      if (predicate(child)) {
        found.push(child);
      }

      visit(child);
    }
  }

  visit(node);
  return found;
}

function innerHtml(node) {
  return node && node.inner ? node.inner : "";
}

function nodeText(node) {
  return stripTags(innerHtml(node));
}

function firstNode(nodes, predicate) {
  return nodes.find(predicate) || null;
}

function getNodeUrl(node, attribute, base) {
  return absoluteUrl(
    getAttribute(node.attrs, attribute),
    base
  );
}

/* -------------------- AlooyTV domain -------------------- */

async function getAlooyDomain() {
  if (cachedDomain) return cachedDomain;

  try {
    const result = await fetchText(ALOOY_HOME);
    const links = result.text.match(/<a\b[^>]*>/gi) || [];

    for (const link of links) {
      const href = getAttribute(link, "href");

      if (
        /alooytv/i.test(href) &&
        /\.xyz(?:[/:?#]|$)/i.test(href)
      ) {
        const absolute = absoluteUrl(href, result.url);
        const match = absolute.match(
          /^(https?:\/\/[^/]+)/i
        );

        if (match) {
          cachedDomain = match[1];

          console.log(
            "[Z3ter] Discovered AlooyTV domain:",
            cachedDomain
          );

          return cachedDomain;
        }
      }
    }
  } catch (error) {
    console.error(
      "[Z3ter] Domain discovery failed:",
      error && error.message
        ? error.message
        : String(error)
    );
  }

  cachedDomain = ALOOY_FALLBACK;

  console.log(
    "[Z3ter] Using fallback domain:",
    cachedDomain
  );

  return cachedDomain;
}

/* -------------------- TMDB titles -------------------- */

function titleFromTmdbPage(html) {
  const metaTags = String(html || "")
    .match(/<meta\b[^>]*>/gi) || [];

  for (const tag of metaTags) {
    const property =
      getAttribute(tag, "property").toLowerCase();

    const name =
      getAttribute(tag, "name").toLowerCase();

    if (property === "og:title" || name === "title") {
      const value = getAttribute(tag, "content")
        .replace(
          /\s*[|·]\s*The Movie Database.*$/i,
          ""
        )
        .replace(
          /\s*-\s*The Movie Database.*$/i,
          ""
        )
        .trim();

      if (value) return value;
    }
  }

  const titleMatch = String(html || "").match(
    /<title\b[^>]*>([\s\S]*?)<\/title>/i
  );

  if (!titleMatch) return "";

  return stripTags(titleMatch[1])
    .replace(
      /\s*[|·]\s*The Movie Database.*$/i,
      ""
    )
    .replace(
      /\s*-\s*The Movie Database.*$/i,
      ""
    )
    .trim();
}

async function getTmdbTitles(tmdbId, mediaType) {
  const type = mediaType === "tv" ? "tv" : "movie";
  const languages = ["ar-SA", "en-US"];
  const titles = [];

  for (const language of languages) {
    const url =
      "https://www.themoviedb.org/" +
      type + "/" +
      encodeURIComponent(String(tmdbId)) +
      "?language=" + language;

    try {
      const result = await fetchText(url);
      const title = titleFromTmdbPage(result.text);

      if (
        title &&
        !titles.some(
          existing =>
            existing.toLowerCase() === title.toLowerCase()
        )
      ) {
        titles.push(title);
      }

      console.log(
        "[Z3ter] TMDB title (" + language + "):",
        title || "(empty)"
      );
    } catch (error) {
      console.error(
        "[Z3ter] TMDB lookup failed (" + language + "):",
        error && error.message
          ? error.message
          : String(error)
      );
    }
  }

  if (!titles.length) {
    throw new Error(
      "Could not resolve any TMDB title"
    );
  }

  return titles;
}

/* -------------------- Search and matching -------------------- */

function normalizeTitle(value) {
  return stripTags(value)
    .toLowerCase()
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function parseSearchResults(html, domain) {
  const nodes = parseHtml(html);

  const containers = nodes.filter(
    node =>
      node.tag === "div" &&
      hasClass(node, "movie-container")
  );

  const results = [];

  for (const container of containers) {
    for (const card of container.children || []) {
      if (card.tag !== "div") continue;

      const cardNodes = [
        card,
        ...descendants(card, () => true)
      ];

      const titleBox = firstNode(
        cardNodes,
        node =>
          node.tag === "div" &&
          hasClass(node, "movie-title")
      );

      if (!titleBox) continue;

      const heading = firstNode(
        descendants(titleBox, () => true),
        node => node.tag === "h3"
      );

      if (!heading) continue;

      const anchor = firstNode(
        descendants(heading, () => true),
        node => node.tag === "a"
      );

      if (!anchor) continue;

      const title = nodeText(anchor);
      const url = getNodeUrl(
        anchor,
        "href",
        domain
      );

      if (!title || !url) continue;

      const image = firstNode(
        cardNodes,
        node =>
          node.tag === "img" &&
          hasClass(node, "lazy")
      );

      const poster = image
        ? absoluteUrl(
            getAttribute(image.attrs, "data-src") ||
            getAttribute(image.attrs, "src"),
            domain
          )
        : "";

      results.push({
        title,
        url,
        poster
      });
    }
  }

  return results;
}

function chooseBestResult(results, targetTitle) {
  const target = normalizeTitle(targetTitle);

  if (!target) return null;

  let best = null;
  let bestScore = 0;

  for (const result of results) {
    const candidate = normalizeTitle(result.title);

    if (!candidate) continue;

    let score = 0;

    if (candidate === target) {
      score = 100;
    } else if (
      candidate.startsWith(target) ||
      target.startsWith(candidate)
    ) {
      score = 75;
    } else {
      const targetWords = target
        .split(" ")
        .filter(Boolean);

      const candidateWords = new Set(
        candidate.split(" ").filter(Boolean)
      );

      const common = targetWords.filter(
        word => candidateWords.has(word)
      );

      score = targetWords.length
        ? (common.length / targetWords.length) * 60
        : 0;
    }

    if (score > bestScore) {
      best = result;
      bestScore = score;
    }
  }

  return bestScore >= 45 ? best : null;
}

async function searchAlooy(title, domain) {
  const url =
    domain +
    "/search?q=" +
    encodeURIComponent(title);

  const result = await fetchText(url);

  return parseSearchResults(
    result.text,
    result.url || domain
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

    if (match) {
      return Number(match[1]);
    }
  }

  return null;
}

async function getEpisodeUrl(
  seriesUrl,
  season,
  episode
) {
  const result = await fetchText(seriesUrl);
  const nodes = parseHtml(result.text);

  const episodeLinks = nodes.filter(
    node =>
      node.tag === "a" &&
      hasClass(node, "btn-ep")
  );

  if (!episodeLinks.length) {
    console.log(
      "[Z3ter] No episode links found; using series page."
    );

    return seriesUrl;
  }

  const wantedEpisode = Number(episode);

  const candidates = episodeLinks
    .map(node => ({
      label: nodeText(node),
      url: getNodeUrl(
        node,
        "href",
        result.url || seriesUrl
      )
    }))
    .filter(item => item.url);

  console.log(
    "[Z3ter] Episode links found:",
    candidates.length
  );

  let matches = candidates.filter(
    item =>
      getEpisodeNumber(item.label) === wantedEpisode
  );

  if (matches.length === 1) {
    return matches[0].url;
  }

  const wantedSeason = Number(season);

  if (
    matches.length > 1 &&
    Number.isFinite(wantedSeason)
  ) {
    const seasonMatches = matches.filter(item => {
      const text = normalizeTitle(item.label);

      return (
        text.includes("season " + wantedSeason) ||
        text.includes("الموسم " + wantedSeason) ||
        text.includes("موسم " + wantedSeason)
      );
    });

    if (seasonMatches.length === 1) {
      return seasonMatches[0].url;
    }
  }

  if (matches.length > 1) {
    throw new Error(
      "Multiple links match episode " +
      wantedEpisode
    );
  }

  if (candidates.length === 1) {
    return candidates[0].url;
  }

  throw new Error(
    "Requested episode " +
    wantedEpisode +
    " was not found"
  );
}

/* -------------------- Stream extraction -------------------- */

async function extractStreams(pageUrl, domain) {
  const result = await fetchText(pageUrl);
  const nodes = parseHtml(result.text);

  const sources = nodes.filter(
    node => node.tag === "source"
  );

  const streams = [];

  console.log(
    "[Z3ter] Source elements found:",
    sources.length
  );

  for (const source of sources) {
    const parent = source.parent;

    // Match the original CloudStream selector:
    // video source
    if (!parent || parent.tag !== "video") {
      continue;
    }

    const url = absoluteUrl(
      getAttribute(source.attrs, "src"),
      result.url || pageUrl
    );

    if (!url || !/^https?:\/\//i.test(url)) {
      continue;
    }

    const type = getAttribute(
      source.attrs,
      "type"
    ).toLowerCase();

    const lowerUrl = url.toLowerCase();

    let quality = "auto";

    if (/1080/.test(lowerUrl)) {
      quality = "1080p";
    } else if (/720/.test(lowerUrl)) {
      quality = "720p";
    } else if (/480/.test(lowerUrl)) {
      quality = "480p";
    }

    let format = "";

    if (
      /\.m3u8(?:$|[?#])/i.test(url) ||
      type.includes("mpegurl")
    ) {
      format = "HLS";
    } else if (
      /\.mpd(?:$|[?#])/i.test(url) ||
      type.includes("dash")
    ) {
      format = "DASH";
    } else if (
      /\.mp4(?:$|[?#])/i.test(url) ||
      type.includes("mp4")
    ) {
      format = "MP4";
    }

    streams.push({
      name: PROVIDER_NAME + " - AlooyTV",
      title:
        "AlooyTV | " +
        quality +
        (format ? " | " + format : ""),
      url,
      quality,
      headers: {
        Referer: domain + "/",
        "User-Agent": USER_AGENT
      }
    });
  }

  const uniqueStreams = streams.filter(
    (stream, index, all) =>
      all.findIndex(
        item => item.url === stream.url
      ) === index
  );

  console.log(
    "[Z3ter] Valid streams extracted:",
    uniqueStreams.length
  );

  return uniqueStreams;
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
    if (
      !tmdbId ||
      !["movie", "tv"].includes(mediaType)
    ) {
      console.log(
        "[Z3ter] Invalid input:",
        { tmdbId, mediaType, season, episode }
      );

      return [];
    }

    stage = "domain discovery";

    const domain = await getAlooyDomain();

    console.log(
      "[Z3ter] Active domain:",
      domain
    );

    stage = "TMDB title lookup";

    const titles = await getTmdbTitles(
      tmdbId,
      mediaType
    );

    console.log(
      "[Z3ter] Titles to search:",
      titles
    );

    let match = null;
    let matchedTitle = "";

    stage = "AlooyTV search";

    for (const title of titles) {
      console.log(
        "[Z3ter] Searching:",
        title
      );

      const results = await searchAlooy(
        title,
        domain
      );

      console.log(
        "[Z3ter] Search results for",
        title + ":",
        results.length
      );

      const candidate = chooseBestResult(
        results,
        title
      );

      if (candidate) {
        match = candidate;
        matchedTitle = title;
        break;
      }
    }

    if (!match) {
      console.log(
        "[Z3ter] No matching title found on AlooyTV."
      );

      return [];
    }

    console.log(
      "[Z3ter] Selected title:",
      match.title
    );

    console.log(
      "[Z3ter] Matched using:",
      matchedTitle
    );

    console.log(
      "[Z3ter] Content page:",
      match.url
    );

    let playbackPage = match.url;

    if (mediaType === "tv") {
      stage = "episode selection";

      if (episode == null) {
        console.log(
          "[Z3ter] TV request is missing the episode number."
        );

        return [];
      }

      playbackPage = await getEpisodeUrl(
        match.url,
        season,
        episode
      );

      console.log(
        "[Z3ter] Selected episode page:",
        playbackPage
      );
    }

    stage = "stream extraction";

    const streams = await extractStreams(
      playbackPage,
      domain
    );

    console.log(
      "[Z3ter] Finished. Stream count:",
      streams.length
    );

    return streams;
  } catch (error) {
    console.error(
      "[Z3ter] Failed at stage:",
      stage,
      "| Error:",
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
    
