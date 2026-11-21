// Utalog: カラオケ（DAM 精密採点）の点数を記録して振り返る、自分専用の PWA
// データは GitHub の非公開リポジトリ utalog-data（records/<年>.json・songs.json・images/）。
// 点数は Claude が画像から読んで足す。アプリは見る・キーとメモを足す・直す・手で記録を足す。
(() => {
  "use strict";

  const APP_VERSION = 1;          // 読み書きできるデータの版
  const BUILD = "v1";             // 画面に出す版（sw.js の VERSION と合わせる）
  const isDev = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  const API = isDev ? location.origin + "/api" : "https://api.github.com";
  const DEFAULT_OWNER = isDev ? "me" : "kwsm-daiki";
  const DEFAULT_REPO = "utalog-data";
  const K = { data: "utalog:data", meta: "utalog:meta", settings: "utalog:settings", ui: "utalog:ui" };
  const IMG_CACHE = "utalog-img";
  const ZERO = "000000000000000:0";
  const TOMB_SHRINK_MS = 60 * 1000;
  const TOMB_KEEP_MS = 365 * 24 * 3600 * 1000;
  const DAY_START_HOUR = 5;       // 朝5時までは前の日として扱う（カラオケは日付をまたぐ）
  const REC_FIELDS = ["sungDate", "title", "variant", "artist", "songId", "mode", "total", "aiBonus", "nationalAvg",
    "pitch", "expression", "yokuyo", "shakuri", "kobushi", "fall", "aiKansei", "vibratoSec", "vibratoCount",
    "vibratoType", "longtoneLevel", "vibratoLevel", "stability", "rhythm", "report", "key", "memo",
    "sourceFile", "savedAt", "image", "deleted"];
  const COMPANION = { deleted: ["deletedAt"] };
  // 点数を直す画面の項目: [項目, 名前, 最小, 最大, 刻み]
  const NUM_EDIT = [
    ["total", "点数", 0, 100, 0.001], ["aiBonus", "Ai感性ボーナス", 0, 100, 0.001], ["nationalAvg", "全国平均", 0, 100, 0.001],
    ["pitch", "音程（%）", 0, 100, 1], ["expression", "表現力", 0, 100, 1], ["yokuyo", "抑揚", 0, 100, 1],
    ["shakuri", "しゃくり（回）", 0, 999, 1], ["kobushi", "こぶし（回）", 0, 999, 1], ["fall", "フォール（回）", 0, 999, 1],
    ["aiKansei", "Ai感性", 0, 100, 1], ["vibratoSec", "ビブラート（秒）", 0, 999, 1], ["vibratoCount", "ビブラート（回）", 0, 999, 1],
    ["longtoneLevel", "ロングトーン◆", 0, 5, 0.5], ["vibratoLevel", "ビブラート◆", 0, 5, 0.5],
    ["stability", "安定性（10段）", 0, 10, 1], ["rhythm", "リズム（−3〜+3）", -3, 3, 0.5]
  ];
  const WD = ["日", "月", "火", "水", "木", "金", "土"];
  const KANA_ROWS = [["あ", "あいうえおぁぃぅぇぉゔ"], ["か", "かきくけこがぎぐげご"], ["さ", "さしすせそざじずぜぞ"],
    ["た", "たちつてとだぢづでどっ"], ["な", "なにぬねの"], ["は", "はひふへほばびぶべぼぱぴぷぺぽ"], ["ま", "まみむめも"],
    ["や", "やゆよゃゅょ"], ["ら", "らりるれろ"], ["わ", "わをんゎ"]];

  // ---------- 保存（localStorage） ----------
  const mem = {};
  function lsGet(k) { if (k in mem) return mem[k]; try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); delete mem[k]; return true; } catch (e) { mem[k] = v; return false; } }
  function readJSON(k, fb) { try { const s = lsGet(k); return s ? JSON.parse(s) : fb; } catch (e) { return fb; } }
  function defaultData() { return { years: {}, songs: { version: 1, songs: [] } }; }
  let data = readJSON(K.data, null) || defaultData();
  if (!data.years) data.years = {};
  if (!data.songs) data.songs = { version: 1, songs: [] };
  let storageFull = false; // 端末に書けなかった（開き直すと消える）
  function saveData() { storageFull = !lsSet(K.data, JSON.stringify(data)); invalidate(); return !storageFull; }
  function getMeta() {
    const m = readJSON(K.meta, null) || {};
    if (!m.deviceId) { m.deviceId = Math.random().toString(36).slice(2, 10); lsSet(K.meta, JSON.stringify(m)); }
    m.shas = m.shas || {}; m.dirty = m.dirty || {};
    return m;
  }
  function setMeta(patch) { lsSet(K.meta, JSON.stringify(Object.assign(getMeta(), patch))); }
  function getSettings() { return Object.assign({ owner: DEFAULT_OWNER, repo: DEFAULT_REPO, token: "" }, readJSON(K.settings, {})); }
  function setSettings(s) { lsSet(K.settings, JSON.stringify(s)); }
  function getUI() { return readJSON(K.ui, {}); }
  function setUI(p) { lsSet(K.ui, JSON.stringify(Object.assign(getUI(), p))); }
  const configured = () => !!getSettings().token;

  // ---------- 時刻（項目ごとの更新時刻。Nudge と同じ形） ----------
  function tick() {
    const m = getMeta();
    const ms = Math.max(Date.now(), (m.lastSeen || 0) + 1);
    setMeta({ lastSeen: ms });
    return ms;
  }
  function stamp() { return String(tick()).padStart(15, "0") + ":" + getMeta().deviceId; }
  const stampMs = (s) => parseInt(String(s || ZERO).slice(0, 15), 10) || 0;
  const st = (o, f) => (o && o.t && o.t[f]) || ZERO;
  function maxStamp(o) { let m = 0; for (const v of Object.values((o && o.t) || {})) m = Math.max(m, stampMs(v)); return m; }

  // ---------- マージ（項目ごとに新しいほうを残す） ----------
  const clone = (x) => JSON.parse(JSON.stringify(x));
  function mergeItem(a, b) {
    if (!a) return clone(b);
    if (!b) return clone(a);
    const r = Object.assign({}, b, a);
    r.t = Object.assign({}, b.t || {}, a.t || {});
    for (const f of REC_FIELDS) {
      const w = st(a, f) >= st(b, f) ? a : b;
      for (const k of [f, ...(COMPANION[f] || [])]) { if (k in w) r[k] = w[k]; else delete r[k]; }
      if (w.t && w.t[f]) r.t[f] = w.t[f]; else delete r.t[f];
    }
    return r;
  }
  function shrink(x, now) {
    if (!x.deleted) return x;
    const at = x.deletedAt ? Date.parse(x.deletedAt) : stampMs(st(x, "deleted"));
    if (now - at < TOMB_SHRINK_MS) return x;
    return { id: x.id, createdAt: x.createdAt, deleted: true, deletedAt: x.deletedAt || new Date(at).toISOString(), t: { deleted: st(x, "deleted") } };
  }
  function tombExpired(x, now) {
    if (!x.deleted) return false;
    const at = x.deletedAt ? Date.parse(x.deletedAt) : stampMs(st(x, "deleted"));
    return now - at > TOMB_KEEP_MS;
  }
  // 墓石の片付けは、どの端末も deletedAt から同じように決める（tombExpired）。手元にだけある記録は捨てない
  function mergeRecords(local, remote) {
    const map = new Map((remote || []).map((x) => [x.id, x]));
    const out = []; const seen = new Set();
    for (const a of local || []) {
      seen.add(a.id);
      const b = map.get(a.id);
      out.push(mergeItem(a, b));
    }
    for (const b of remote || []) if (!seen.has(b.id)) out.push(clone(b));
    const now = Date.now();
    return out.filter((x) => !tombExpired(x, now)).map((x) => shrink(x, now));
  }
  function mergeYear(local, remote) {
    const r = Object.assign({}, remote || {}, local || {});
    r.version = APP_VERSION;
    r.records = mergeRecords((local && local.records) || [], remote ? remote.records || [] : null);
    return r;
  }
  // 並びと鍵の順を決めた JSON（Python の utalog_data.canonical と同じ形）
  function sortDeep(v) {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === "object") {
      const o = {};
      for (const k of Object.keys(v).sort()) if (v[k] !== undefined) o[k] = sortDeep(v[k]);
      return o;
    }
    return v;
  }
  function canonical(obj) {
    if (!obj) return "";
    const c = Object.assign({}, obj);
    c.records = [...(obj.records || [])].sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
    return JSON.stringify(sortDeep(c));
  }

  // ---------- 曲の正規化（Python の utalog_data.norm と同じ） ----------
  function norm(s) {
    let x = String(s ?? "").normalize("NFKC").toLowerCase();
    x = x.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
    return (x.match(/[\p{L}\p{N}]/gu) || []).join("");
  }
  const songIdOf = (title, artist) => norm(title) + "|" + norm(artist);

  // ---------- 日付 ----------
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  function logicalToday() { const d = new Date(); if (d.getHours() < DAY_START_HOUR) d.setDate(d.getDate() - 1); return ymd(d); }
  function parseYmd(s) { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, m - 1, d); }
  function daysBetween(a, b) { return Math.round((parseYmd(b) - parseYmd(a)) / 86400000); }
  function dateLabel(s) { const d = parseYmd(s); return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}（${WD[d.getDay()]}）`; }
  function shortDate(s) { const d = parseYmd(s); return `${d.getMonth() + 1}/${d.getDate()}`; }
  function ago(s) {
    const n = daysBetween(s, logicalToday());
    if (n <= 0) return "今日"; if (n < 31) return n + "日前";
    if (n < 365) return Math.floor(n / 30) + "か月前"; return Math.floor(n / 365) + "年前";
  }

  // ---------- 数の出し方 ----------
  const isNum = (v) => typeof v === "number" && isFinite(v);
  const f3 = (v) => (isNum(v) ? v.toFixed(3) : "—");
  const dash = (v, unit = "") => (isNum(v) ? v + unit : "—");
  function diffText(d) {
    if (!isNum(d)) return "";
    if (Math.abs(d) < 0.0005) return "± 0.000";
    return (d > 0 ? "▲ +" : "▼ −") + Math.abs(d).toFixed(3);
  }
  function diamonds(v) {
    if (!isNum(v)) return "—";
    const full = Math.floor(v), half = v - full >= 0.5 ? 1 : 0;
    return "◆".repeat(full) + (half ? "◈" : "") + "◇".repeat(5 - full - half) + " " + v;
  }
  function keyText(k) { return !isNum(k) ? "—" : k === 0 ? "原曲" : (k > 0 ? "+" : "−") + Math.abs(k); }
  function rhythmText(v) { return !isNum(v) ? "—" : v === 0 ? "ちょうど" : v < 0 ? "タメ寄り " + v : "走り寄り +" + v; }

  // ---------- 集計（記録が変わるたびに作り直す） ----------
  let idx = null;
  function invalidate() { idx = null; }
  function liveRecords() {
    const out = [];
    for (const y of Object.values(data.years)) for (const r of y.records || []) if (!r.deleted && isNum(r.total)) out.push(r);
    return out;
  }
  // 昇順に並べてから新しい順に出す。手で足したもの（savedAt なし）はその日の最後に出るよう、昇順では先にする
  const sortKey = (r) => r.sungDate + "|" + (r.savedAt ? "1" + r.savedAt : "0" + (r.createdAt || ""));
  function index() {
    if (idx) return idx;
    const songs = new Map(); const alias = new Map();
    for (const s of data.songs.songs || []) {
      songs.set(s.id, { key: s.id, title: s.title, artist: s.artist, yomi: s.yomi || "", artistYomi: s.artistYomi || "",
        tags: s.tags || [], inList: true, recs: [] });
      for (const a of s.aliases || []) alias.set(a, s.id);
    }
    const resolve = (r) => {
      for (const sid of [r.songId, songIdOf(r.title, r.artist)]) {
        if (!sid) continue;
        if (songs.has(sid) && songs.get(sid).inList) return sid;
        if (alias.has(sid)) return alias.get(sid);
      }
      return "x:" + songIdOf(r.title, r.artist);
    };
    const recs = liveRecords().sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
    const byId = new Map();
    for (const r of recs) {
      const k = resolve(r);
      if (!songs.has(k)) songs.set(k, { key: k, title: r.title, artist: r.artist, yomi: "", artistYomi: "", tags: [], inList: false, recs: [] });
      const s = songs.get(k);
      const prev = s.recs[s.recs.length - 1];
      const prevBest = s.recs.length ? Math.max(...s.recs.map((x) => x.total)) : null;
      byId.set(r.id, { r, key: k, diff: prev ? r.total - prev.total : null, best: prevBest !== null && r.total > prevBest });
      s.recs.push(r);
    }
    for (const s of songs.values()) {
      const n = s.recs.length;
      s.count = n;
      s.best = n ? Math.max(...s.recs.map((x) => x.total)) : null;
      s.avg = n ? s.recs.reduce((a, x) => a + x.total, 0) / n : null;
      s.last = n ? s.recs[n - 1].sungDate : null;
      s.sortYomi = norm(s.yomi || s.title);
    }
    const avgOf = (f) => { const v = recs.map((x) => x[f]).filter(isNum); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    idx = { songs, byId, recs, base: { pitch: avgOf("pitch"), expression: avgOf("expression"), aiKansei: avgOf("aiKansei") } };
    return idx;
  }
  function findRecord(id) {
    for (const [y, f] of Object.entries(data.years)) for (const r of f.records || []) if (r.id === id) return { y, r };
    return null;
  }

  // ---------- 書き換え ----------
  function markDirty(y) { const m = getMeta(); m.dirty[y] = (Number(m.dirty[y]) || 0) + 1; m.pending = (m.pending || 0) + 1; setMeta(m); }
  function setFields(id, fields) {
    const hit = findRecord(id);
    if (!hit) return;
    hit.r.t = hit.r.t || {};
    for (const [f, v] of Object.entries(fields)) {
      if (f === "deletedAt") { hit.r[f] = v; continue; }
      hit.r[f] = v; hit.r.t[f] = stamp();
    }
    saveData(); markDirty(hit.y); scheduleSync(1500); renderStatus();
  }
  function addRecord(rec) {
    const createdAt = new Date().toISOString();
    const y = createdAt.slice(0, 4);
    const r = Object.assign({ id: crypto.randomUUID ? crypto.randomUUID() : "r" + Date.now() + Math.random().toString(36).slice(2),
      createdAt, deleted: false, mode: "精密採点Ai", sourceFile: null, savedAt: null, image: null, memo: "" }, rec);
    r.t = { c: stamp() };
    (data.years[y] = data.years[y] || { version: APP_VERSION, records: [] }).records.push(r);
    saveData(); markDirty(y); scheduleSync(1500); renderStatus();
    return r;
  }

  // ---------- GitHub ----------
  class ApiError extends Error { constructor(kind, status, msg) { super(msg); this.kind = kind; this.status = status; } }
  function contentsUrl(path) {
    const s = getSettings();
    const base = API + "/repos/" + encodeURIComponent(s.owner) + "/" + encodeURIComponent(s.repo);
    return path === null ? base : base + "/contents/" + path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  }
  async function api(method, path, opt = {}) {
    const s = opt.settings || getSettings();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opt.timeout || 20000);
    let res;
    try {
      const url = (opt.settings ? (API + "/repos/" + encodeURIComponent(s.owner) + "/" + encodeURIComponent(s.repo)) : contentsUrl(null)) +
        (path === null ? "" : "/contents/" + path.split("/").filter(Boolean).map(encodeURIComponent).join("/"));
      res = await fetch(url, {
        method, cache: "no-store", signal: ctl.signal,
        headers: Object.assign({
          Authorization: "Bearer " + s.token, "X-GitHub-Api-Version": "2022-11-28",
          Accept: opt.raw ? "application/vnd.github.raw+json" : "application/vnd.github+json"
        }, opt.body ? { "Content-Type": "application/json" } : {}),
        body: opt.body ? JSON.stringify(opt.body) : undefined
      });
    } catch (e) {
      throw new ApiError("offline", 0, "ネットにつながりません");
    } finally { clearTimeout(timer); }
    if (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.get("retry-after"))) throw new ApiError("other", 403, "GitHub が混んでいます。少し待ってからもう一度");
    if (res.status === 401 || res.status === 403) throw new ApiError("auth", res.status, "トークンが使えません（期限切れか、権限が足りません）");
    if (opt.allow404 && res.status === 404) return null;
    if (res.status === 409 || res.status === 422) throw new ApiError("conflict", res.status, "ほかの端末と同時に書き込みました");
    if (res.status === 404) throw new ApiError("notfound", 404, "リポジトリかファイルが見つかりません");
    if (!res.ok) throw new ApiError("other", res.status, "GitHub の返事がおかしい（HTTP " + res.status + "）");
    return res;
  }
  async function listDir(path) { const r = await api("GET", path, { allow404: true }); return r ? r.json() : []; }
  async function getJSON(path) { const r = await api("GET", path, { raw: true }); return JSON.parse(await r.text()); }
  function b64utf8(s) {
    const bytes = new TextEncoder().encode(s); let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  async function putJSON(path, text, sha) {
    const body = { message: "Utalog アプリから更新", content: b64utf8(text) };
    if (sha) body.sha = sha;
    const r = await api("PUT", path, { body });
    return (await r.json()).content.sha;
  }

  // ---------- 同期 ----------
  let syncing = false, syncAgain = false, syncTimer = null;
  let lastError = null; // ApiError | {kind:'newer'}
  function scheduleSync(ms) { clearTimeout(syncTimer); syncTimer = setTimeout(() => sync(), ms); }
  async function sync() {
    if (!configured()) { renderStatus(); return; }
    if (syncing) { syncAgain = true; return; }
    syncing = true; renderStatus();
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await syncOnce(); lastError = null; break; } catch (e) {
          if (e.kind === "conflict" && attempt < 2) continue;
          throw e;
        }
      }
    } catch (e) {
      console.error("sync:", e);
      lastError = e.kind ? e : new ApiError("other", 0, String(e.message || e));
    } finally {
      syncing = false; renderStatus(); renderBanner();
      if (syncAgain) { syncAgain = false; scheduleSync(300); }
    }
  }
  async function syncOnce() {
    const meta = getMeta();
    const shas = Object.assign({}, meta.shas);
    const root = await listDir("");
    const songsE = root.find((e) => e.name === "songs.json" && e.type === "file");
    const recE = root.some((e) => e.name === "records" && e.type === "dir") ? await listDir("records") : [];
    let changed = false;
    if (songsE && songsE.sha !== shas["songs.json"]) {
      const s = await getJSON("songs.json");
      if ((s.version || 1) > APP_VERSION) throw new ApiError("newer", 0, "データがこのアプリより新しい版です。アプリを開き直してください");
      data.songs = s; shas["songs.json"] = songsE.sha; changed = true;
    }
    const years = new Set(Object.keys(data.years));
    for (const e of recE) { const m = /^(\d{4})\.json$/.exec(e.name); if (m) years.add(m[1]); }
    for (const y of [...years].sort()) {
      const path = "records/" + y + ".json";
      const e = recE.find((x) => x.name === y + ".json");
      const rsha = e ? e.sha : null;
      const dirty = !!getMeta().dirty[y];
      if (rsha && rsha === shas[path] && !dirty) continue;
      let remote = null;
      if (rsha && rsha !== shas[path]) {
        remote = await getJSON(path);
        if ((remote.version || 1) > APP_VERSION) throw new ApiError("newer", 0, "データがこのアプリより新しい版です。アプリを開き直してください");
      }
      const local = data.years[y] || null;
      if (!rsha && (!local || !(local.records || []).length)) continue;
      // 合わせる直前の「書き換えの番号」を控える。送っている間に直したら番号が変わり、印を残す
      const d0 = getMeta().dirty[y] || 0;
      let merged = remote ? mergeYear(local, remote) : mergeYear(local, null);
      const need = remote ? canonical(merged) !== canonical(remote) : (dirty || !rsha);
      let newSha = rsha;
      if (need) newSha = await putJSON(path, canonical(merged) + "\n", rsha);
      // 同期している間に手元で直したものも残す（項目ごとの時刻で合わせ直す）
      const before = canonical(data.years[y] || null);
      merged = mergeYear(data.years[y] || null, merged);
      if (canonical(merged) !== before) changed = true;
      data.years[y] = merged;
      if (!saveData()) throw new ApiError("storage", 0, "端末の保存場所がいっぱいで、記録を保存できません");
      shas[path] = newSha;
      const m = getMeta(); if ((m.dirty[y] || 0) === d0) delete m.dirty[y]; setMeta(m);
    }
    let seen = 0;
    for (const f of Object.values(data.years)) for (const r of f.records || []) seen = Math.max(seen, maxStamp(r));
    const stillDirty = Object.keys(getMeta().dirty).length;
    // 受け取った時刻に手元の時計を追いつかせる（時計の遅れた端末で直したものが負けないように）
    setMeta({ shas, lastSeen: Math.max(getMeta().lastSeen || 0, seen), lastSyncTime: Date.now(), pending: stillDirty ? getMeta().pending : 0 });
    if (changed) { saveData(); softRender(); }
    if (stillDirty) syncAgain = true;
  }

  // ---------- 小道具 ----------
  const $ = (id) => document.getElementById(id);
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k === "style") n.style.cssText = v; // CSP: style 属性ではなく CSSOM で入れる
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  }
  const svgNS = "http://www.w3.org/2000/svg";
  function sv(tag, attrs, ...kids) {
    const n = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (k === "text") n.textContent = v; else n.setAttribute(k, v);
    for (const c of kids) if (c) n.append(c);
    return n;
  }
  let toastTimer = null, toastUndo = null;
  function toast(text, undo) {
    $("toastText").textContent = text; toastUndo = undo || null;
    $("toastBtn").hidden = !undo; $("toast").hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { $("toast").hidden = true; toastUndo = null; }, undo ? 5000 : 2500);
  }
  $("toastBtn").addEventListener("click", () => { if (toastUndo) toastUndo(); $("toast").hidden = true; toastUndo = null; });

  // ---------- 画面の移り（URL の # と history） ----------
  const TABS = ["records", "songs", "rank", "recommend"];
  let curTab = getUI().tab || "records";
  const scrolls = {};
  let route = parseRoute();
  let leaveGuard = null; // 打ちかけの入力があるとき、離れる前に確かめる関数
  function parseRoute() {
    const h = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
    const [name, ...rest] = h.split("/");
    return { name: name || "", arg: rest.join("/") };
  }
  function go(hash, replace) {
    if (leaveGuard && !leaveGuard()) return;
    if (route.name && TABS.includes(route.name)) scrolls[route.name] = window.scrollY;
    const depth = ((history.state && history.state.depth) || 0) + (replace ? 0 : 1);
    if (replace) history.replaceState({ depth: (history.state && history.state.depth) || 0 }, "", "#/" + hash);
    else history.pushState({ depth }, "", "#/" + hash);
    route = parseRoute(); render(true);
  }
  function goBack() {
    if (history.state && history.state.depth > 0) history.back();
    else go(curTab, true);
  }
  window.addEventListener("popstate", () => {
    if (closingViewer) { closingViewer = false; return; }
    if (!$("viewer").hidden) { closeViewer(true); return; }
    if (leaveGuard && !leaveGuard()) { history.pushState(history.state ? { depth: (history.state.depth || 0) + 1 } : { depth: 1 }, "", "#/" + route.name + (route.arg ? "/" + route.arg : "")); return; }
    if (route.name && TABS.includes(route.name)) scrolls[route.name] = window.scrollY;
    route = parseRoute(); render(true);
  });
  $("backBtn").addEventListener("click", () => goBack());
  $("gearBtn").addEventListener("click", () => go("settings"));
  $("syncBtn").addEventListener("click", () => { if (lastError || !configured()) go("settings"); else sync(); });
  $("fab").addEventListener("click", () => go("add"));
  for (const b of document.querySelectorAll(".nav button")) b.addEventListener("click", () => {
    const t = b.dataset.tab;
    if (route.name === t) { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    go(t, true);
  });

  // ---------- 同期の表示 ----------
  function renderStatus() {
    const btn = $("syncBtn"), text = $("syncText");
    btn.className = "sync";
    const m = getMeta();
    if (!configured()) { text.textContent = "未設定"; return; }
    if (syncing) { btn.classList.add("busy"); text.textContent = "同期中"; return; }
    if (lastError && lastError.kind === "offline") { btn.classList.add("wait"); text.textContent = (m.pending ? "未送信 " + m.pending + "件・" : "") + "オフライン"; return; }
    if (lastError) { btn.classList.add("err"); text.textContent = "同期できません ⚠"; return; }
    if (m.pending) { btn.classList.add("wait"); text.textContent = "未送信 " + m.pending + "件"; return; }
    btn.classList.add("ok"); text.textContent = "同期済み";
  }
  function renderBanner() {
    const b = $("banner");
    b.replaceChildren();
    if (lastError && lastError.kind === "auth" && route.name !== "settings" && route.name !== "connect") {
      b.append(el("span", { text: "トークンが使えません（期限切れかもしれません）。直すまで、変更はこの端末にだけ残ります。" }),
        el("button", { class: "btn small", type: "button", text: "設定を開く", onclick: () => go("settings") }));
      b.hidden = false;
    } else b.hidden = true;
  }

  // ---------- 描画 ----------
  function render(navigated) {
    leaveGuard = null;
    if (editing && route.name !== "rec") editing = null;
    if (editing && route.arg !== editing) editing = null;
    if (!configured() && !getMeta().skipConnect && route.name !== "connect") { history.replaceState({ depth: 0 }, "", "#/connect"); route = parseRoute(); }
    if (!route.name) { history.replaceState({ depth: 0 }, "", "#/" + curTab); route = parseRoute(); }
    if (TABS.includes(route.name)) { curTab = route.name; setUI({ tab: curTab }); }
    const isTab = TABS.includes(route.name);
    for (const b of document.querySelectorAll(".nav button")) b.classList.toggle("on", b.dataset.tab === curTab);
    $("backBtn").hidden = isTab || route.name === "connect";
    $("fab").hidden = !(route.name === "records");
    const v = $("view");
    const views = { records: viewRecords, songs: viewSongs, rank: viewRank, recommend: viewRecommend, song: viewSong,
      rec: viewRec, add: viewAdd, settings: viewSettings, connect: viewConnect };
    const fn = views[route.name] || viewRecords;
    const keepScroll = !navigated ? window.scrollY : null;
    v.replaceChildren(); fn(v);
    renderStatus(); renderBanner();
    if (keepScroll !== null) window.scrollTo(0, keepScroll);
    else if (isTab) window.scrollTo(0, scrolls[route.name] || 0);
    else window.scrollTo(0, 0);
  }
  // 同期で中身が変わったときの描き直し。入力中（欄にフォーカスがある・打ちかけの画面）は、離れるまで待つ
  let renderLater = false;
  function softRender() {
    const a = document.activeElement;
    const typing = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && $("view").contains(a);
    if (typing || leaveGuard || editing) { renderLater = true; return; }
    render();
  }
  document.addEventListener("focusout", () => setTimeout(() => {
    if (renderLater) { renderLater = false; softRender(); }
  }, 0));
  function setTitle(t) { $("title").textContent = t; document.title = t === "Utalog" ? "Utalog" : t + " - Utalog"; }
  function empty(...lines) { return el("div", { class: "empty" }, ...lines.map((l) => el("div", {}, l))); }
  function titleNode(title, variant) { return el("span", {}, title, variant ? el("span", { class: "var", text: "（" + variant + "）" }) : null); }

  // ① 記録
  function viewRecords(v) {
    setTitle("Utalog");
    const I = index();
    const recs = [...I.recs].reverse();
    if (!recs.length) {
      v.append(empty(el("b", { text: "まだ記録がありません" }), "Claude に「点数を取り込んで」と頼むか、", "右下の ＋ で手で足せます"));
      return;
    }
    const today = logicalToday();
    const todays = recs.filter((r) => r.sungDate === today);
    if (todays.length) v.append(el("div", { class: "h-today", text: `今日 ${todays.length}曲・平均 ${f3(todays.reduce((a, r) => a + r.total, 0) / todays.length)}` }));
    let cur = null, box = null;
    const groups = [];
    for (const r of recs) {
      if (r.sungDate !== cur) { cur = r.sungDate; box = { date: cur, items: [] }; groups.push(box); }
      box.items.push(r);
    }
    for (const g of groups) {
      const avg = g.items.reduce((a, r) => a + r.total, 0) / g.items.length;
      v.append(el("div", { class: "date-h" }, el("span", { text: dateLabel(g.date) }), el("span", { text: `${g.items.length}曲・平均 ${f3(avg)}` })));
      for (const r of g.items) v.append(recRow(r));
    }
  }
  function recRow(r) {
    const info = index().byId.get(r.id);
    const chips = [];
    if (info && info.best) chips.push(el("span", { class: "chip best", text: "★ 自己ベスト" }));
    if (isNum(r.key) && r.key !== 0) chips.push(el("span", { class: "chip key", text: "キー " + keyText(r.key) }));
    if (r.memo) chips.push(el("span", { class: "chip", text: "メモあり" }));
    const d = info ? info.diff : null;
    return el("button", { class: "row", type: "button", onclick: () => go("rec/" + r.id) },
      el("div", { class: "m" }, el("div", { class: "t1" }, titleNode(r.title, r.variant)), el("div", { class: "t2", text: r.artist }),
        chips.length ? el("div", { class: "chips" }, chips) : null),
      el("div", {}, el("div", { class: "score" }, f3(r.total), el("small", { text: "点" })),
        el("div", { class: "diff " + (d === null ? "new" : d >= 0 ? "up" : "down"), text: d === null ? "はじめて" : diffText(d) })));
  }

  // ② 曲の画面
  function viewSong(v) {
    const s = index().songs.get(route.arg);
    if (!s) { setTitle("曲"); v.append(empty("この曲は見つかりませんでした")); return; }
    setTitle(s.title);
    v.append(el("div", { class: "head" }, el("div", { class: "t1", text: s.title }), el("div", { class: "t2", text: s.artist + (s.artistYomi ? "" : "") }),
      el("div", { class: "tags" }, ...(s.tags || []).map((t) => el("span", { class: "chip", text: t })), s.inList ? null : el("span", { class: "chip out", text: "リスト外" }))));
    if (!s.count) {
      v.append(empty("まだ歌っていない曲です"), el("button", { class: "btn p full", type: "button", text: "＋ この曲で記録を足す", onclick: () => go("add/" + s.key) }));
      return;
    }
    v.append(el("div", { class: "stats" },
      el("div", {}, el("b", { class: "g", text: f3(s.best) }), el("span", { text: "最高" })),
      el("div", {}, el("b", { class: "g", text: f3(s.avg) }), el("span", { text: "平均" })),
      el("div", {}, el("b", { text: s.count }), el("span", { text: "回" }))));
    v.append(el("div", { class: "card" }, el("div", { class: "sec-h", style: "margin-top:0" }, "点数の移り変わり"), chart(s)));
    v.append(breakdown(s));
    v.append(el("div", { class: "sec-h" }, "この曲の記録", el("span", { class: "note", text: "新しい順" })));
    for (const r of [...s.recs].reverse()) {
      const chips = [];
      if (r.variant) chips.push(el("span", { class: "chip", text: r.variant }));
      if (isNum(r.key) && r.key !== 0) chips.push(el("span", { class: "chip key", text: "キー " + keyText(r.key) }));
      if (r.total === s.best) chips.push(el("span", { class: "chip best", text: "★ 最高" }));
      v.append(el("button", { class: "row", type: "button", onclick: () => go("rec/" + r.id) },
        el("div", { class: "m" }, el("div", { class: "t1", text: dateLabel(r.sungDate) }), chips.length ? el("div", { class: "chips" }, chips) : null),
        el("div", { class: "score s" }, f3(r.total))));
    }
    v.append(el("button", { class: "btn full", type: "button", style: "margin-top:8px", text: "＋ この曲で記録を足す", onclick: () => go("add/" + s.key) }));
  }
  function chart(s) {
    const pts = s.recs.map((r) => r.total);
    const W = 320, H = 150, L = 34, R = 10, T = 12, B = 22;
    if (pts.length === 1) {
      return el("div", {}, el("div", { class: "muted", text: "2回目から線が出ます（今は1回: " + f3(pts[0]) + "）" }));
    }
    let lo = Math.min(...pts), hi = Math.max(...pts);
    const mid = (lo + hi) / 2;
    if (hi - lo < 6) { lo = mid - 3; hi = mid + 3; }
    lo = Math.max(0, Math.floor(lo)); hi = Math.min(100, Math.ceil(hi));
    const x = (i) => L + (W - L - R) * (pts.length === 1 ? 0.5 : i / (pts.length - 1));
    const y = (val) => T + (H - T - B) * (1 - (val - lo) / (hi - lo || 1));
    const g = sv("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "点数の移り変わりのグラフ" });
    for (const val of [lo, Math.round((lo + hi) / 2), hi]) {
      g.append(sv("line", { x1: L, x2: W - R, y1: y(val), y2: y(val), stroke: "#2f3a52", "stroke-width": 1 }));
      g.append(sv("text", { x: 0, y: y(val) + 4, fill: "#b0bacb", "font-size": 12, text: String(val) }));
    }
    g.append(sv("polyline", { fill: "none", stroke: "#f2b84b", "stroke-width": 2.5, points: pts.map((p, i) => x(i) + "," + y(p)).join(" ") }));
    s.recs.forEach((r, i) => {
      const isBest = r.total === s.best;
      const node = r.variant
        ? sv("rect", { x: x(i) - 5, y: y(r.total) - 5, width: 10, height: 10, fill: "#f2b84b", stroke: "#0f1420", "stroke-width": 1.5 })
        : sv("circle", { cx: x(i), cy: y(r.total), r: isBest ? 6.5 : 5, fill: "#f2b84b", stroke: isBest ? "#eef1f6" : "#0f1420", "stroke-width": isBest ? 2 : 1.5 });
      const hit = sv("circle", { cx: x(i), cy: y(r.total), r: 16, fill: "transparent" });
      hit.style.cursor = "pointer";
      hit.addEventListener("click", () => go("rec/" + r.id));
      g.append(node, hit);
    });
    const n = pts.length;
    const lab = (i, anchor) => sv("text", { x: x(i), y: H - 4, fill: "#b0bacb", "font-size": 12, "text-anchor": anchor, text: shortDate(s.recs[i].sungDate) });
    g.append(lab(0, "start"), lab(n - 1, "end"));
    if (n >= 5) g.append(lab(Math.floor((n - 1) / 2), "middle"));
    const hasVar = s.recs.some((r) => r.variant);
    return el("div", {}, g, el("div", { class: "chart-note" }, el("span", { text: "横は歌った回の順（" + n + "回）" }),
      el("span", { text: (hasVar ? "■ は生音などの版・" : "") + "白い縁は最高点" })));
  }
  function breakdown(s) {
    const base = index().base;
    const box = el("div", { class: "card" }, el("div", { class: "sec-h", style: "margin-top:0" }, "内訳の平均", el("span", { class: "note", text: "縦線は全曲の平均" })));
    const rows = [["pitch", "音程", "%"], ["expression", "表現力", ""], ["aiKansei", "Ai感性", ""]];
    for (const [f, name, unit] of rows) {
      const vals = s.recs.map((r) => r[f]).filter(isNum);
      if (!vals.length) { box.append(el("div", { class: "bar" }, el("span", { class: "l", text: name }), el("div", {}), el("span", { class: "v", text: "—" }))); continue; }
      const av = vals.reduce((a, b) => a + b, 0) / vals.length;
      const low = isNum(base[f]) && av < base[f] - 0.5;
      const track = el("div", { class: "track" }, el("div", { class: "fill" + (low ? " low" : ""), style: `width:${Math.max(0, Math.min(100, av))}%` }));
      if (isNum(base[f])) track.append(el("div", { class: "base", style: `left:${Math.max(0, Math.min(100, base[f]))}%` }));
      box.append(el("div", { class: "bar" }, el("span", { class: "l", text: name }), track,
        el("span", { class: "v" + (low ? " low" : ""), text: av.toFixed(1) + unit + (low ? " ↓" : "") })));
      if (vals.length < s.count) box.append(el("div", { class: "legend", text: `${name}は ${s.count}回中${vals.length}回の平均` }));
    }
    const dAvg = (f) => { const v = s.recs.map((r) => r[f]).filter(isNum); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length * 2) / 2 : null; };
    box.append(el("div", { class: "kv" }, el("span", { text: "ロングトーン" }), el("span", { class: "dia", text: diamonds(dAvg("longtoneLevel")) })));
    box.append(el("div", { class: "kv", style: "border:0" }, el("span", { text: "ビブラート" }), el("span", { class: "dia", text: diamonds(dAvg("vibratoLevel")) })));
    box.append(el("div", { class: "legend", text: "↓ は全曲の平均より低いところ。◆は平均を 0.5 刻みに丸めたもの" }));
    return box;
  }

  // ③ 1回の詳細
  let editing = null; // 点数を直している記録の id
  function viewRec(v) {
    const hit = findRecord(route.arg);
    if (!hit || hit.r.deleted) { setTitle("記録"); editing = null; v.append(empty("この記録は見つかりませんでした（消したか、まだ同期していません）")); return; }
    const r = hit.r;
    const info = index().byId.get(r.id);
    setTitle(dateLabel(r.sungDate).replace(/（.）$/, ""));
    v.append(el("div", { class: "head" },
      el("button", { class: "link", type: "button", onclick: () => info && go("song/" + info.key) },
        el("span", { class: "t1", style: "display:block;white-space:normal", text: r.title + (r.variant ? "（" + r.variant + "）" : "") })),
      el("div", { class: "t2", text: r.artist + "　" + dateLabel(r.sungDate) + (r.mode ? "　" + r.mode : "") })));
    if (editing === r.id) { editForm(v, r); return; }
    v.append(el("div", { class: "stats" },
      el("div", {}, el("b", { class: "g", text: f3(r.total) }), el("span", { text: "点数" })),
      el("div", {}, el("b", { text: f3(r.nationalAvg) }), el("span", { text: "全国平均" })),
      el("div", {}, el("b", { class: "pk", text: f3(r.aiBonus) }), el("span", { text: "Ai ボーナス" }))));
    const kv = (k, val) => el("div", { class: "kv" }, el("span", { text: k }), el("span", { text: val }));
    v.append(el("div", { class: "card" },
      el("div", { class: "grid" },
        kv("音程", dash(r.pitch, "%")), kv("Ai感性", dash(r.aiKansei)),
        kv("表現力", dash(r.expression)), kv("抑揚", dash(r.yokuyo)),
        kv("しゃくり", dash(r.shakuri, "回")), kv("こぶし", dash(r.kobushi, "回")),
        kv("フォール", dash(r.fall, "回")), kv("ビブラート", isNum(r.vibratoSec) || isNum(r.vibratoCount) ? `${dash(r.vibratoSec, "秒")}・${dash(r.vibratoCount, "回")}` : "—")),
      kv("ビブラートの形", r.vibratoType || "—"),
      el("div", { class: "kv" }, el("span", { text: "ロングトーン" }), el("span", { class: "dia", text: diamonds(r.longtoneLevel) })),
      el("div", { class: "kv" }, el("span", { text: "ビブラート" }), el("span", { class: "dia", text: diamonds(r.vibratoLevel) })),
      meter("震えがち", "まっすぐ", r.stability, 10, (i) => i < r.stability, "安定性 " + dash(r.stability) + "/10"),
      meter("タメ", "走り", r.rhythm, 7, (i) => Math.abs(i - 3 - r.rhythm) <= 0.5, "リズム " + rhythmText(r.rhythm))));
    if (r.report) v.append(el("div", { class: "card report" }, "💬 " + r.report));
    // キーとメモ（その場で直す）
    const out = el("output", { text: keyText(r.key) });
    const setKey = (d) => {
      const cur = isNum(r.key) ? r.key : 0;
      const next = Math.max(-7, Math.min(7, cur + d));
      if (next !== r.key) { setFields(r.id, { key: next }); out.textContent = keyText(next); }
    };
    const memo = el("textarea", { class: "input", rows: 2, placeholder: "例: のどの調子がよかった", "aria-label": "メモ" });
    memo.value = r.memo || "";
    let memoTimer = null;
    const saveMemo = () => { clearTimeout(memoTimer); if ((r.memo || "") !== memo.value) setFields(r.id, { memo: memo.value }); };
    memo.addEventListener("input", () => { clearTimeout(memoTimer); memoTimer = setTimeout(saveMemo, 800); });
    memo.addEventListener("blur", saveMemo);
    v.append(el("div", { class: "card" },
      el("div", { class: "kv", style: "border:0;align-items:center" }, el("span", { text: "キー" }),
        el("span", { class: "stepper" }, el("button", { type: "button", "aria-label": "キーを下げる", text: "−", onclick: () => setKey(-1) }), out,
          el("button", { type: "button", "aria-label": "キーを上げる", text: "＋", onclick: () => setKey(1) }))),
      el("label", { class: "field", style: "margin-bottom:0" }, el("span", { text: "メモ" }), memo)));
    // 元の画像
    if (r.image) v.append(imageBox(r));
    v.append(el("div", { class: "btns" }, el("button", { class: "btn", type: "button", text: "点数を直す", onclick: () => { editing = r.id; render(true); } })));
    v.append(el("button", { class: "btn danger full", type: "button", style: "margin-top:24px", text: "この記録を消す", onclick: () => {
      setFields(r.id, { deleted: true, deletedAt: new Date().toISOString() });
      goBack();
      toast("記録を消しました", () => { setFields(r.id, { deleted: false, deletedAt: null }); render(); });
    } }));
  }
  function meter(left, right, val, n, on, label) {
    const cells = [];
    for (let i = 0; i < n; i++) cells.push(el("i", { class: isNum(val) && on(i) ? "on" : "" }));
    return el("div", {}, el("div", { class: "meter" }, el("span", { class: "lab", text: left }), el("span", { class: "mt", "aria-label": label }, cells),
      el("span", { class: "lab r", text: right })));
  }
  function imageBox(r) {
    const box = el("div", { class: "thumb-box" });
    const load = () => {
      box.replaceChildren(el("div", { class: "card thumb-msg", text: "元の画像を読み込み中…" }));
      loadImage(r.image).then((url) => {
        const img = el("img", { src: url, alt: "採点の元の画像（タップで大きく）" });
        box.replaceChildren(el("div", { class: "sec-h" }, "元の画像", el("span", { class: "note", text: "タップで大きく" })),
          el("button", { class: "thumb", type: "button", onclick: () => openViewer(url) }, img));
      }).catch((e) => {
        box.replaceChildren(el("div", { class: "card thumb-msg" }, el("div", { text: !configured() ? "GitHub につなぐと元の画像を見られます" : "元の画像を読み込めませんでした（" + (e.message || e) + "）" }),
          configured() ? el("button", { class: "btn small", type: "button", style: "margin-top:8px", text: "もう一度", onclick: load }) : null));
      });
    };
    load();
    return box;
  }
  async function loadImage(path) {
    const key = new URL("./img/" + path, location.href).href;
    let cache = null;
    try { cache = await caches.open(IMG_CACHE); } catch (e) { cache = null; }
    const hit = cache && await cache.match(key);
    if (hit) return URL.createObjectURL(await hit.blob());
    if (!configured()) throw new Error("未設定");
    const res = await api("GET", path, { raw: true, timeout: 30000 });
    const blob = await res.blob();
    if (cache) try { await cache.put(key, new Response(blob, { headers: { "Content-Type": "image/jpeg" } })); } catch (e) { /* 入らなくても見せる */ }
    return URL.createObjectURL(blob);
  }
  function openViewer(url) {
    $("viewerImg").src = url; $("viewer").hidden = false;
    history.pushState({ depth: ((history.state && history.state.depth) || 0) + 1, viewer: 1 }, "", location.hash);
  }
  let closingViewer = false;
  function closeViewer(fromPop) { $("viewer").hidden = true; if (!fromPop && history.state && history.state.viewer) { closingViewer = true; history.back(); } }
  $("viewerClose").addEventListener("click", () => closeViewer(false));

  function editForm(v, r) {
    const inputs = {};
    const grid = el("div", { class: "edit-grid" });
    for (const [f, name, lo, hi, step] of NUM_EDIT) {
      const inp = el("input", { class: "input", type: "text", inputmode: step < 1 || lo < 0 ? "decimal" : "numeric", "aria-label": name });
      inp.value = isNum(r[f]) ? String(r[f]) : "";
      inputs[f] = { inp, lo, hi, step, name };
      grid.append(el("label", { class: "field" }, el("span", { text: name }), inp));
    }
    const vt = el("input", { class: "input", type: "text" }); vt.value = r.vibratoType || "";
    const rep = el("textarea", { class: "input", rows: 3 }); rep.value = r.report || "";
    const date = el("input", { class: "input", type: "date" }); date.value = r.sungDate;
    const err = el("div", { class: "err-text" });
    let changedEdit = false;
    for (const n of [...Object.values(inputs).map((o) => o.inp), vt, rep, date]) n.addEventListener("input", () => { changedEdit = true; });
    leaveGuard = () => !changedEdit || confirm("直しかけの点数を破棄しますか？");
    v.append(el("div", { class: "card" }, grid,
      el("label", { class: "field" }, el("span", { text: "ビブラートの形" }), vt),
      el("label", { class: "field" }, el("span", { text: "分析レポート" }), rep),
      el("label", { class: "field" }, el("span", { text: "歌った日" }), date), err));
    if (r.image) v.append(imageBox(r));
    const save = () => {
      const patch = {}; let bad = false;
      for (const [f, o] of Object.entries(inputs)) {
        o.inp.classList.remove("bad");
        const s = o.inp.value.trim().replace(/[−ー－]/g, "-").replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
        let val = s === "" ? null : Number(s);
        if (val !== null && (!isFinite(val) || val < o.lo || val > o.hi || Math.abs(val / o.step - Math.round(val / o.step)) > 1e-6)) { o.inp.classList.add("bad"); bad = true; continue; }
        if (f === "total" && val === null) { o.inp.classList.add("bad"); bad = true; continue; }
        if (val !== (isNum(r[f]) ? r[f] : null)) patch[f] = val;
      }
      if (bad) { err.textContent = "赤い欄の数を確かめてください（範囲の外か、刻みが合いません）"; return; }
      if (vt.value.trim() !== (r.vibratoType || "")) patch.vibratoType = vt.value.trim() || null;
      if (rep.value.trim() !== (r.report || "")) patch.report = rep.value.trim() || null;
      if (date.value && date.value !== r.sungDate) patch.sungDate = date.value;
      if (Object.keys(patch).length) setFields(r.id, patch);
      editing = null; render(true);
      if (Object.keys(patch).length) toast("直しました");
    };
    v.append(el("div", { class: "btns" }, el("button", { class: "btn", type: "button", text: "やめる", onclick: () => { editing = null; render(true); } }),
      el("button", { class: "btn p", type: "button", text: "保存する", onclick: save })));
  }

  // ④ ランキング
  function viewRank(v) {
    setTitle("ランキング");
    const mode = getUI().rank || "avg";
    const seg = el("div", { class: "seg", role: "tablist" });
    for (const [k, name] of [["avg", "平均点"], ["best", "最高点"], ["count", "歌った回数"]]) {
      seg.append(el("button", { type: "button", class: mode === k ? "on" : "", "aria-selected": mode === k ? "true" : "false",
        text: name, onclick: () => { setUI({ rank: k }); render(true); } }));
    }
    v.append(seg);
    let list = [...index().songs.values()].filter((s) => (mode === "best" ? s.count >= 1 : s.count >= 2));
    list.sort(mode === "avg" ? (a, b) => b.avg - a.avg : mode === "best" ? (a, b) => b.best - a.best : (a, b) => b.count - a.count || b.avg - a.avg);
    v.append(el("div", { class: "cond", text: (mode === "best" ? "歌った曲" : "2回以上歌った曲") + "・" + list.length + "曲" }));
    if (!list.length) { v.append(empty(mode === "best" ? "まだ記録がありません" : "2回以上歌った曲がまだありません", "同じ曲を2回歌うと、ここに並びます")); return; }
    list.slice(0, 100).forEach((s, i) => {
      const main = mode === "avg" ? f3(s.avg) : mode === "best" ? f3(s.best) : s.count + "回";
      const sub = mode === "count" ? "平均 " + f3(s.avg) : s.count + "回" + (mode === "avg" ? "・最高 " + f3(s.best) : "");
      v.append(el("button", { class: "row", type: "button", onclick: () => go("song/" + s.key) },
        el("span", { class: "no" + (i < 3 ? " top" : ""), text: i + 1 }),
        el("div", { class: "m" }, el("div", { class: "t1", text: s.title }), el("div", { class: "t2", text: s.artist })),
        el("div", {}, el("div", { class: "score s", style: mode === "count" ? "color:var(--text)" : null, text: main }), el("div", { class: "sub-r", text: sub }))));
    });
  }

  // ⑤ おすすめ
  let lotto = null;
  function viewRecommend(v) {
    setTitle("おすすめ");
    const I = index(); const today = logicalToday();
    const all = [...I.songs.values()];
    const notToday = (s) => s.last !== today;
    const row = (s, why) => el("button", { class: "row", type: "button", onclick: () => go("song/" + s.key) },
      el("div", { class: "m" }, el("div", { class: "t1", text: s.title }), el("div", { class: "t2", text: s.artist + (s.yomi ? "　" + s.yomi : "") }),
        why ? el("div", { class: "t2", text: why }) : null),
      s.count ? el("div", { class: "score s", text: f3(s.avg) }) : null);
    v.append(el("div", { class: "sec-h" }, "🔥 得意な曲", el("span", { class: "note", text: "平均点が高い" })));
    const good = all.filter((s) => s.count >= 2 && notToday(s)).sort((a, b) => b.avg - a.avg).slice(0, 3);
    if (good.length) good.forEach((s) => v.append(row(s, `平均 ${f3(s.avg)}・${s.count}回`)));
    else v.append(el("div", { class: "card muted", text: "2回以上歌った曲が出てくると、ここに並びます" }));
    v.append(el("div", { class: "sec-h" }, "⏳ 久しぶりの曲", el("span", { class: "note", text: "60日以上歌っていない" })));
    const old = all.filter((s) => s.count && daysBetween(s.last, today) >= 60).sort((a, b) => b.avg - a.avg).slice(0, 3);
    if (old.length) old.forEach((s) => v.append(row(s, `最後は ${s.last.replace(/-/g, "/")}（${ago(s.last)}）`)));
    else v.append(el("div", { class: "card muted", text: "60日以上歌っていない曲はまだありません" }));
    const unsung = all.filter((s) => s.inList && !s.count);
    v.append(el("div", { class: "sec-h" }, "🆕 まだ歌っていない曲",
      unsung.length > 3 ? el("button", { class: "link", type: "button", text: "↻ ほかの曲", onclick: () => { lotto = null; render(); } }) : el("span", { class: "note", text: "曲リストから" })));
    if (!unsung.length) { v.append(el("div", { class: "card muted", text: (data.songs.songs || []).length ? "曲リストの曲は全部歌いました" : "曲リストがまだ届いていません（同期すると届きます）" })); return; }
    if (!lotto || lotto.some((k) => !unsung.find((s) => s.key === k))) {
      const pool = [...unsung]; lotto = [];
      while (lotto.length < 3 && pool.length) lotto.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0].key);
    }
    for (const k of lotto) { const s = I.songs.get(k); if (s) v.append(row(s, (s.tags || []).join("・"))); }
  }

  // 曲の一覧
  let songQuery = "";
  function viewSongs(v) {
    setTitle("曲");
    const sortBy = getUI().songSort || "yomi";
    const input = el("input", { class: "input", type: "search", placeholder: "曲名・よみがな・歌手で探す", "aria-label": "曲を探す", enterkeyhint: "search" });
    input.value = songQuery;
    const seg = el("div", { class: "seg" });
    for (const [k, name] of [["yomi", "よみがな順"], ["recent", "最近歌った順"], ["count", "回数順"]]) {
      seg.append(el("button", { type: "button", class: sortBy === k ? "on" : "", text: name, onclick: () => { setUI({ songSort: k }); render(true); } }));
    }
    const list = el("div", { class: "songs-list" });
    const wrap = el("div", { class: "songs-wrap" }, list);
    v.append(el("div", { class: "search-wrap" }, input, seg), wrap);
    const all = [...index().songs.values()];
    const draw = () => {
      const q = norm(songQuery);
      let items = all;
      if (q) {
        const pre = [], mid = [];
        for (const s of all) {
          const ys = [norm(s.yomi), norm(s.artistYomi)];
          if (ys.some((y) => y && y.startsWith(q)) || norm(s.title).startsWith(q)) pre.push(s);
          else if ([s.yomi, s.title, s.artist, s.artistYomi].some((t) => norm(t).includes(q))) mid.push(s);
        }
        const byYomi = (a, b) => a.sortYomi.localeCompare(b.sortYomi, "ja");
        items = [...pre.sort(byYomi), ...mid.sort(byYomi)];
      } else {
        items = [...all].sort(sortBy === "recent" ? (a, b) => (b.last || "").localeCompare(a.last || "") || a.sortYomi.localeCompare(b.sortYomi, "ja")
          : sortBy === "count" ? (a, b) => b.count - a.count || (b.avg || 0) - (a.avg || 0)
          : (a, b) => a.sortYomi.localeCompare(b.sortYomi, "ja"));
      }
      list.replaceChildren();
      const marks = {};
      if (!items.length) list.append(empty("見つかりませんでした"));
      for (const s of items.slice(0, 600)) {
        const row = el("button", { class: "row" + (s.count ? "" : " unsung"), type: "button", onclick: () => go("song/" + s.key) },
          el("div", { class: "m" }, el("div", { class: "t1" }, s.title, s.inList ? null : el("span", { class: "mi", text: "リスト外" })),
            el("div", { class: "t2", text: s.artist })),
          s.count ? el("div", {}, el("div", { class: "score s", text: f3(s.best) }), el("div", { class: "sub-r", text: s.count + "回" }))
            : el("span", { class: "mi", text: "未" }));
        if (!q && sortBy === "yomi") {
          const c = s.sortYomi.charAt(0);
          const rowKey = (KANA_ROWS.find(([, cs]) => cs.includes(c)) || ["英"])[0];
          if (!marks[rowKey]) { marks[rowKey] = row; row.dataset.kana = rowKey; }
        }
        list.append(row);
      }
      const old = wrap.querySelector(".kana-idx"); if (old) old.remove();
      if (!q && sortBy === "yomi" && items.length > 20) {
        const ki = el("div", { class: "kana-idx", "aria-label": "頭文字で飛ぶ" });
        for (const [k] of [...KANA_ROWS, ["英"]]) {
          if (!marks[k]) continue;
          ki.append(el("button", { type: "button", text: k, onclick: () => {
            const y = marks[k].getBoundingClientRect().top + window.scrollY - 160;
            window.scrollTo(0, y);
          } }));
        }
        wrap.append(ki);
      }
    };
    let t = null;
    input.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { songQuery = input.value; draw(); }, 120); });
    draw();
  }

  // 手で足す
  function viewAdd(v) {
    setTitle("記録を足す");
    const I = index();
    let picked = route.arg && I.songs.get(route.arg) ? I.songs.get(route.arg) : null;
    let free = null; // {title, artist}
    let touched = false;
    leaveGuard = () => !touched || confirm("打ちかけの記録を破棄しますか？");
    const date = el("input", { class: "input", type: "date" }); date.value = logicalToday();
    const songBox = el("div");
    const total = el("input", { class: "input", type: "text", inputmode: "decimal", placeholder: "例: 86.935", "aria-label": "点数" });
    const err = el("div", { class: "err-text" });
    let key = 0;
    const keyOut = el("output", { text: keyText(0) });
    const stepKey = (d) => { key = Math.max(-7, Math.min(7, key + d)); keyOut.textContent = keyText(key); touched = true; };
    const memo = el("textarea", { class: "input", rows: 2 });
    const more = {};
    const moreGrid = el("div", { class: "edit-grid" });
    for (const [f, name, lo, hi, step] of NUM_EDIT) {
      if (f === "total") continue;
      const inp = el("input", { class: "input", type: "text", inputmode: step < 1 || lo < 0 ? "decimal" : "numeric", "aria-label": name });
      more[f] = { inp, lo, hi, step };
      moreGrid.append(el("label", { class: "field" }, el("span", { text: name }), inp));
    }
    for (const n of [date, total, memo]) n.addEventListener("input", () => { touched = true; });
    const drawSong = () => {
      songBox.replaceChildren();
      if (picked || free) {
        const s = picked || free;
        songBox.append(el("div", { class: "row", style: "cursor:default" }, el("div", { class: "m" }, el("div", { class: "t1", text: s.title }), el("div", { class: "t2", text: s.artist || "（歌手なし）" })),
          el("button", { class: "btn small", type: "button", text: "変える", onclick: () => { picked = null; free = null; drawSong(); } })));
        return;
      }
      const q = el("input", { class: "input", type: "search", placeholder: "曲名・よみがなで探す", "aria-label": "曲を探す" });
      const res = el("div");
      const artist = el("input", { class: "input", type: "text", placeholder: "歌手（わかれば）", "aria-label": "歌手" });
      const drawRes = () => {
        res.replaceChildren();
        const k = norm(q.value);
        if (!k) return;
        const hits = [...I.songs.values()].filter((s) => norm(s.yomi).startsWith(k) || norm(s.title).includes(k) || norm(s.yomi).includes(k)).slice(0, 8);
        for (const s of hits) res.append(el("button", { class: "row", type: "button", onclick: () => { picked = s; touched = true; drawSong(); } },
          el("div", { class: "m" }, el("div", { class: "t1", text: s.title }), el("div", { class: "t2", text: s.artist })), s.inList ? null : el("span", { class: "mi", text: "リスト外" })));
        res.append(el("div", { class: "card" }, el("div", { class: "muted", text: "リストにない曲なら、歌手を入れて足せます" }), artist,
          el("button", { class: "btn full", type: "button", style: "margin-top:8px", text: "「" + q.value.trim() + "」をリストにない曲として足す", onclick: () => {
            free = { title: q.value.trim(), artist: artist.value.trim() }; touched = true; drawSong();
          } })));
      };
      q.addEventListener("input", () => { touched = true; drawRes(); });
      songBox.append(q, res);
    };
    drawSong();
    v.append(el("div", { class: "card" },
      el("label", { class: "field" }, el("span", { text: "歌った日" }), date),
      el("div", { class: "field" }, el("span", { text: "曲" }), songBox),
      el("label", { class: "field" }, el("span", { text: "点数（必ず）" }), total),
      el("div", { class: "field" }, el("span", { text: "キー" }), el("div", { class: "stepper" },
        el("button", { type: "button", text: "−", "aria-label": "キーを下げる", onclick: () => stepKey(-1) }), keyOut,
        el("button", { type: "button", text: "＋", "aria-label": "キーを上げる", onclick: () => stepKey(1) }))),
      el("label", { class: "field" }, el("span", { text: "メモ" }), memo),
      el("details", {}, el("summary", { class: "muted", text: "内訳も入れる（任意）" }), moreGrid), err));
    const toNum = (s) => { s = s.trim().replace(/[−ー－]/g, "-").replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)); return s === "" ? null : Number(s); };
    v.append(el("div", { class: "btns" }, el("button", { class: "btn", type: "button", text: "やめる", onclick: () => goBack() }),
      el("button", { class: "btn p", type: "button", text: "足す", onclick: () => {
        const s = picked || free;
        const t = toNum(total.value);
        total.classList.remove("bad");
        if (!s || !s.title) { err.textContent = "曲を選んでください"; return; }
        if (t === null || !isFinite(t) || t < 0 || t > 100) { total.classList.add("bad"); err.textContent = "点数は 0〜100 の数で入れてください"; return; }
        const rec = { sungDate: date.value || logicalToday(), title: s.title, artist: s.artist || "", variant: null,
          songId: picked && picked.inList ? picked.key : null, total: Math.round(t * 1000) / 1000, key, memo: memo.value.trim() };
        for (const [f, o] of Object.entries(more)) {
          const val = toNum(o.inp.value);
          if (val === null) continue;
          if (!isFinite(val) || val < o.lo || val > o.hi || Math.abs(val / o.step - Math.round(val / o.step)) > 1e-6) { o.inp.classList.add("bad"); err.textContent = "赤い欄の数を確かめてください"; return; }
          rec[f] = val;
        }
        const r = addRecord(rec);
        touched = false;
        go("rec/" + r.id, true);
        toast("記録を足しました");
      } })));
  }

  // 設定・つなぐ
  function connForm(v, isFirst) {
    const s = getSettings();
    const owner = el("input", { class: "input", type: "text", autocomplete: "off", autocapitalize: "off", spellcheck: "false" }); owner.value = s.owner;
    const repo = el("input", { class: "input", type: "text", autocomplete: "off", autocapitalize: "off", spellcheck: "false" }); repo.value = s.repo;
    const token = el("input", { class: "input", type: "password", autocomplete: "off", placeholder: s.token ? "（入っています。変えるときだけ貼る）" : "github_pat_…", "aria-label": "トークン" });
    const msg = el("div", { class: "muted", style: "margin-top:8px" });
    const test = async () => {
      const next = { owner: owner.value.trim(), repo: repo.value.trim(), token: token.value.trim() || s.token };
      if (!next.token) { msg.textContent = "トークンを貼ってください"; return; }
      msg.textContent = "確かめています…";
      try {
        await api("GET", null, { settings: next });
        if (next.owner !== s.owner || next.repo !== s.repo) setMeta({ shas: {} }); // 別のリポジトリ: 前の sha を使わない
        setSettings(next); token.value = ""; lastError = null;
        setMeta({ skipConnect: false });
        try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* なくてよい */ }
        msg.textContent = "つながりました";
        toast("GitHub とつながりました");
        await sync();
        if (isFirst) go("records", true); else render(true);
      } catch (e) {
        msg.textContent = e.kind === "auth" ? "トークンが使えません。期限・リポジトリ・権限（Contents の読み書き）を確かめてください"
          : e.kind === "notfound" ? "リポジトリが見つかりません。名前と、トークンで選んだリポジトリを確かめてください"
          : (e.message || String(e));
      }
    };
    v.append(el("div", { class: "card" },
      el("label", { class: "field" }, el("span", { text: "GitHub のユーザー名" }), owner),
      el("label", { class: "field" }, el("span", { text: "データのリポジトリ" }), repo),
      el("label", { class: "field" }, el("span", { text: "トークン（fine-grained、utalog-data の Contents を読み書き）" }), token),
      el("button", { class: "btn p full", type: "button", text: "つないで確かめる", onclick: test }), msg));
  }
  function viewConnect(v) {
    setTitle("Utalog");
    v.append(el("div", { class: "connect" }, el("h2", { text: "GitHub とつなぐ" }),
      el("p", { text: "記録は GitHub の非公開リポジトリ（utalog-data）に置きます。スマホと PC で同じ記録を見るために、最初に1回だけトークンを貼ります。" }),
      el("p", { text: "トークンはこの端末の中にだけ保存し、ほかには送りません。" })));
    connForm(v, true);
    v.append(el("button", { class: "btn full", type: "button", style: "margin-top:8px", text: "あとで（この端末だけで使う）", onclick: () => { setMeta({ skipConnect: true }); go("records", true); } }));
  }
  function viewSettings(v) {
    setTitle("設定");
    const m = getMeta();
    const status = !configured() ? "まだつないでいません" : syncing ? "同期中" : lastError ? "同期できません: " + lastError.message
      : m.pending ? "未送信 " + m.pending + "件" : "同期済み" + (m.lastSyncTime ? "（" + new Date(m.lastSyncTime).toLocaleString("ja-JP") + "）" : "");
    v.append(el("div", { class: "sec-h" }, "同期"), el("div", { class: "card" }, el("div", { text: status }),
      configured() ? el("button", { class: "btn full", type: "button", style: "margin-top:10px", text: "もう一度・今すぐ同期", onclick: async () => { await sync(); render(true); } }) : null));
    v.append(el("div", { class: "sec-h" }, "GitHub の接続"));
    connForm(v, false);
    v.append(el("p", { class: "muted", text: "トークンには期限があります（作るときに決めた日）。切れると「同期できません」と出るので、同じ手順で作り直して、ここに貼り直してください。" }));
    v.append(el("p", { class: "muted", text: "Utalog " + BUILD + "・記録 " + index().recs.length + "件・曲リスト " + (data.songs.songs || []).length + "曲" }));
  }

  // ---------- 始める ----------
  window.addEventListener("online", () => scheduleSync(500));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") scheduleSync(300); });
  window.addEventListener("storage", (e) => { if (e.key === K.data) { data = readJSON(K.data, null) || defaultData(); invalidate(); softRender(); } });
  if (!history.state) history.replaceState({ depth: 0 }, "", location.hash || "#/" + curTab);
  render(true);
  if (configured()) sync();
  if ("serviceWorker" in navigator && !isDev) navigator.serviceWorker.register("./sw.js").catch(() => {});
  if ("serviceWorker" in navigator && isDev && location.search.includes("sw=1")) navigator.serviceWorker.register("./sw.js").catch(() => {});
})();
