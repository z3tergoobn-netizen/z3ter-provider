"use strict";

const OSCAR_HOME = "https://ostv-11-11.xyz";
const HEADER_HELPER = "https://flech.tn/scrapefinal/dramabox/step1_prepare_oscar.php";
const TMDB_API_KEY = "09c002491851747716f94bd211a6681b";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const PLAY_UA = "TDMuaHLS99";

/* ==================== Cookie Jar (محاكاة OkHttpClient) ==================== */
const cookieJar = new Map();

function parseSetCookie(header, host) {
    if (!header) return;
    const jar = cookieJar.get(host) || {};
    header.split(/,(?=[^ ;]+=)/).forEach(part => {
        const [pair] = part.split(";");
        const idx = pair.indexOf("=");
        if (idx > 0) {
            const k = pair.slice(0, idx).trim();
            const v = pair.slice(idx + 1).trim();
            if (k && v) jar[k] = v;
        }
    });
    cookieJar.set(host, jar);
}

function getCookieHeader(host) {
    const jar = cookieJar.get(host);
    if (!jar) return "";
    return Object.entries(jar).map(([k, v]) => k + "=" + v).join("; ");
}

/* ==================== Throttle ==================== */
const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastReq = 0;
async function throttle(gap = 300) {
    const wait = lastReq + gap - Date.now();
    if (wait > 0) await sleep(wait);
    lastReq = Date.now();
}

/* ==================== Header Cache (20s فقط) ==================== */
const headerCache = new Map();
const HEADER_TTL = 20 * 1000;

