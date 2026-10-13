"use strict";

/**
 * This project is just a test made by AI
 * Z3ter Provider - AlooyTV
 * Nuvio contract: getStreams(tmdbId, mediaType, season, episode)
 *
 * Source logic adapted from:
 * mo7AmMeD64/cs-ar/Alooytv
 *
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
  ).replace(/\s+/g, " ").trim();
}

function getAttribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(
    new RegExp("\\b" + escaped + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i")
  );

  return match
    ? decodeHtml(match[1] || match[2] || match[3] || "")
    : "";
}

function absoluteUrl(url, base) {
  const value = decodeHtml(String(url || "").trim());

  if (!value) return "";
  if (/^(https?:)?\/\//i.test(value)) {
    return value.startsWith("//") ? "https:" + value : value;
  }

  if (/^(data:|blob:|javascript:)/i.test(value)) return "";

  if (value.startsWith("/")) {
    const origin = String(base).match(/^https?:\/\/[^/]+/i);
    return origin ? origin[0] + value : "";
  }

  return String(base).replace(/\/+$/, "") + "/" + value.replace(/^\/+/, "");
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/json,*/*",
      "Accept-Language": "ar,en;q=0.9",
      ...(options.headers || {})
    },
    body: options.body,
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

/**
 * Small HTML tokenizer.
 * Keeps parent/child relationships so search results can be limited to
 * direct children of .movie-container, matching the original provider.
 */
