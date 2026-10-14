"use strict";

/* ============================================================
 * .AI
 * ============================================================ */

const OSCAR_HOME = "https://ostv-11-11.xyz";
const HEADER_HELPER = "https://flech.tn/scrapefinal/dramabox/step1_prepare_oscar.php";
const TMDB_API_KEY = "09c002491851747716f94bd211a6681b";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const PLAY_UA = "TDMuaHLS99";
// Same as the Kotlin plugin: only the player UA, no Referer.
const PLAYBACK_HEADERS = { "User-Agent": PLAY_UA };

const TAG = "[Oscar]";
const REQUEST_TIMEOUT_MS = 12000;
const MAX_ATTEMPTS = 3;
const MIN_GAP_MS = 350;
const HEADER_TTL_MS = 15 * 1000;
const COOLDOWN_MS = 90 * 1000;
const MIN_MATCH_SCORE = 60;

const log = (...a) => { try { console.log(TAG, ...a); } catch (_) { /* ignore */ } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const snippet = t => String(t || "").replace(/\s+/g, " ").slice(0, 100);

/* ==================== HTTP core ==================== */

async function request(url, opts = {}) {
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS) : null;
    try {
        const res = await fetch(url, ctl ? { ...opts, signal: ctl.signal } : opts);
        const text = await res.text();
        return { status: res.status, ok: res.ok, text };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function makeError(msg, source, status, retry) {
    const e = new Error(msg);
    e.source = source;
    e.status = status || 0;
    e.retry = retry !== false;
    return e;
}

/* ---- serialized throttle ---- */
let gate = Promise.resolve();
let lastStart = 0;
function throttle(gap = MIN_GAP_MS) {
    const turn = gate.then(async () => {
        const wait = lastStart + gap - Date.now();
        if (wait > 0) await sleep(wait);
        lastStart = Date.now();
    });
    gate = turn.catch(() => {});
    return turn;
}

/* ---- tiny memo cache (also de-dupes concurrent calls) ---- */
const memoStore = new Map();
function memo(key, ttl, fn) {
    const hit = memoStore.get(key);
    if (hit && hit.exp > Date.now()) return hit.p;
    if (memoStore.size > 300) memoStore.delete(memoStore.keys().next().value);
    const p = Promise.resolve().then(fn);
    memoStore.set(key, { p, exp: Date.now() + ttl });
    p.catch(() => { if ((memoStore.get(key) || {}).p === p) memoStore.delete(key); });
    return p;
}

/* ==================== Signed headers (flech.tn helper) ==================== */

const DROP_HEADERS = /^(host|connection|content-length)$/i;
const headerCache = new Map();

function hasHeader(obj, name) {
    const n = name.toLowerCase();
    return Object.keys(obj).some(k => k.toLowerCase() === n);
}

async function getSignedHeaders(targetUrl, force) {
    const hit = headerCache.get(targetUrl);
    if (!force && hit && hit.exp > Date.now()) return { ...hit.headers };

    const r = await request(HEADER_HELPER, {
        method: "POST",
        headers: {
            "User-Agent": UA,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "url=" + encodeURIComponent(targetUrl),
    });
    if (!r.ok) {
        throw makeError(`helper HTTP ${r.status} :: ${snippet(r.text)}`, "helper", r.status, true);
    }

    let json;
    try { json = JSON.parse(r.text); }
    catch (_) { throw makeError(`helper returned non-JSON :: ${snippet(r.text)}`, "helper", r.status, true); }

    const src = json && json.headers;
    if (!src || typeof src !== "object") {
        throw makeError("helper returned no headers", "helper", r.status, true);
    }

    const headers = {};
    for (const [k, v] of Object.entries(src)) {
        if (v == null || DROP_HEADERS.test(k)) continue;
        headers[k] = String(v);
    }
    if (!hasHeader(headers, "user-agent")) headers["User-Agent"] = UA;
    if (!hasHeader(headers, "accept")) headers["Accept"] = "application/json, text/plain, */*";

    headerCache.set(targetUrl, { headers, exp: Date.now() + HEADER_TTL_MS });
    return { ...headers };
}

/* ==================== Oscar API call ==================== */

let blockedUntil = 0;

async function oscarCall(path) {
    if (Date.now() < blockedUntil) {
        throw makeError("cooling down after repeated 403/429", "cooldown", 403, false);
    }

    const url = OSCAR_HOME + "/" + String(path).replace(/^\/+/, "");
    let lastErr = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            if (attempt === 1) await throttle();
            else await sleep(700 * attempt + Math.random() * 400);

            const headers = await getSignedHeaders(url, attempt > 1);
            const r = await request(url, { method: "GET", headers, redirect: "follow" });

            if (r.status === 403 || r.status === 429 || r.status >= 500) {
                throw makeError(`api HTTP ${r.status} :: ${snippet(r.text)}`, "api", r.status, true);
            }
            if (!r.ok) throw makeError(`api HTTP ${r.status}`, "api", r.status, false);

            try { return JSON.parse(r.text); }
            catch (_) { throw makeError(`api returned non-JSON :: ${snippet(r.text)}`, "api", r.status, true); }
        } catch (e) {
            lastErr = e;
            const src = e.source || "net";
            log(`${src} error (attempt ${attempt}/${MAX_ATTEMPTS}) ${path} -> ${e.message}`);
            if (e.retry === false) throw e;
        }
    }

    if (lastErr && (lastErr.status === 403 || lastErr.status === 429)) {
        blockedUntil = Date.now() + COOLDOWN_MS;
        log(`blocked (${lastErr.source} ${lastErr.status}) -> pausing requests for ${COOLDOWN_MS / 1000}s`);
    }
    throw lastErr || makeError("all retries failed: " + url, "api", 0, false);
}

/* ==================== Helper functions ==================== */

function clean(v) { return String(v ?? "").trim(); }

function absoluteUrl(v, base = OSCAR_HOME) {
    const raw = clean(v);
    if (!raw || /^(data:|blob:|javascript:)/i.test(raw)) return "";
    try { return new URL(raw, base).href; } catch (_) { return ""; }
}

function getString(o, ...keys) {
    for (const k of keys) {
        const v = clean(o && o[k]);
        if (v && v !== "null" && v !== "undefined") return v;
    }
    return "";
}

function getNumber(o, ...keys) {
    for (const k of keys) {
        const n = Number(o && o[k]);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
}

function getDataObject(r) {
    const d = r && r.data;
    return d && !Array.isArray(d) && typeof d === "object" ? d : null;
}

function getDataArray(r) { return r && Array.isArray(r.data) ? r.data : []; }

/* ==================== TMDB ==================== */

async function fetchTmdbTitles(tmdbId, mediaType) {
    const type = mediaType === "tv" ? "tv" : "movie";
    const titles = [];
    let year = null;
    const add = v => {
        const t = clean(v);
        if (t && !titles.some(x => x.toLowerCase() === t.toLowerCase())) titles.push(t);
    };

    const langs = ["ar-SA", "en-US"];
    const results = await Promise.all(langs.map(async lang => {
        try {
            const url = `https://api.themoviedb.org/3/${type}/${encodeURIComponent(tmdbId)}?api_key=${TMDB_API_KEY}&language=${lang}`;
            const r = await request(url, { headers: { "User-Agent": UA } });
            if (!r.ok) throw new Error("HTTP " + r.status);
            return JSON.parse(r.text);
        } catch (e) {
            log("TMDB fail:", e.message);
            return null;
        }
    }));

    for (const data of results) {
        if (!data) continue;
        add(type === "tv" ? data.name : data.title);
        add(type === "tv" ? data.original_name : data.original_title);
        const d = clean(type === "tv" ? data.first_air_date : data.release_date);
        if (!year && /^\d{4}/.test(d)) year = Number(d.slice(0, 4));
    }
    return { titles, year };
}

function getTitles(tmdbId, mediaType) {
    return memo(`tmdb:${mediaType}:${tmdbId}`, 24 * 60 * 60 * 1000, () => fetchTmdbTitles(tmdbId, mediaType));
}

/* ==================== Search / matching ==================== */

function norm(s) {
    return String(s ?? "")
        .toLowerCase()
        .replace(/[\u064B-\u065F\u0670\u0640]/g, "")   // tashkeel + tatweel
        .replace(/[أإآٱ]/g, "ا")
        .replace(/ى/g, "ي")
        .replace(/ة/g, "ه")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
}

function titleScore(a, b) {
    const na = norm(a), nb = norm(b);
    if (!na || !nb) return 0;
    if (na === nb) return 100;
    if (na.startsWith(nb + " ") || nb.startsWith(na + " ")) return 85;
    const wa = new Set(na.split(" ")), wb = new Set(nb.split(" "));
    let common = 0;
    for (const w of wb) if (wa.has(w)) common++;
    const union = wa.size + wb.size - common;
    return union ? (common / union) * 80 : 0;
}

async function searchOscar(kind, query) {
    const prefix = kind === "movie" ? "api/movies" : kind === "anime" ? "api/anime" : "api/series";
    const path = `${prefix}/?page=1&limit=20&search=${encodeURIComponent(query)}`;
    const res = await memo("search:" + path, 10 * 60 * 1000, () => oscarCall(path));
    return getDataArray(res).map(item => {
        const id = getNumber(item, "id", "item_id");
        const names = ["title_ar", "title_en", "name", "series_title", "original_title"]
            .map(k => getString(item, k)).filter(Boolean);
        if (!id || !names.length) return null;
        let year = getNumber(item, "release_year");
        if (!year) {
            const d = getString(item, "release_date", "first_air_date");
            if (/^\d{4}/.test(d)) year = Number(d.slice(0, 4));
        }
        return { id, kind, title: names[0], names, year };
    }).filter(Boolean);
}

async function findBestMatch(titles, year, mediaType) {
    const kinds = mediaType === "movie" ? ["movie"] : ["series", "anime"];
    const seen = new Set();
    let best = null;
    let calls = 0, failures = 0, lastErr = null;

    for (const t of titles.slice(0, 3)) {
        const groups = await Promise.all(kinds.map(async k => {
            calls++;
            try { return await searchOscar(k, t); }
            catch (e) { failures++; lastErr = e; return []; }
        }));

        for (const r of [].concat(...groups)) {
            const key = r.kind + ":" + r.id;
            if (seen.has(key)) continue;
            seen.add(key);

            let score = 0;
            for (const n of r.names) for (const q of titles) score = Math.max(score, titleScore(n, q));
            if (year && r.year && Math.abs(year - r.year) > 1) score -= 25;

            if (!best || score > best.score) best = { ...r, score };
        }
        if (best && best.score >= 88) break;   // confident match, stop searching
    }

    if (!best && calls > 0 && failures === calls && lastErr) throw lastErr;
    return best && best.score >= MIN_MATCH_SCORE ? best : null;
}

/* ==================== Stream extraction ==================== */

async function resolveSpecialHost(url) {
    if (!url.includes("newcdn.seriesmp4.com")) return url;
    try {
        const r = await request(url, { headers: { "User-Agent": PLAY_UA }, redirect: "follow" });
        if (!r.ok) return "";
        const m = r.text.match(/src=["'](https:\/\/downloader\.disk\.yandex\.ru[^"']+)["']/i);
        return m ? m[1].replace(/&amp;/g, "&") : "";
    } catch (_) { return ""; }
}

function getFormat(u) {
    const v = u.toLowerCase();
    if (/\.m3u8/.test(v)) return "HLS";
    if (/\.mpd/.test(v)) return "DASH";
    if (/\.mp4/.test(v)) return "MP4";
    return "Direct";
}

function getQualityInfo(q, u) {
    const s = (q + " " + u).toLowerCase();
    const m = s.match(/(2160|1440|1080|720|576|540|480|360)p/);
    const r = m ? +m[1] : 0;
    return { r, label: r ? r + "p" : "Auto" };
}

function qEmoji(r) {
    if (r >= 2160) return "🏆";
    if (r >= 1440) return "💎";
    if (r >= 1080) return "⚡";
    if (r >= 720) return "🔥";
    if (r >= 480) return "💫";
    return "❔";
}

async function extractStreams(detail) {
    const cands = [];
    for (const i of (detail && detail.watch_links) || [])
        cands.push({ url: getString(i, "url"), quality: getString(i, "quality") });
    for (const i of (detail && detail.download_links) || [])
        cands.push({ url: getString(i, "url"), quality: getString(i, "quality") });

    const resolved = await Promise.all(cands.map(async c => {
        const u = absoluteUrl(c.url);
        if (!/^https?:\/\//i.test(u)) return null;
        const final = await resolveSpecialHost(u);
        return final ? { url: final, quality: c.quality } : null;
    }));

    const out = [], seen = new Set();
    for (const c of resolved) {
        if (!c || seen.has(c.url)) continue;
        seen.add(c.url);
        const fmt = getFormat(c.url);
        const qi = getQualityInfo(c.quality, c.url);
        out.push({
            name: "\u200E" + qEmoji(qi.r) + " " + qi.label,
            title: " " + qi.label + " · " + fmt + " · Oscar TV\nmade by ✌⁵¹⁵",
            description: " " + qi.label + " · " + fmt + " · Oscar TV\nmade by ✌⁵¹⁵",
            url: c.url,
            quality: qi.label,
            resolution: qi.r,
            headers: { ...PLAYBACK_HEADERS },
        });
    }
    out.sort((a, b) => (b.resolution || 0) - (a.resolution || 0));
    return out;
}

/* ==================== Loaders ==================== */

async function getMovieStreams(match) {
    const res = await oscarCall("api/movies/show.php?id=" + encodeURIComponent(match.id));
    const d = getDataObject(res);
    return d ? extractStreams(d) : [];
}

async function getEpisodeStreams(match, season, episode) {
    const isAnime = match.kind === "anime";
    const base = isAnime ? "api/anime" : "api/series";
    const TTL = 10 * 60 * 1000;

    const show = getDataObject(await memo(`show:${match.kind}:${match.id}`, TTL,
        () => oscarCall(`${base}/show.php?id=${match.id}`)));
    if (!show) return [];

    const ws = Number(season) || 1;
    const we = Number(episode);
    if (!Number.isFinite(we)) return [];

    const seasons = Array.isArray(show.seasons) ? show.seasons : [];
    const seasonNo = s => Number(s.season_number) || 1;

    let sel = seasons.filter(s => seasonNo(s) === ws);
    if (!sel.length && seasons.length === 1 && ws === 1) sel = seasons;   // single-season shows
    if (!sel.length) return [];

    const eps = [];
    for (const s of sel) {
        const sid = getNumber(s, "season_id", "id");
        if (!sid) continue;
        const path = isAnime ? `api/anime/episodes/?season_id=${sid}` : `api/episodes/?season_id=${sid}`;
        const arr = getDataArray(await memo("eps:" + path, TTL, () => oscarCall(path)));
        arr.forEach((e, i) => {
            const id = getNumber(e, "id");
            if (id) eps.push({ id, number: getNumber(e, "episode_number") || i + 1 });
        });
    }

    const target = eps.find(e => e.number === we);
    if (!target) return [];

    const detailPath = isAnime ? "api/anime/episodes/show.php" : "api/episodes/show.php";
    const d = getDataObject(await oscarCall(`${detailPath}?id=${target.id}`));
    return d ? extractStreams(d) : [];
}

/* ==================== Nuvio entry ==================== */

async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        if (!tmdbId || !["movie", "tv"].includes(mediaType)) return [];

        const { titles, year } = await getTitles(tmdbId, mediaType);
        if (!titles.length) return [];

        const match = await memo(`match:${mediaType}:${tmdbId}`, 6 * 60 * 60 * 1000,
            () => findBestMatch(titles, year, mediaType));
        if (!match) { log("no match for", titles[0]); return []; }

        log(`match: ${match.kind} #${match.id} "${match.title}" (${Math.round(match.score)})`);

        if (mediaType === "movie") return await getMovieStreams(match);
        if (episode == null) return [];
        return await getEpisodeStreams(match, season, episode);
    } catch (e) {
        log(`fatal [${e.source || "net"}]:`, e.message);
        return [];
    }
}

module.exports = { getStreams };