async function getFreshHeaders(targetUrl) {
    const cached = headerCache.get(targetUrl);
    if (cached && cached.expires > Date.now()) return cached.headers;

    const res = await fetch(HEADER_HELPER, {
        method: "POST",
        headers: {
            "User-Agent": UA,
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json, text/plain, */*",
            "Origin": "https://flech.tn",
            "Referer": "https://flech.tn/",
        },
        body: "url=" + encodeURIComponent(targetUrl),
    });
    if (!res.ok) throw new Error("Header helper HTTP " + res.status);

    const json = await res.json();
    const src = json?.headers;
    if (!src || typeof src !== "object") throw new Error("No headers from helper");

    const headers = {};
    for (const [k, v] of Object.entries(src)) {
        if (v == null) continue;
        if (/^(host|connection|content-length)$/i.test(k)) continue;
        headers[k] = String(v);
    }
    headers["User-Agent"] = headers["User-Agent"] || UA;
    headers["Accept"] = headers["Accept"] || "application/json, text/plain, */*";

    headerCache.set(targetUrl, { headers, expires: Date.now() + HEADER_TTL });
    return headers;
}

/* ==================== Oscar API Call (3 Retries + Cookies) ==================== */
async function oscarCall(path) {
    const url = OSCAR_HOME + "/" + String(path).replace(/^\/+/, "");

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            await throttle(attempt === 0 ? 200 : 900);

            // في المحاولات اللاحقة: نجبر جلب رؤوس جديدة
            if (attempt > 0) headerCache.delete(url);

            const headers = await getFreshHeaders(url);
            headers["Referer"] = OSCAR_HOME + "/";
            headers["Origin"] = OSCAR_HOME;

            const ck = getCookieHeader("ostv-11-11.xyz");
            if (ck) headers["Cookie"] = ck;

            const res = await fetch(url, { headers, redirect: "follow" });
            parseSetCookie(res.headers.get("set-cookie"), "ostv-11-11.xyz");

            if (res.status === 403) {
                console.log(`[Oscar] 403 attempt ${attempt + 1}, refreshing...`);
                continue;
            }
            if (!res.ok) throw new Error("HTTP " + res.status);
            return res.json();
        } catch (e) {
            console.log(`[Oscar] attempt ${attempt + 1} failed: ${e.message}`);
            if (attempt === 2) throw e;
        }
    }
    throw new Error("All retries failed: " + url);
}

/* ==================== Helper Functions ==================== */
function clean(v) { return String(v ?? "").trim(); }
function absoluteUrl(v, base = OSCAR_HOME) {
    const raw = clean(v);
    if (!raw || /^(data:|blob:|javascript:)/i.test(raw)) return "";
    try { return new URL(raw, base).href; } catch { return ""; }
}
function getString(o, ...keys) {
    for (const k of keys) {
        const v = clean(o?.[k]);
        if (v && v !== "null" && v !== "undefined") return v;
    }
    return "";
}
function getNumber(o, ...keys) {
    for (const k of keys) {
        const n = Number(o?.[k]);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
}
function getDataObject(r) {
    const d = r?.data;
    return d && !Array.isArray(d) && typeof d === "object" ? d : null;
}
function getDataArray(r) { return Array.isArray(r?.data) ? r.data : []; }

/* ==================== TMDB ==================== */
async function getTitles(tmdbId, mediaType) {
    const type = mediaType === "tv" ? "tv" : "movie";
    const titles = [];
    const add = v => {
        const t = clean(v);
        if (t && !titles.some(x => x.toLowerCase() === t.toLowerCase())) titles.push(t);
    };
    for (const lang of ["ar-SA", "en-US"]) {
        try {
            const url = `https://api.themoviedb.org/3/${type}/${encodeURIComponent(tmdbId)}?api_key=${TMDB_API_KEY}&language=${lang}`;
            const data = await (await fetch(url, { headers: { "User-Agent": UA } })).json();
            add(type === "tv" ? data.name : data.title);
            add(type === "tv" ? data.original_name : data.original_title);
        } catch (e) { console.log("[Oscar] TMDB fail:", e.message); }
    }
    return titles;
}

/* ==================== Search ==================== */
function titleScore(a, b) {
    const na = a.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const nb = b.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (!na || !nb) return 0;
    if (na === nb) return 100;
    if (na.startsWith(nb) || nb.startsWith(na)) return 82;
    const wa = new Set(na.split(" "));
    const common = nb.split(" ").filter(w => wa.has(w)).length;
    return (common / nb.split(" ").length) * 70;
}

async function searchOscar(kind, query) {
    const prefix = kind === "movie" ? "api/movies" : kind === "anime" ? "api/anime" : "api/series";
    const res = await oscarCall(`${prefix}/?page=1&limit=20&search=${encodeURIComponent(query)}`);
    return getDataArray(res).map(item => {
        const id = getNumber(item, "id", "item_id");
        const title = getString(item, "title_ar", "title_en", "name", "series_title");
        if (!id || !title) return null;
        return { id, kind, title };
    }).filter(Boolean);
}

async function findBestMatch(titles, mediaType) {
    const kinds = mediaType === "movie" ? ["movie"] : ["series", "anime"];
    const tasks = [];
    for (const t of titles.slice(0, 4)) for (const k of kinds) tasks.push({ t, k });

    const seen = new Set(), all = [];
    for (let i = 0; i < tasks.length; i += 3) {
        const batch = tasks.slice(i, i + 3);
        const groups = await Promise.all(batch.map(async ({ t, k }) => {
            try { return await searchOscar(k, t); } catch { return []; }
        }));
        for (const g of groups) for (const r of g) {
            const key = r.kind + ":" + r.id;
            if (!seen.has(key)) { seen.add(key); all.push(r); }
        }
    }

    let best = null, bestScore = 0;
    for (const r of all) for (const t of titles) {
        const s = titleScore(r.title, t);
        if (s > bestScore) { best = r; bestScore = s; }
    }
    return bestScore >= 45 ? { ...best, score: bestScore } : null;
}

/* ==================== Stream Extraction ==================== */
async function resolveSpecialHost(url) {
    if (!url.includes("newcdn.seriesmp4.com")) return url;
    try {
        const res = await fetch(url, { headers: { "User-Agent": PLAY_UA }, redirect: "follow" });
        if (!res.ok) return "";
        const html = await res.text();
        const m = html.match(/src=["'](https:\/\/downloader\.disk\.yandex\.ru[^"']+)["']/i);
        return m ? m[1].replace(/&/g, "&") : "";
    } catch { return ""; }
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
    if (r >= 2160) return "🏆"; if (r >= 1440) return "💎";
    if (r >= 1080) return "⚡"; if (r >= 720) return "🔥";
    if (r >= 480) return "💫"; return "❔";
}

async function extractStreams(detail) {
    const cands = [];
    for (const i of detail?.watch_links || [])
        cands.push({ url: getString(i, "url"), server: getString(i, "server_name") || "Oscar", quality: getString(i, "quality") });
    for (const i of detail?.download_links || [])
        cands.push({ url: getString(i, "url"), server: getString(i, "server_name") || "DL", quality: getString(i, "quality") });

    const out = [], seen = new Set();
    for (const c of cands) {
        let u = absoluteUrl(c.url);
        if (!/^https?:\/\//i.test(u)) continue;
        u = await resolveSpecialHost(u);
        if (!u || seen.has(u)) continue;
        seen.add(u);
        const fmt = getFormat(u);
        const qi = getQualityInfo(c.quality, u);
        out.push({
            name: "\u200E" + qEmoji(qi.r) + " " + qi.label,
            title: " " + qi.label + " · " + fmt + " · Oscar TV\nmade by ✌⁵¹⁵",
            description: " " + qi.label + " · " + fmt + " · Oscar TV\nmade by ✌⁵¹⁵",
            url: u,
            quality: qi.label,
            resolution: qi.r,
            headers: { "User-Agent": UA, "Referer": OSCAR_HOME + "/" },
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
    const show = getDataObject(await oscarCall(`${base}/show.php?id=${match.id}`));
    if (!show) return [];

    const seasons = Array.isArray(show.seasons) ? show.seasons : [];
    const ws = Number(season || 1), we = Number(episode);
    let sel = seasons.filter(s => Number(s.season_number || 1) === ws);
    if (!sel.length) sel = seasons.filter(s => Number(s.season_number || 1) === 1);
    if (!sel.length) sel = seasons.slice(0, 1);

    const eps = [];
    for (const s of sel) {
        const sid = getNumber(s, "season_id", "id");
        if (!sid) continue;
        const path = isAnime ? `api/anime/episodes/?season_id=${sid}` : `api/episodes/?season_id=${sid}`;
        const arr = getDataArray(await oscarCall(path));
        arr.forEach((e, i) => {
            const id = getNumber(e, "id");
            if (id) eps.push({ id, number: getNumber(e, "episode_number") || i + 1, season: Number(s.season_number || 1) });
        });
    }

    let target = eps.find(e => e.season === ws && e.number === we) || eps.find(e => e.number === we) || (eps.length === 1 ? eps[0] : null);
    if (!target) return [];

    const detailPath = isAnime ? "api/anime/episodes/show.php" : "api/episodes/show.php";
    const d = getDataObject(await oscarCall(`${detailPath}?id=${target.id}`));
    return d ? extractStreams(d) : [];
}

/* ==================== Nuvio Entry ==================== */
async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        if (!tmdbId || !["movie", "tv"].includes(mediaType)) return [];
        const titles = await getTitles(tmdbId, mediaType);
        if (!titles.length) return [];
        const match = await findBestMatch(titles, mediaType);
        if (!match) return [];
        console.log(`[Oscar] Match: ${match.kind} #${match.id} "${match.title}" (${match.score})`);
        if (mediaType === "movie") return await getMovieStreams(match);
        if (episode == null) return [];
        return await getEpisodeStreams(match, season, episode);
    } catch (e) {
        console.error("[Oscar] Fatal:", e.message);
        return [];
    }
}

module.exports = { getStreams };