function parseHtml(html) {
  const nodes = [];
  const stack = [];
  const tokenPattern = /<!--[\s\S]*?-->|<![^>]*>|<\/?[a-zA-Z][^>]*>/g;
  const voidTags = new Set([
    "area", "base", "br", "col", "embed", "hr", "img",
    "input", "link", "meta", "param", "source", "track", "wbr"
  ]);

  let match;

  while ((match = tokenPattern.exec(String(html || ""))) !== null) {
    const token = match[0];

    if (token.startsWith("<!--") || token.startsWith("<!")) continue;

    const closing = /^<\//.test(token);
    const tagMatch = token.match(/^<\/?([a-zA-Z][\w:-]*)/);
    if (!tagMatch) continue;

    const tag = tagMatch[1].toLowerCase();

    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          const node = stack[i];
          node.end = tokenPattern.lastIndex;
          node.inner = String(html).slice(node.openEnd, match.index);
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

  const htmlLength = String(html || "").length;

  for (const node of stack) {
    node.end = htmlLength;
    node.inner = String(html).slice(node.openEnd);
  }

  return nodes;
}

function hasClass(node, className) {
  const classes = getAttribute(node.attrs, "class").split(/\s+/);
  return classes.includes(className);
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
  return absoluteUrl(getAttribute(node.attrs, attribute), base);
}

async function getAlooyDomain() {
  if (cachedDomain) return cachedDomain;

  try {
    const result = await fetchText(ALOOY_HOME);
    const links = result.text.match(/<a\b[^>]*>/gi) || [];

    for (const link of links) {
      const href = getAttribute(link, "href");

      if (/alooytv/i.test(href) && /\.xyz(?:[/:?#]|$)/i.test(href)) {
        const absolute = absoluteUrl(href, result.url);
        const match = absolute.match(/^(https?:\/\/[^/]+)/i);

        if (match) {
          cachedDomain = match[1];
          return cachedDomain;
        }
      }
    }
  } catch (_) {
    // Use the same fallback domain as the original CloudStream provider.
  }

  cachedDomain = ALOOY_FALLBACK;
  return cachedDomain;
}

function normalizeTitle(value) {
  return stripTags(value)
    .toLowerCase()
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function titleFromTmdbPage(html) {
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of metaTags) {
    const property = getAttribute(tag, "property").toLowerCase();
    const name = getAttribute(tag, "name").toLowerCase();

    if (property === "og:title" || name === "title") {
      const value = getAttribute(tag, "content")
        .replace(/\s*[|·]\s*The Movie Database.*$/i, "")
        .replace(/\s*-\s*The Movie Database.*$/i, "")
        .trim();

      if (value) return value;
    }
  }

  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!titleMatch) return "";

  return stripTags(titleMatch[1])
    .replace(/\s*[|·]\s*The Movie Database.*$/i, "")
    .replace(/\s*-\s*The Movie Database.*$/i, "")
    .trim();
}

async function getTmdbTitle(tmdbId, mediaType) {
  const type = mediaType === "tv" ? "tv" : "movie";
  const url =
    "https://www.themoviedb.org/" +
    type + "/" + encodeURIComponent(String(tmdbId)) +
    "?language=en-US";

  const result = await fetchText(url);
  const title = titleFromTmdbPage(result.text);

  if (!title) {
    throw new Error("Could not resolve TMDB title");
  }

  return title;
}

function parseSearchResults(html, domain) {
  const nodes = parseHtml(html);
  const containers = nodes.filter(
    node => node.tag === "div" && hasClass(node, "movie-container")
  );

  const results = [];

  for (const container of containers) {
    for (const card of container.children || []) {
      if (card.tag !== "div") continue;

      const cardNodes = [card, ...descendants(card, () => true)];

      const anchor = firstNode(
        cardNodes,
        node =>
          node.tag === "a" &&
          cardNodes.some(
            candidate =>
              candidate.tag === "h3" &&
              candidate.parent &&
              hasClass(candidate.parent, "movie-title") &&
              descendants(candidate.parent, n => n === node).length > 0
          )
      );

      // Fallback to the actual selector structure used by AlooyTV:
      // .movie-title h3 a
      let titleAnchor = anchor;

      if (!titleAnchor) {
        const titleBox = firstNode(
          cardNodes,
          node => node.tag === "div" && hasClass(node, "movie-title")
        );

        if (titleBox) {
          const heading = firstNode(
            descendants(titleBox, () => true),
            node => node.tag === "h3"
          );

          if (heading) {
            titleAnchor = firstNode(
              descendants(heading, () => true),
              node => node.tag === "a"
            );
          }
        }
      }

      if (!titleAnchor) continue;

      const title = nodeText(titleAnchor);
      const url = getNodeUrl(titleAnchor, "href", domain);

      if (!title || !url) continue;

      const image = firstNode(
        cardNodes,
        node => node.tag === "img" && hasClass(node, "lazy")
      );

      const poster = image
        ? absoluteUrl(
            getAttribute(image.attrs, "data-src") ||
            getAttribute(image.attrs, "src"),
            domain
          )
        : "";

      results.push({ title, url, poster });
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
      const targetWords = target.split(" ").filter(Boolean);
      const candidateWords = new Set(candidate.split(" ").filter(Boolean));

      const common = targetWords.filter(word => candidateWords.has(word));
      score = targetWords.length
        ? (common.length / targetWords.length) * 60
        : 0;
    }

    if (score > bestScore) {
      best = result;
      bestScore = score;
    }
  }

  // Avoid selecting an unrelated title just because it was the closest.
  return bestScore >= 45 ? best : null;
}

async function searchAlooy(title, domain) {
  const url = domain + "/search?q=" + encodeURIComponent(title);
  const result = await fetchText(url);
  return parseSearchResults(result.text, domain);
}

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
  const result = await fetchText(seriesUrl);
  const nodes = parseHtml(result.text);

  const episodeLinks = nodes.filter(
    node => node.tag === "a" && hasClass(node, "btn-ep")
  );

  if (!episodeLinks.length) return seriesUrl;

  const wantedEpisode = Number(episode);
  const wantedSeason = Number(season);

  const candidates = episodeLinks.map(node => ({
    label: nodeText(node),
    url: getNodeUrl(node, "href", result.url)
  })).filter(item => item.url);

  let matches = candidates.filter(
    item => getEpisodeNumber(item.label) === wantedEpisode
  );

  if (matches.length === 1) return matches[0].url;

  // Some pages include season information in the episode label.
  if (matches.length > 1 && Number.isFinite(wantedSeason)) {
    const seasonMatches = matches.filter(item => {
      const text = normalizeTitle(item.label);
      return (
        text.includes("season " + wantedSeason) ||
        text.includes("الموسم " + wantedSeason) ||
        text.includes("موسم " + wantedSeason)
      );
    });

    if (seasonMatches.length === 1) return seasonMatches[0].url;
  }

  // Do not silently play a different episode when the match is ambiguous.
  if (matches.length > 1) {
    throw new Error("Multiple episodes match episode " + wantedEpisode);
  }

  // No exact episode label was found. If there's only one link, it is safe
  // to use; otherwise avoid guessing which episode the user requested.
  if (candidates.length === 1) return candidates[0].url;

  throw new Error("Requested episode was not found on the series page");
}

async function extractStreams(pageUrl, domain) {
  const result = await fetchText(pageUrl);
  const nodes = parseHtml(result.text);

  const sources = nodes.filter(node => node.tag === "source");
  const streams = [];

  for (const source of sources) {
    const parent = source.parent;

    // Match the original selector: video source
    if (!parent || parent.tag !== "video") continue;

    const url = absoluteUrl(
      getAttribute(source.attrs, "src"),
      result.url
    );

    if (!url || !/^https?:\/\//i.test(url)) continue;

    const type = getAttribute(source.attrs, "type").toLowerCase();
    const lowerUrl = url.toLowerCase();

    let quality = "auto";
    if (/1080/.test(lowerUrl)) quality = "1080p";
    else if (/720/.test(lowerUrl)) quality = "720p";
    else if (/480/.test(lowerUrl)) quality = "480p";

    streams.push({
      name: PROVIDER_NAME + " - AlooyTV",
      title: "AlooyTV | " + quality,
      url,
      quality,
      headers: {
        Referer: domain + "/",
        "User-Agent": USER_AGENT
      }
    });
  }

  // Remove duplicate stream URLs.
  return streams.filter(
    (stream, index, all) =>
      all.findIndex(item => item.url === stream.url) === index
  );
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    if (!tmdbId || !["movie", "tv"].includes(mediaType)) return [];

    const domain = await getAlooyDomain();
    const title = await getTmdbTitle(tmdbId, mediaType);
    const results = await searchAlooy(title, domain);
    const match = chooseBestResult(results, title);

    if (!match) {
      console.log("[Z3ter Provider] AlooyTV title not found:", title);
      return [];
    }

    let playbackPage = match.url;

    if (mediaType === "tv") {
      if (episode == null) return [];

      playbackPage = await getEpisodeUrl(
        match.url,
        season,
        episode
      );
    }

    return await extractStreams(playbackPage, domain);
  } catch (error) {
    console.error(
      "[Z3ter Provider] AlooyTV error:",
      error && error.message ? error.message : String(error)
    );

    return [];
  }
}

module.exports = { getStreams };
