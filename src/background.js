// NAPR Cadastral & Auction Lookup - merged extension (maps.gov.ge + ms.gov.ge + registry + auction)
//
// Actions (one name per thing the user can do; used by the popup, menus, shortcuts and history):
//   maps-map  / maps-kml   -> maps.gov.ge map (add to the open map tab / new tab) and KML files
//   ms-map    / ms-kml     -> ms.gov.ge map and KML files
//   pdf / plan / abstract  -> registry viewer (latest / N-th extract, cadastral plan) / extract list page (cad_amo.php)
//   auction                -> Tbilisi auction lot

// ======================= network: no request may hang =======================
// The maps sometimes stop answering. Without a limit a command would wait for minutes (Chrome's own limit),
// so every request to a map / registry server gives up after NETWORK_TIMEOUT_MS with a readable error.
const NETWORK_TIMEOUT_MS = 15000;

async function fetchWithTimeout(url, options = {}, timeoutMs = NETWORK_TIMEOUT_MS) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
      let host = "სერვერი";
      try { host = new URL(url).host; } catch (e) { /* relative or odd url */ }
      throw new Error(`${host}: ${timeoutMs / 1000} წამში არ უპასუხა`);
    }
    throw err;
  }
}

const BASE_URL = "https://abstract.reestri.gov.ge/abstract/cad_amo.php?cad_code=";
const AUCTION_URL = "https://auction.tbilisi.gov.ge/Pages/Auctions/Lot.aspx?id=";

// Cadastral codes like 01.10.12.001.001, optionally ending with ONE Georgian letter
// (e.g. 01.16.05.001.003ა). Georgian Mkhedruli range: U+10D0 (ა) .. U+10F0 (ჰ).
const CADASTRAL_REGEX = /\d+(?:\.\d+){2,9}[\u10D0-\u10F0]?/;

function extractValidCadastralCode(text) {
  if (!text) return null;
  const match = text.trim().match(CADASTRAL_REGEX);
  return match ? match[0] : null;
}

// All cadastral codes in a text, in order, without duplicates.
function extractAllCadastralCodes(text) {
  if (!text) return [];
  const all = text.match(new RegExp(CADASTRAL_REGEX.source, "g")) || [];
  return [...new Set(all)];
}

// Auction lot id = the digits the user selected (usually the tail of the contract number).
// Pure digits (spaces ignored) -> used as is; otherwise the LAST run of digits in the selection.
function extractAuctionId(text) {
  if (!text) return null;
  const t = text.trim();
  const compact = t.replace(/\s+/g, "");
  if (/^\d+$/.test(compact)) return compact;
  const runs = t.match(/\d+/g);
  return runs ? runs[runs.length - 1] : null;
}

// ---- Mode "map": open the parcel on maps.gov.ge ----
const MAP_BASE = "https://maps.gov.ge";

function flashBadge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 3500);
}

// Same parameters the portal itself sends. For a code the map view is irrelevant; for a point search
// ("lon,lat") the view must be close to the point, otherwise the answer is a zone, not a parcel.
function buildMapSearchBody(code, point = null) {
  const p = new URLSearchParams();
  p.set("keyword", code);
  if (point) {
    const R = 6378137, x = point.lon * Math.PI / 180 * R, y = Math.log(Math.tan(Math.PI / 4 + point.lat * Math.PI / 360)) * R;
    p.append("keyword_description[coords][]", String(point.lon));
    p.append("keyword_description[coords][]", String(point.lat));
    p.set("keyword_description[zoom]", "19");
    for (const v of [x - 300, y - 150, x + 300, y + 150]) p.append("keyword_description[bbox][]", String(v));
  } else {
    p.append("keyword_description[coords][]", "43.50440835585885");
    p.append("keyword_description[coords][]", "42.13098999999999");
    p.set("keyword_description[zoom]", "8");
    for (const v of ["4255852.20820669", "4899638.835397534", "5429924.962666997", "5461603.86735015"]) {
      p.append("keyword_description[bbox][]", v);
    }
  }
  p.set("keyword_description[screen_width]", "1920");
  p.set("keyword_description[screen_height]", "1080");
  p.set("keyword_description[projection]", "EPSG:4326");
  p.set("keyword_description[orientation_angle]", "0");
  p.set("keyword_description[getinfo_type]", "");
  p.append("keyword_description[layers][]", "92");
  p.append("keyword_description[layers][]", "97");
  p.set("keyword_description[lang]", "ka");
  return p;
}

// Search by cadastral code. Returns { lbl, address, geometryPath } or null if not found.
// Throws on network/format errors.
async function searchParcel(code) {
  const res = await fetchWithTimeout(`${MAP_BASE}/map/portal/search`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest"
    },
    body: buildMapSearchBody(code),
    credentials: "include"
  });
  if (!res.ok) throw new Error(`სერვერმა დააბრუნა HTTP ${res.status}`);

  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error("პასუხი JSON არ არის (პორტალი შესაძლოა დროებით მიუწვდომელია)");
  }
  if (!json.status) throw new Error("სერვერმა status=false დააბრუნა");

  // Exact match only; never pick a "similar" record.
  const hit = (json.result || []).find((r) => r.name === code);
  if (!hit) return null;

  const details = hit.details || {};
  const link = details.info_link || hit.resultlink || "";
  // ROWID is base64 and may contain "+" and "/". URLSearchParams would turn "+" into a space,
  // so lbl is cut out of the raw string; decodeURIComponent keeps "+" as is
  // (and also handles a server that already sends it as %2B).
  const lblMatch = link.match(/[?&]lbl=([^&#]+)/);
  if (!lblMatch) throw new Error("პასუხში lbl ვერ ვიპოვე");
  let lbl;
  try {
    lbl = decodeURIComponent(lblMatch[1]); // lr_parcels:AAAr...
  } catch {
    lbl = lblMatch[1];
  }
  return {
    lbl,
    address: hit.descript || "",
    // the server hands us the ready-made geometry link (already contains &res=shp)
    // Sent exactly as the portal sends it: a literal "+" in the ROWID. The server does NOT decode
    // %2B back to "+" (it then returns an empty "data" list), so the ROWID must not be re-encoded.
    geometryPath: details.geometry_link || `/lr/bo/mg/getinfo.alpha?lbl=${lbl}&res=shp`
  };
}

// Returns the map URL, or null if the code was not found.
async function resolveMapUrl(code) {
  const parcel = await searchParcel(code);
  if (!parcel) return null;
  return mapsUrlForLbl(parcel.lbl);
}

function mapsUrlForLbl(lbl) {
  return `${MAP_BASE}/map/portal#search/result/lr/bo/mg/getinfo.alpha?lbl=${lbl}&share=1&layers=92,97`;
}


// ======================= ms.gov.ge =======================

const MS_BASE = "https://ms.gov.ge";
const MS_SEARCH_URL = MS_BASE + "/core-api/v1/search/unified-search";
// The search works without any token (checked 2026-10-22: a visitor who never signed in to the
// government SSO has none, and the site itself then searches without one). If this browser does have
// its own ms.gov.ge session (localStorage "session-token", reported by content_ms.js), it is sent
// along like the site does; a rejected token is dropped and the search repeated without it.
const MS_TOKEN_KEY = "msSessionToken";
const MS_MAP_ZOOM = 19;
const MS_TAB_PATTERN = "https://ms.gov.ge/msmap/*";


// ---- ms.gov.ge search ----

async function storedMsToken() {
  const data = await chrome.storage.local.get(MS_TOKEN_KEY);
  return (data[MS_TOKEN_KEY] && data[MS_TOKEN_KEY].token) || null;
}

function msSearchRequest(code, token) {
  const headers = { "accept": "*/*", "content-type": "application/json" };
  if (token) headers["sso-token"] = token;
  return fetchWithTimeout(MS_SEARCH_URL, { method: "POST", headers, body: JSON.stringify({ searchText: code }), credentials: "omit" });
}

// Returns { code, wkt, appRegNum } or null if the code was not found. Throws on errors.
async function searchMsParcel(code) {
  const token = await storedMsToken();
  let res = await msSearchRequest(code, token);
  if (token && (res.status === 401 || res.status === 403)) {
    // this browser's session expired: forget it and search the way a visitor without one does
    await chrome.storage.local.remove(MS_TOKEN_KEY);
    res = await msSearchRequest(code, null);
  }
  if (res.status === 401 || res.status === 403) throw new Error(`ms.gov.ge-მ ძიებაზე უარი თქვა (HTTP ${res.status})`);
  if (!res.ok) throw new Error(`სერვერმა დააბრუნა HTTP ${res.status}`);

  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error("პასუხი JSON არ არის (პორტალი შესაძლოა დროებით მიუწვდომელია)");
  }

  const r = json && json.naprSearchResult;
  // Not found = naprSearchResult with all fields null. Exact match only.
  if (!r || r.cadCode !== code) return null;
  if (!r.wktShape) throw new Error(`კოდი ${code} მოიძებნა, მაგრამ გეომეტრია არ დაბრუნდა`);
  return { code: r.cadCode, wkt: r.wktShape, appRegNum: r.appRegNum || "" };
}

// The portal's own link centres on the middle of the parcel's bounding box:
// https://ms.gov.ge/msmap/#C=<lon>-<lat>@Z=<zoom>
function msMapUrl(polygons) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const poly of polygons) {
    for (const ring of poly) {
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }
  const lon = ((minLon + maxLon) / 2).toFixed(7);
  const lat = ((minLat + maxLat) / 2).toFixed(7);
  return `${MS_BASE}/msmap/#C=${lon}-${lat}@Z=${MS_MAP_ZOOM}`;
}


// ======================= KML (shared by both maps) =======================

// ---- KML export ----

// WKT "POLYGON ((x y, x y, ...), (hole...))" or "MULTIPOLYGON (((...)), ((...)))"
// -> [ [ring, ring...], ... ]  (one entry per polygon; first ring = outer, rest = holes).
// A ring is an array of [lon, lat].
function parseWktPolygons(wkt) {
  const text = String(wkt || "").trim();
  const m = text.match(/^(MULTIPOLYGON|POLYGON)\s*(?:Z|M|ZM)?\s*(\(.*\))\s*$/is);
  if (!m) throw new Error("გეომეტრიის ფორმატი ვერ ამოვიცანი (მხოლოდ POLYGON/MULTIPOLYGON მხარდაჭერილია)");

  // Pull out every "(...)" group that has no nested parentheses = one ring each,
  // remembering which polygon it belongs to via the nesting depth.
  const polygons = [];
  let depth = 0, buf = "", current = null;
  const isMulti = m[1].toUpperCase() === "MULTIPOLYGON";
  const polyDepth = isMulti ? 2 : 1; // depth at which a polygon's ring list opens
  for (const ch of m[2]) {
    if (ch === "(") {
      depth++;
      if (depth === polyDepth) { current = []; polygons.push(current); }
      buf = "";
    } else if (ch === ")") {
      if (depth === polyDepth + 1) current.push(parseRing(buf));
      depth--;
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (!polygons.length || polygons.some((p) => !p.length)) throw new Error("გეომეტრია ცარიელია");
  return polygons;
}

function parseRing(str) {
  const ring = str.split(",").map((pair) => {
    const nums = pair.trim().split(/\s+/).map(Number);
    if (nums.length < 2 || nums.some((n) => Number.isNaN(n))) throw new Error("კოორდინატის წაკითხვა ვერ მოხერხდა");
    return [nums[0], nums[1]]; // lon, lat (extra Z ignored)
  });
  const a = ring[0], b = ring[ring.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) ring.push([a[0], a[1]]); // KML requires closed rings
  return ring;
}

function xmlEscape(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function ringToKml(ring) {
  return ring.map(([lon, lat]) => `${lon},${lat},0`).join(" ");
}

// <Polygon> or <MultiGeometry> for [[outer, ...holes], ...]
function polygonsGeometryXml(polygons) {
  const polyXml = polygons.map(([outer, ...holes]) => {
    const inner = holes.map((h) =>
      `\n        <innerBoundaryIs><LinearRing><coordinates>${ringToKml(h)}</coordinates></LinearRing></innerBoundaryIs>`
    ).join("");
    return `      <Polygon>
        <outerBoundaryIs><LinearRing><coordinates>${ringToKml(outer)}</coordinates></LinearRing></outerBoundaryIs>${inner}
      </Polygon>`;
  });
  return polyXml.length === 1 ? polyXml[0] : `      <MultiGeometry>\n${polyXml.join("\n")}\n      </MultiGeometry>`;
}

function buildKml(code, address, polygons) {
  const polyXml = polygons.map(([outer, ...holes]) => {
    const inner = holes.map((h) =>
      `\n        <innerBoundaryIs><LinearRing><coordinates>${ringToKml(h)}</coordinates></LinearRing></innerBoundaryIs>`
    ).join("");
    return `      <Polygon>
        <outerBoundaryIs><LinearRing><coordinates>${ringToKml(outer)}</coordinates></LinearRing></outerBoundaryIs>${inner}
      </Polygon>`;
  });
  const geometry = polyXml.length === 1
    ? polyXml[0]
    : `      <MultiGeometry>\n${polyXml.join("\n")}\n      </MultiGeometry>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${xmlEscape(code)}</name>
    <Style id="parcel">
      <LineStyle><color>ff0000ff</color><width>2</width></LineStyle>
      <PolyStyle><color>400000ff</color></PolyStyle>
    </Style>
    <Placemark>
      <name>${xmlEscape(code)}</name>
      <description>${xmlEscape(address)}</description>
      <styleUrl>#parcel</styleUrl>
${geometry}
    </Placemark>
  </Document>
</kml>
`;
}

// Fetch the parcel's geometry and return { kml, polygons } (null if the code was not found).
async function buildKmlForCode(code) {
  const parcel = await fetchMapsParcelPolygons(code);
  return parcel ? { kml: buildKml(code, parcel.address, parcel.polygons), polygons: parcel.polygons } : null;
}

// maps.gov.ge: the parcel's contour -> { polygons, address } (null if the code was not found).
async function fetchMapsParcelPolygons(code) {
  const parcel = await searchParcel(code);
  if (!parcel) return null;

  // Plain string concatenation on purpose: keeps "lr_parcels:ROWID" exactly as the portal sends it
  // (URL.searchParams would re-encode the colon as %3A).
  let geometryUrl = MAP_BASE + parcel.geometryPath;
  if (!/[?&]lang=/.test(geometryUrl)) geometryUrl += "&lang=ka";
  const res = await fetchWithTimeout(geometryUrl, { credentials: "include" });
  if (!res.ok) throw new Error(`გეომეტრიის მოთხოვნამ დააბრუნა HTTP ${res.status}`);

  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error("გეომეტრიის პასუხი JSON არ არის");
  }
  const item = (json.data || []).find((d) => d.name === code) || (json.data || [])[0];
  if (!item || !item.shape) throw new Error("ამ კოდზე გეომეტრია არ დაბრუნდა");
  if (item.shape_format && item.shape_format !== "WKT") throw new Error(`უცნობი გეომეტრიის ფორმატი: ${item.shape_format}`);
  if (item.proj && item.proj !== "EPSG:4326") throw new Error(`მოულოდნელი კოორდინატთა სისტემა: ${item.proj} (მხოლოდ EPSG:4326 მხარდაჭერილია)`);

  return { polygons: parseWktPolygons(item.shape), address: parcel.address };
}


// ======================= history =======================

const HISTORY_KEY = "history";
const HISTORY_MAX = 10000;
let historyQueue = Promise.resolve(); // serialise writes so parallel jobs don't overwrite each other

function addHistory(action, results) {
  const now = Date.now();
  const rows = results.map((r) => {
    const row = { t: now, action, code: r.code, status: r.status, error: r.error || "" };
    if (r.from) row.from = r.from; // Map Jump: page it came from
    if (r.to) row.to = r.to;       // Map Jump: page it opened
    if (r.place) row.place = r.place; // Map Jump: { lat, lon, zoom, how }
    if (r.url) row.to = r.url;     // registry / auction: the page that was opened
    if (r.doc) row.doc = r.doc;    // ms.gov.ge application: its document page
    if (r.note) row.note = r.note; // contours: where the contour came from (a map / the cadastral plan of <date>)
    if (Array.isArray(r.items)) row.items = r.items; // ms.gov.ge application: contours (code, address, link)
    return row;
  });
  historyQueue = historyQueue.then(async () => {
    const data = await chrome.storage.local.get(HISTORY_KEY);
    const list = (data[HISTORY_KEY] || []).concat(rows);
    await chrome.storage.local.set({ [HISTORY_KEY]: list.slice(-HISTORY_MAX) });
  }).catch((err) => console.error("History write failed:", err));
  return historyQueue;
}

// ---- import (from history.html) ----

// Only known fields, sane lengths, and links that are plain http(s) (a shared file must not be able
// to put e.g. a "javascript:" link into the history page).
function cleanImportedRow(r) {
  if (!r || typeof r !== "object") return null;
  const t = Number(r.t);
  if (!Number.isFinite(t) || t <= 0) return null;
  const str = (v, max) => (typeof v === "string" || typeof v === "number") ? String(v).slice(0, max) : "";
  const action = str(r.action, 40), code = str(r.code, 300), status = str(r.status, 20);
  if (!action || !code || !status) return null;
  const row = { t, action, code, status, error: str(r.error, 500) };
  const url = (v) => (typeof v === "string" && /^https?:\/\//i.test(v)) ? v.slice(0, 3000) : null;
  const from = url(r.from), to = url(r.to);
  if (from) row.from = from;
  if (to) row.to = to;
  const doc = url(r.doc);
  if (doc) row.doc = doc;
  if (Array.isArray(r.items)) {
    row.items = r.items.slice(0, 100).filter((it) => it && typeof it === "object").map((it, i) => ({
      row: Number.isInteger(it.row) ? it.row : i, type: str(it.type, 300), cad: str(it.cad, 60), address: str(it.address, 300), link: url(it.link) || "",
      center: Array.isArray(it.center) && it.center.length === 2 && it.center.every((n) => typeof n === "number" && Number.isFinite(n)) ? it.center : null
    }));
  }
  const p = r.place;
  if (p && typeof p === "object" && [p.lat, p.lon, p.zoom].every((n) => typeof n === "number" && Number.isFinite(n))) {
    row.place = { lat: p.lat, lon: p.lon, zoom: p.zoom, how: str(p.how, 100) };
  }
  return row;
}

const historyRowKey = (r) => `${r.t}|${r.action}|${r.code}|${r.status}`;

// mode "add": merge, skipping rows that are already there; mode "replace": the file becomes the history.
// markImported: rows get { imported: { file, at } } (shown and filterable as "imported");
// otherwise they count as the user's own rows.
function importHistory(rows, mode, markImported, fileName) {
  let result = { ok: false, error: "უცნობი შეცდომა" };
  historyQueue = historyQueue.then(async () => {
    const existing = mode === "replace" ? [] : ((await chrome.storage.local.get(HISTORY_KEY))[HISTORY_KEY] || []);
    const seen = new Set(existing.map(historyRowKey));
    const stamp = Date.now();
    let added = 0, skipped = 0, invalid = 0;
    const incoming = [];
    for (const raw of Array.isArray(rows) ? rows : []) {
      const row = cleanImportedRow(raw);
      if (!row) { invalid++; continue; }
      const key = historyRowKey(row);
      if (seen.has(key)) { skipped++; continue; }
      seen.add(key);
      if (markImported) row.imported = { file: String(fileName || "").slice(0, 200), at: stamp };
      incoming.push(row);
      added++;
    }
    const merged = existing.concat(incoming).sort((a, b) => a.t - b.t);
    const dropped = Math.max(0, merged.length - HISTORY_MAX);
    await chrome.storage.local.set({ [HISTORY_KEY]: merged.slice(-HISTORY_MAX) });
    result = { ok: true, added, skipped, invalid, dropped, total: merged.length - dropped };
  }).catch((err) => { result = { ok: false, error: err.message }; });
  return historyQueue.then(() => result);
}

// v2.12/2.13 kept maps.gov.ge history under "mapsHistory" with actions "map"/"kml": move it over once.
function migrateOldHistory() {
  historyQueue = historyQueue.then(async () => {
    const data = await chrome.storage.local.get(["mapsHistory", HISTORY_KEY]);
    if (!data.mapsHistory) return;
    const old = data.mapsHistory.map((r) => ({ ...r, action: r.action === "kml" ? "maps-kml" : r.action === "map" ? "maps-map" : r.action }));
    const merged = old.concat(data[HISTORY_KEY] || []).sort((a, b) => a.t - b.t).slice(-HISTORY_MAX);
    await chrome.storage.local.set({ [HISTORY_KEY]: merged });
    await chrome.storage.local.remove("mapsHistory");
    console.log(`History: moved ${old.length} old maps.gov.ge rows`);
  }).catch((err) => console.error("History migration failed:", err));
  return historyQueue;
}

// Small window listing the codes that were not found (closes with Enter / Esc).
async function showNotice(action, results) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const bad = results.filter((r) => r.status !== "found");
  await chrome.storage.session.set({
    ["notice_" + id]: { action, results: results.map(({ code, status, error }) => ({ code, status, error: error || "" })) }
  });
  const width = 460, height = Math.min(600, 230 + 26 * bad.length);
  const opts = { url: `notice.html#${id}`, type: "popup", width, height, focused: true };
  try {
    const w = await chrome.windows.getLastFocused();
    if (w && w.width && w.height) {
      opts.left = Math.max(0, Math.round(w.left + (w.width - width) / 2));
      opts.top = Math.max(0, Math.round(w.top + (w.height - height) / 3));
    }
  } catch (e) { /* default position */ }
  await chrome.windows.create(opts);
}

// Several codes -> notice window; a single code -> plain error text.
async function reportProblems(action, codes, results) {
  const bad = results.filter((r) => r.status !== "found");
  if (!bad.length) return null;
  const anyError = bad.some((r) => r.status === "error");
  flashBadge(codes.length > 1 ? "✗" + bad.length : (anyError ? "!" : "✗"), anyError ? "#b91c1c" : "#b45309");
  if (codes.length > 1) {
    await showNotice(action, results);
    return { notice: true };
  }
  const r = bad[0];
  return { error: r.status === "error" ? r.error : `კოდი ${r.code} ვერ მოიძებნა` };
}

// ======================= map tabs (shared) =======================
// "Add to the open map" always means: the most recently used tab OF THAT SITE.
// A maps.gov.ge command never looks at ms.gov.ge tabs and vice versa.

const MAPS_TAB_PATTERN = "https://maps.gov.ge/map/portal*";

async function findSiteTab(pattern) {
  const tabs = await chrome.tabs.query({ url: pattern });
  if (!tabs.length) return null;
  tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return tabs[0];
}

// If the tab has no content script yet (open before install/reload), inject it once and retry.
async function sendToContent(tabId, file, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    console.log(`${file} not reachable, injecting:`, err && err.message);
    await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

async function focusTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
}

// ======================= maps.gov.ge actions =======================
// The portal adds a parcel to its side panel (keeping the previous ones) every time the
// "#search/result/...getinfo.alpha?lbl=..." hash changes; content_maps.js does that in the tab.

async function openMapsMap(codes, newTab) {
  const results = [];
  for (const code of codes) {
    try {
      const parcel = await searchParcel(code);
      // url = the parcel's shareable maps.gov.ge link (kept in the history)
      results.push(parcel ? { code, status: "found", lbl: parcel.lbl, url: mapsUrlForLbl(parcel.lbl) } : { code, status: "missing" });
    } catch (err) {
      results.push({ code, status: "error", error: err.message });
    }
  }
  await addHistory("maps-map", results);
  const items = results.filter((r) => r.status === "found").map((r) => ({ code: r.code, lbl: r.lbl }));

  if (items.length) {
    try {
      const existing = newTab ? null : await findSiteTab(MAPS_TAB_PATTERN);
      if (existing) {
        await focusTab(existing);
        console.log(`[maps-map] adding ${items.map((i) => i.code).join(", ")} to tab ${existing.id}`);
        sendToContent(existing.id, "content_maps.js", { type: "maps-draw", items })
          .then((r) => console.log("[maps-map] draw result:", JSON.stringify(r)))
          .catch((err) => { console.error("Drawing in the open tab failed:", err); flashBadge("!", "#b91c1c"); });
      } else {
        const tab = await chrome.tabs.create({ url: mapsUrlForLbl(items[0].lbl), active: true });
        // the first parcel comes from the URL itself; content_maps.js adds the rest
        await chrome.storage.session.set({ ["pending_maps_" + tab.id]: items });
        if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
      }
    } catch (err) {
      console.error("Opening the maps.gov.ge map failed:", err);
      flashBadge("!", "#b91c1c");
      return { ok: false, error: err.message };
    }
  }
  // the notice window opens after the map tab, so it stays in front
  const problem = await reportProblems("maps-map", codes, results);
  return problem && problem.error ? { ok: false, error: problem.error } : { ok: true };
}

// One <code>.kml file per found code.
async function downloadMapsKml(codes) {
  const results = [];
  for (const code of codes) {
    try {
      const built = await buildKmlForCode(code);
      if (!built) {
        results.push({ code, status: "missing" });
        continue;
      }
      await saveKml(code, built.kml);
      results.push({ code, status: "found" });
    } catch (err) {
      console.error(`maps.gov.ge KML for ${code} failed:`, err);
      results.push({ code, status: "error", error: err.message });
    }
  }
  await addHistory("maps-kml", results);
  const problem = await reportProblems("maps-kml", codes, results);
  return problem && problem.error ? { ok: false, error: problem.error } : { ok: true };
}

// Service workers have no URL.createObjectURL, so the file goes out as a data: URL.
async function saveKml(code, kml) {
  const dataUrl = "data:application/vnd.google-earth.kml+xml;charset=utf-8," + encodeURIComponent(kml);
  await chrome.downloads.download({ url: dataUrl, filename: `${code}.kml`, saveAs: false });
}

// ======================= ms.gov.ge actions =======================
// The site draws a parcel only when its own "registered land parcels" search result is clicked;
// content_ms.js types the code into the site's search box and clicks that row. Outlines accumulate.

async function msLookupAll(codes) {
  const results = [];
  for (const code of codes) {
    try {
      const parcel = await searchMsParcel(code);
      results.push(parcel ? { code, status: "found", wkt: parcel.wkt } : { code, status: "missing" });
    } catch (err) {
      results.push({ code, status: "error", error: err.message });
    }
  }
  return results;
}

async function openMsMap(codes, newTab) {
  const results = await msLookupAll(codes);
  // url = where ms.gov.ge shows the parcel (kept in the history)
  for (const r of results) if (r.status === "found") r.url = msMapUrl(parseWktPolygons(r.wkt));
  await addHistory("ms-map", results);
  const found = results.filter((r) => r.status === "found");

  if (found.length) {
    try {
      const foundCodes = found.map((r) => r.code);
      const existing = newTab ? null : await findSiteTab(MS_TAB_PATTERN);
      if (existing) {
        await focusTab(existing);
        console.log(`[ms-map] adding ${foundCodes.join(", ")} to tab ${existing.id}`);
        sendToContent(existing.id, "content_ms.js", { type: "ms-draw", codes: foundCodes })
          .then((r) => console.log("[ms-map] draw result:", JSON.stringify(r)))
          .catch((err) => { console.error("Drawing in the open tab failed:", err); flashBadge("!", "#b91c1c"); });
      } else {
        const tab = await chrome.tabs.create({ url: msMapUrl(parseWktPolygons(found[0].wkt)), active: true });
        // content_ms.js in that tab picks the codes up and runs the site's own search
        await chrome.storage.session.set({ ["pending_ms_" + tab.id]: foundCodes });
        if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
      }
    } catch (err) {
      console.error("Opening the ms.gov.ge map failed:", err);
      flashBadge("!", "#b91c1c");
      return { ok: false, error: err.message };
    }
  }
  const problem = await reportProblems("ms-map", codes, results);
  return problem && problem.error ? { ok: false, error: problem.error } : { ok: true };
}

async function downloadMsKml(codes) {
  const results = await msLookupAll(codes);
  for (const r of results) {
    if (r.status !== "found") continue;
    try {
      await saveKml(r.code, buildKml(r.code, "", parseWktPolygons(r.wkt)));
    } catch (err) {
      console.error(`ms.gov.ge KML for ${r.code} failed:`, err);
      r.status = "error";
      r.error = "KML ვერ შეიქმნა: " + err.message;
    }
  }
  await addHistory("ms-kml", results);
  const problem = await reportProblems("ms-kml", codes, results);
  return problem && problem.error ? { ok: false, error: problem.error } : { ok: true };
}

// ======================= registry (PDF / extract page) and auction =======================

// Registry documents (extract / cadastral plan): viewer.html reads the cad_amo.php list and the PDFs itself,
// orders them by preparation time (not by list order) and shows the latest; N-th via keys / repeat shortcut.
const VIEWER_PAGE = "viewer.html";
const viewerUrl = (code, kind, n = 1) => chrome.runtime.getURL(`${VIEWER_PAGE}?code=${encodeURIComponent(code)}&kind=${kind}&n=${n}`);
async function openDocViewer(code, kind) {
  const tab = await chrome.tabs.create({ url: viewerUrl(code, kind), active: true });
  if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
  return { ok: true }; // history row is written by the viewer once it knows the result
}
// The active tab is a viewer -> the shortcut means "next (older)" there (or switch to the other kind)
async function stepActiveViewer(kind) {
  try {
    const win = await chrome.windows.getLastFocused();
    if (!win || !win.focused) return false;
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    if (!tab || !tab.url || !tab.url.startsWith(chrome.runtime.getURL(VIEWER_PAGE))) return false;
    await chrome.runtime.sendMessage({ type: "viewer-step", tabId: tab.id, kind }).catch(() => {});
    return true;
  } catch (e) {
    return false;
  }
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "doc-history") return;
  if (!sender.url || !sender.url.startsWith(chrome.runtime.getURL(VIEWER_PAGE))) return;
  const action = message.action === "plan" ? "plan" : "pdf";
  addHistory(action, [{ code: String(message.code || "").slice(0, 100), status: ["found", "missing", "error"].includes(message.status) ? message.status : "error",
    error: String(message.error || "").slice(0, 300), url: String(message.url || "") }]).then(() => sendResponse({ ok: true }));
  return true;
});

// A missing lot is answered with a tiny page whose whole text is "Error"; a real lot page is a
// full ASP.NET page. Network problems leave the row as "opened" (it could not be checked).
async function checkAuctionPage(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    const html = await res.text();
    clearTimeout(timer);
    if (!res.ok) return { status: "missing", error: `საიტმა დააბრუნა შეცდომა ${res.status}` };
    const plain = html.replace(/<(script|style|title)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (/^error$/i.test(plain)) return { status: "missing", error: "ლოტი ვერ მოიძებნა: საიტმა „Error“ გვერდი დააბრუნა" };
    return { status: "opened", error: "" };
  } catch (err) {
    console.log("Auction page check failed:", err && err.message);
    return { status: "opened", error: "" };
  }
}

// mode: "abstract" | "auction"
async function processAndOpen(value, mode) {
  let targetUrl, status = "opened", error = "";
  let check = null;
  if (mode === "auction") {
    targetUrl = AUCTION_URL + encodeURIComponent(value);
    check = checkAuctionPage(targetUrl); // runs while the tab opens
  } else {
    targetUrl = BASE_URL + encodeURIComponent(value);
  }
  const tab = await chrome.tabs.create({ url: targetUrl, active: true });
  if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
  if (check) ({ status, error } = await check);
  await addHistory(mode, [{ code: value, status, error, url: targetUrl }]);
  if (mode === "auction" && status === "missing") {
    flashBadge("✗", "#b45309");
    return { ok: false, error: `ლოტი ${value}: ${error}` };
  }
  return { ok: true };
}

// ======================= contours of several codes (contours.html) =======================
// contours.html keeps ONE list of contours (chrome.storage.session) and every command adds to it.
// For each code it asks the maps here; for a code that no map knows (split / merged parcels) it reads the
// latest cadastral plan PDF itself (that part needs a canvas, which a service worker does not have).

const CONTOURS_PAGE = "contours.html";
// action -> what the list page does when the new codes are ready
const CONTOUR_ACTIONS = {
  "contours-map": "map", // the whole list on geojson.io
  "contours-kml": "kml"  // one .kml per new code
};

// Opens the list page (or brings the open one to the front) and hands it new codes and what to do with them.
async function showContoursPage(cadastralCodes, then) {
  const pageUrl = chrome.runtime.getURL(CONTOURS_PAGE);
  const openTabs = (await chrome.tabs.query({})).filter((tab) => tab.url && tab.url.startsWith(pageUrl));
  if (openTabs.length) {
    const tab = openTabs[0];
    await focusTab(tab);
    await chrome.runtime.sendMessage({ type: "contours-request", tabId: tab.id, codes: cadastralCodes, then }).catch(() => {});
  } else {
    const tab = await chrome.tabs.create({ url: `${pageUrl}?add=${encodeURIComponent(cadastralCodes.join(","))}&then=${then}`, active: true });
    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
  }
  return { ok: true }; // history rows are written by the page when it has finished
}

// popup -> background: ღილაკი "სია". თუ ველში კოდი(ები) წერია, სიას ემატება (რუკის გახსნის გარეშე);
// ცარიელი ველით უბრალოდ სია იხსნება
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "contours-open-list") return;
  const codesFromInput = extractAllCadastralCodes(String(message.text || ""));
  showContoursPage(codesFromInput, "none").then(sendResponse);
  return true;
});

// viewer.html -> background: it has put the shown plan's contour into the list; show the list (and the map)
chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== "contours-show") return;
  if (!sender.url || !sender.url.startsWith(chrome.runtime.getURL(VIEWER_PAGE))) return;
  showContoursPage([], message.then === "map" ? "map" : "none");
});

// One code on the maps: maps.gov.ge first, then ms.gov.ge.
// -> { found: true, source: "maps" | "ms", polygons, address } or { found: false, problems: [text, ...] }
// "problems" lists a map that could not be asked (server error); a plain "not found" is not a problem.
async function findContourOnMaps(cadastralCode) {
  const problems = [];
  try {
    const onMaps = await fetchMapsParcelPolygons(cadastralCode);
    if (onMaps) return { found: true, source: "maps", polygons: onMaps.polygons, address: onMaps.address, problems };
  } catch (err) {
    problems.push(err.message); // the message already names the site
  }
  try {
    const onMs = await searchMsParcel(cadastralCode);
    if (onMs) return { found: true, source: "ms", polygons: parseWktPolygons(onMs.wkt), address: "", problems };
  } catch (err) {
    problems.push(err.message);
  }
  return { found: false, problems };
}

const isContoursPage = (sender) => !!sender.url && sender.url.startsWith(chrome.runtime.getURL(CONTOURS_PAGE));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "find-contour-on-maps" || !isContoursPage(sender)) return;
  findContourOnMaps(String(message.code || "")).then(sendResponse);
  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "contours-history" || !isContoursPage(sender)) return;
  if (!CONTOUR_ACTIONS[message.action] || !Array.isArray(message.rows)) return;
  const rows = message.rows.slice(0, 200).map((r) => ({
    code: String(r.code || "").slice(0, 100),
    status: ["found", "missing", "error"].includes(r.status) ? r.status : "error",
    error: String(r.error || "").slice(0, 300),
    note: String(r.note || "").slice(0, 100),
    url: String(message.url || "")
  }));
  addHistory(message.action, rows).then(() => sendResponse({ ok: true }));
  return true;
});

// ======================= one entry point for every action =======================

const MAP_ACTIONS = ["maps-map", "maps-kml", "ms-map", "ms-kml", "contours-map", "contours-kml"];

async function runAction(action, text, newTab = false) {
  if (action === "auction") {
    const id = extractAuctionId(text);
    if (!id) return { ok: false, error: "ლოტის ნომერი ვერ ამოვიცანი" };
    return processAndOpen(id, "auction");
  }
  if (action === "pdf" || action === "plan" || action === "abstract") {
    // only a real cadastral code (plain words must not open the registry pages)
    const code = extractValidCadastralCode(text);
    if (!code) {
      flashBadge("?", "#b45309");
      return { ok: false, error: "საკადასტრო კოდი ვერ ამოვიცანი" };
    }
    if (action === "abstract") return processAndOpen(code, action);
    return openDocViewer(code, action === "plan" ? "plan" : "extract");
  }
  if (PERSON_ACTIONS.includes(action)) {
    const numbers = extractPersonalNumbers(text);
    if (!numbers.length) {
      flashBadge("?", "#b45309");
      return { ok: false, error: "პირადი ნომერი ვერ ამოვიცანი (11 ციფრი)" };
    }
    return action === "maps-person" ? openPersons(numbers, newTab) : downloadPersonKml(numbers);
  }
  if (APP_ACTIONS.includes(action)) {
    const numbers = extractAppNumbers(text);
    if (!numbers.length) {
      flashBadge("?", "#b45309");
      return { ok: false, error: "განცხადების ნომერი ვერ ამოვიცანი (AR… ან ციფრები-ციფრები)" };
    }
    return action === "ms-app" ? openApps(numbers, newTab) : downloadAppKml(numbers);
  }
  const codes = extractAllCadastralCodes(text);
  if (!codes.length) {
    flashBadge("?", "#b45309");
    return { ok: false, error: "კოდის ფორმატი ვერ ამოვიცანი" };
  }
  if (CONTOUR_ACTIONS[action]) return showContoursPage(codes, CONTOUR_ACTIONS[action]);
  if (action === "maps-map") return openMapsMap(codes, newTab);
  if (action === "maps-kml") return downloadMapsKml(codes);
  if (action === "ms-map") return openMsMap(codes, newTab);
  if (action === "ms-kml") return downloadMsKml(codes);
  return { ok: false, error: "უცნობი მოქმედება: " + action };
}

// ======================= where the text comes from =======================

async function readClipboardViaOffscreen() {
  try {
    const hasDoc = await chrome.offscreen.hasDocument();
    if (!hasDoc) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: [chrome.offscreen.Reason.CLIPBOARD],
        justification: "Read cadastral code from system clipboard"
      });
    }

    const text = await chrome.runtime.sendMessage({
      target: "offscreen-doc",
      type: "get-clipboard-data"
    });

    return text ? text.trim() : "";
  } catch (err) {
    console.error("Clipboard read failed:", err);
    return "";
  }
}


function getPageSelection() {
  const sel = window.getSelection();
  if (sel && sel.toString().trim()) {
    return sel.toString().trim();
  }
  if (document.activeElement && document.activeElement.value) {
    const el = document.activeElement;
    return el.value.substring(el.selectionStart, el.selectionEnd).trim();
  }
  return "";
}


// Chrome focused -> the active tab's selection; another app focused (Word, PDF reader...) -> nothing,
// so the caller uses the clipboard (a leftover selection in Chrome must not win over a fresh copy).
async function readActiveSelection(action) {
  try {
    const lastWin = await chrome.windows.getLastFocused();
    const chromeFocused = !!(lastWin && lastWin.focused);
    console.log(`[${action}] Chrome focused: ${chromeFocused}`);
    if (!chromeFocused) return "";
    const [activeTab] = await chrome.tabs.query({ active: true, windowId: lastWin.id });
    if (!activeTab || !activeTab.id || !activeTab.url) return "";
    const url = activeTab.url;
    if (url.startsWith("chrome://") || url.startsWith("chrome-extension://") || url.startsWith("https://chromewebstore.google.com")) return "";
    const results = await chrome.scripting.executeScript({ target: { tabId: activeTab.id }, func: getPageSelection });
    return (results && results[0] && results[0].result) || "";
  } catch (e) {
    console.log("Selection read skipped/failed:", e);
    return "";
  }
}

// Map/KML actions need a cadastral code: a selection without one falls back to the clipboard too.
async function getTextForCommand(action) {
  const selection = await readActiveSelection(action);
  const needsCode = MAP_ACTIONS.includes(action);
  const needsApp = APP_ACTIONS.includes(action), needsPerson = PERSON_ACTIONS.includes(action);
  if (selection && (needsPerson ? extractPersonalNumbers(selection).length : needsApp ? extractAppNumbers(selection).length : (!needsCode || extractAllCadastralCodes(selection).length))) {
    console.log(`[${action}] source=selection`);
    return selection;
  }
  console.log(`[${action}] source=clipboard`);
  return readClipboardViaOffscreen();
}

// ======================= menus, shortcuts, messages =======================

const MENU_ITEMS = [
  { id: "maps-map", title: "maps.gov.ge · რუკაზე დამატება: '%s'" },
  { id: "maps-map-new", title: "maps.gov.ge · ახალ ტაბში: '%s'" },
  { id: "maps-kml", title: "maps.gov.ge · KML: '%s'" },
  { type: "separator", id: "sep1" },
  { id: "ms-map", title: "ms.gov.ge · რუკაზე დამატება: '%s'" },
  { id: "ms-map-new", title: "ms.gov.ge · ახალ ტაბში: '%s'" },
  { id: "ms-kml", title: "ms.gov.ge · KML: '%s'" },
  { id: "ms-app", title: "ms.gov.ge · განცხადება რუკაზე: '%s'" },
  { id: "ms-app-kml", title: "ms.gov.ge · განცხადების KML: '%s'" },
  { type: "separator", id: "sep3" },
  { id: "contours-map", title: "კონტურები · სიაში და რუკაზე (geojson.io): '%s'" },
  { id: "contours-kml", title: "კონტურები · KML (რუკიდან, თუ არა გეგმიდან): '%s'" },
  { type: "separator", id: "sep2" },
  { id: "pdf", title: "რეესტრი · ამონაწერი (ბოლო): '%s'" },
  { id: "plan", title: "რეესტრი · საკადასტრო გეგმა: '%s'" },
  { id: "abstract", title: "რეესტრი · ყველა დოკუმენტის გვერდი: '%s'" },
  { id: "auction", title: "აუქციონი · ლოტი: '%s'" }
];

chrome.runtime.onInstalled.addListener(() => {
  migrateOldHistory();
  chrome.contextMenus.removeAll(() => {
    for (const item of MENU_ITEMS) {
      chrome.contextMenus.create(item.type === "separator"
        ? { id: item.id, type: "separator", contexts: ["selection"] }
        : { id: item.id, title: item.title, contexts: ["selection"] });
    }
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (!info.selectionText) return;
  const id = String(info.menuItemId);
  const newTab = id.endsWith("-new");
  runAction(newTab ? id.slice(0, -4) : id, info.selectionText, newTab);
});

// Shortcut commands. Chrome lists them on chrome://extensions/shortcuts sorted by id and remembers the
// user's key by id, so an id is "<group><position>-<name>": 10 maps.gov.ge, 20 ms.gov.ge, 30 registry,
// 40 contours, 50 "this place ->", 60 auction; positions go 10, 20, 30...
// RULES: never rename an existing id (the user's key is bound to it). A new command gets a free number
// in its group (e.g. 1035 between 1030 and 1040), a new module gets a new group (70, 80...).
// The visible numbers ("1.3") are only in the descriptions in manifest.json and may be renumbered freely.
const COMMAND_ACTIONS = {
  "1010-maps-map": ["maps-map", false],
  "1020-maps-map-new-tab": ["maps-map", true],
  "1030-maps-kml": ["maps-kml", false],
  "1040-maps-person-map": ["maps-person", false],
  "1050-maps-person-kml": ["maps-person-kml", false],
  "2010-ms-map": ["ms-map", false],
  "2020-ms-map-new-tab": ["ms-map", true],
  "2030-ms-kml": ["ms-kml", false],
  "2040-ms-application-map": ["ms-app", false],
  "2050-ms-application-kml": ["ms-app-kml", false],
  "3010-registry-extract": ["pdf", false],
  "3020-registry-plan": ["plan", false],
  "3030-registry-all-documents": ["abstract", false],
  "4010-contours-map": ["contours-map", false],
  "4020-contours-kml": ["contours-kml", false],
  "6010-auction-lot": ["auction", false]
};

chrome.commands.onCommand.addListener(async (command) => {
  const entry = COMMAND_ACTIONS[command];
  if (!entry) return;
  const [action, newTab] = entry;
  // on the registry viewer itself: repeat press = next (older) document
  if ((action === "pdf" || action === "plan") && await stepActiveViewer(action === "plan" ? "plan" : "extract")) return;
  const text = await getTextForCommand(action);
  if (!text) {
    flashBadge("?", "#b45309");
    return;
  }
  const result = await runAction(action, text, newTab);
  if (result && !result.ok) console.warn(`[${action}]`, result.error);
});

// content_ms.js -> background: this browser's own ms.gov.ge session token (kept only locally)
chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== "ms-token") return;
  if (!sender.url || !sender.url.startsWith(MS_BASE + "/")) return;
  const token = String(message.token || "");
  if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token) || token.length > 4000) return;
  storedMsToken().then((current) => {
    if (current !== token) chrome.storage.local.set({ [MS_TOKEN_KEY]: { token, at: Date.now() } });
  });
});

// History page -> background: import a history file
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "history-import") return;
  importHistory(message.rows, message.mode === "replace" ? "replace" : "add", !!message.markImported, message.fileName)
    .then(sendResponse);
  return true;
});

// History page -> background: delete chosen rows (keys = time|action|code|status)
function deleteHistoryRows(keys) {
  let result = { ok: false, error: "უცნობი შეცდომა" };
  const drop = new Set(Array.isArray(keys) ? keys.map(String) : []);
  historyQueue = historyQueue.then(async () => {
    const list = (await chrome.storage.local.get(HISTORY_KEY))[HISTORY_KEY] || [];
    const kept = list.filter((r) => !drop.has(historyRowKey(r)));
    await chrome.storage.local.set({ [HISTORY_KEY]: kept });
    result = { ok: true, removed: list.length - kept.length, total: kept.length };
  }).catch((err) => { result = { ok: false, error: err.message }; });
  return historyQueue.then(() => result);
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "history-delete") return;
  deleteHistoryRows(message.keys).then(sendResponse);
  return true;
});

// Popup -> background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "run") return;
  runAction(message.action, message.text || "", !!message.newTab).then(sendResponse);
  return true; // keep the channel open for the async response
});

// The content scripts ask once per page load: "was this tab opened for some codes?" (answered once)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !sender.tab) return;
  const prefix = message.type === "maps-get-pending" ? "pending_maps_"
               : message.type === "ms-get-pending" ? "pending_ms_" : null;
  if (!prefix) return;
  const key = prefix + sender.tab.id;
  (async () => {
    for (let i = 0; i < 10; i++) { // the tab can load before the key is written
      const data = await chrome.storage.session.get(key);
      if (data[key]) {
        await chrome.storage.session.remove(key);
        return sendResponse(data[key]);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    sendResponse(null);
  })();
  return true;
});

// ======================= ms.gov.ge applications (განცხადებები) =======================
// An application number (AR11123767, 01262924313-67, 1-5656565 ...) is searched with the same
// unified search as cadastral codes. Results:
//   universalIntegrationResult - letters of the municipal services (one row per contour; geometry
//     EPSG:4326; link to letters.ms.gov.ge). The letters API returns, per contour, the cadastral code,
//     address, objectId and lrId -> https://ms.gov.ge/msmap/?orgId=1&objId=..&lrId=.. draws it.
//   architectureResult - Tbilisi architecture service (AR...; geometry EPSG:3857; link to tas.ge).
//     The service's public document record lists the cadastral codes per contour (shapeId = the
//     contour's objectid). No lrId, so it can only be drawn through the site's own search.
// The site draws one application contour at a time (a new one replaces the previous one).

const LETTERS_API = "https://api.municipal.gov.ge/ms/public/case/";
const TAS_DWR = "https://docs.tbilisi.gov.ge/architect/dwr/call/plaincall/UserMethods.getUserDocumentLastMotion.dwr";
const APP_RE = /(?<![\w.\-\/])(AR\d{1,10}|\d{1,15}-\d{1,15})(?![\w.\-\/])/gi;
const APP_ACTIONS = ["ms-app", "ms-app-kml"];

// All application numbers in a text, in order, without duplicates ("ar123" -> "AR123").
function extractAppNumbers(text) {
  const out = [];
  for (const m of String(text || "").matchAll(APP_RE)) {
    const n = m[1].toUpperCase();
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

// Web Mercator metres -> degrees (architecture geometries come in EPSG:3857).
function mercToLonLat(x, y) {
  const R = 6378137;
  return [(x / R) * 180 / Math.PI, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI];
}
function polysTo4326(polys) {
  return polys.map((rings) => rings.map((ring) => ring.map(([x, y]) =>
    (Math.abs(x) > 180 || Math.abs(y) > 90) ? mercToLonLat(x, y) : [x, y])));
}
function polysCenter(polys) {
  let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
  for (const rings of polys) for (const [lon, lat] of rings[0] || []) {
    a = Math.min(a, lon); b = Math.max(b, lon); c = Math.min(c, lat); d = Math.max(d, lat);
  }
  return isFinite(a) ? [(a + b) / 2, (c + d) / 2] : null;
}
const msCenterLink = (center, zoom = 18) => `${MS_BASE}/msmap/#C=${center[0].toFixed(7)}-${center[1].toFixed(7)}@Z=${zoom}`;
const msObjectLink = (objId, lrId, center) => `${MS_BASE}/msmap/?orgId=1&objId=${objId}&lrId=${lrId}` + (center ? `#C=${center[0].toFixed(7)}-${center[1].toFixed(7)}@Z=18` : "");

// The unified search (with this browser's ms.gov.ge session if it has one; works without it too).
async function msUnifiedSearch(text) {
  const token = await storedMsToken();
  let res = await msSearchRequest(text, token);
  if (token && (res.status === 401 || res.status === 403)) {
    await chrome.storage.local.remove(MS_TOKEN_KEY);
    res = await msSearchRequest(text, null);
  }
  if (!res.ok) throw new Error(`ms.gov.ge: HTTP ${res.status}`);
  try { return await res.json(); } catch { throw new Error("ms.gov.ge: პასუხი JSON არ არის"); }
}

// Contours of one letters case with cadastral code / address / objectId / lrId (owners are not kept).
async function letterMapInfos(caseId) {
  const post = async (path) => {
    const r = await fetchWithTimeout(`${LETTERS_API}${caseId}/${path}`, {
      method: "POST", headers: { "content-type": "application/json", "accept": "application/json, text/plain, */*" },
      body: JSON.stringify({ data: {} }), credentials: "omit"
    });
    return r.ok ? r.json() : null;
  };
  const pick = (j) => (j && j.result && j.result.data && j.result.data.mapInfos) || [];
  // contours can sit on any document of the case (later answers may replace them): newest first
  const docsRes = ((await post("documents")) || {}).result;
  const ids = [...new Set([caseId, ...(((docsRes && docsRes.data && docsRes.data.documents) || []).map((d) => String(d.id)))])].reverse();
  const seen = new Set(), infos = [];
  for (const id of ids.slice(0, 15)) {
    for (const m of pick(await post(`document/${id}`))) {
      if (seen.has(m.objectId)) continue;
      seen.add(m.objectId);
      infos.push(m);
    }
  }
  return infos.map((m) => {
    let polys = null;
    try { polys = polysTo4326(parseWktPolygons(m.wktGeometry || m.wktGeometryClob)); } catch (e) { /* no geometry */ }
    return { objectId: m.objectId, lrId: m.lrId, cad: m.cadCode || "", address: (m.address || "").replace(/\s+/g, " ").trim(),
             area: m.area, center: polys ? polysCenter(polys) : null };
  });
}

// Tbilisi architecture service: the contours of a public document with their cadastral codes.
// The reply is DWR JavaScript (not JSON), read field by field; owners are not kept.
async function tasMapInfos(docId) {
  const body = ["callCount=1", "nextReverseAjaxIndex=0", "c0-scriptName=UserMethods", "c0-methodName=getUserDocumentLastMotion",
    "c0-id=0", `c0-param0=number:${docId}`, "batchId=0", "instanceId=0", `page=%2Farchitect%2Fpublic.html%3FdocId%3D${docId}`,
    "scriptSessionId=", "windowName=", "httpSessionId=", ""].join("\n");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(TAS_DWR, { method: "POST", headers: { "content-type": "text/plain" }, body, credentials: "omit", signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return parseTasMapInfos(await r.text());
  } finally {
    clearTimeout(timer);
  }
}

function parseTasMapInfos(text) {
  const str = (obj, key) => {
    const m = obj.match(new RegExp(`(?:^|[,{])${key}:"((?:[^"\\\\]|\\\\.)*)"`));
    if (!m) return "";
    try { return JSON.parse(`"${m[1]}"`); } catch (e) { return m[1]; }
  };
  const out = [];
  for (const m of String(text).matchAll(/\{([^{}]*?shapeId:\d+[^{}]*)\}/g)) {
    const obj = "{" + m[1];
    const shape = obj.match(/shapeId:(\d+)/);
    out.push({ shapeId: shape[1], cad: str(obj, "naprCadCode"), address: (str(obj, "naprAddress") || str(obj, "address")).replace(/\s+/g, " ").trim() });
  }
  return out;
}

// The application number ms.gov.ge itself shows for an object (what ?objId=..&lrId=.. opens);
// null if it could not be checked, "" if there is no such object.
async function msObjectOwner(objId, lrId) {
  try {
    const r = await fetchWithTimeout(`${MS_BASE}/core-api/v1/search/search-object-by-lr-id-and-obj-pk`, {
      method: "POST", headers: { "content-type": "application/json", "accept": "*/*" },
      body: JSON.stringify({ objPk: objId, lrId }), credentials: "omit"
    });
    if (!r.ok) return null;
    const j = await r.json();
    const rec = j && j.universalIntegrationSearchResult && j.universalIntegrationSearchResult.layerRecords && j.universalIntegrationSearchResult.layerRecords[0];
    return rec ? String(rec.clientDocumentNo || "").trim().toUpperCase() : "";
  } catch (e) {
    return null;
  }
}

// { number, status, error, doc, items: [{ row, kind, type, cad, address, link, docUrl, polys, center }] }
async function lookupApp(number) {
  const json = await msUnifiedSearch(number);
  const same = (v) => String(v || "").trim().toUpperCase() === number;
  const items = [];
  // the same order as the site lists the rows (letters before architecture)
  for (const u of json.universalIntegrationResult || []) {
    if (same(u.clientDocumentNo)) items.push({ kind: "uni", type: (u.type || "").trim(), wkt: u.geometry, docUrl: u.clientDocumentUrl || "", lrId: u.universalIntegrationGroupId });
  }
  for (const a of json.architectureResult || []) {
    if (same(a.appId)) items.push({ kind: "ar", type: (a.type || "").trim(), wkt: a.geometry, docUrl: a.appUrl || "", shapeId: a.objectid });
  }
  if (!items.length) return { number, status: "missing", items: [] };

  items.forEach((it, i) => {
    it.row = i;
    it.cad = ""; it.address = "";
    try { it.polys = polysTo4326(parseWktPolygons(it.wkt)); it.center = polysCenter(it.polys); } catch (e) { it.polys = null; it.center = null; }
    delete it.wkt;
  });

  // letters: cadastral code, address and the objId/lrId link, matched to each contour by position
  const cases = [...new Set(items.filter((it) => it.kind === "uni").map((it) => (it.docUrl.match(/document-details\/(\d+)/) || [])[1]).filter(Boolean))];
  let enrichError = "";
  for (const caseId of cases) {
    let infos = [];
    try { infos = await letterMapInfos(caseId); } catch (e) { enrichError = "განცხადების დეტალები ვერ წავიკითხე"; continue; }
    const mine = items.filter((it) => it.kind === "uni" && it.docUrl.includes(`/${caseId}`));
    const used = new Set();
    for (const it of mine) {
      if (!it.center) continue;
      // nearest contours first (within ~300 m); the same outline can belong to several applications,
      // so the map's own record must name this application
      const cands = infos.filter((m) => m.center && !used.has(m.objectId))
        .map((m) => ({ m, d: Math.hypot(m.center[0] - it.center[0], m.center[1] - it.center[1]) }))
        .filter((c) => c.d <= 0.003).sort((x, y) => x.d - y.d);
      let chosen = null;
      for (const c of cands.slice(0, 6)) {
        const owner = await msObjectOwner(c.m.objectId, c.m.lrId || it.lrId);
        if (owner === null || owner === number) { chosen = c.m; break; } // null = could not check
      }
      if (!chosen) continue;
      used.add(chosen.objectId);
      Object.assign(it, { cad: chosen.cad, address: chosen.address, objId: chosen.objectId, lrId: chosen.lrId || it.lrId });
    }
    // a single contour with a single record: take it even without geometry to compare
    if (mine.length === 1 && infos.length === 1 && !mine[0].objId && [null, number].includes(await msObjectOwner(infos[0].objectId, infos[0].lrId || mine[0].lrId))) {
      const m = infos[0];
      Object.assign(mine[0], { cad: m.cad, address: m.address, objId: m.objectId, lrId: m.lrId || mine[0].lrId });
    }
  }
  // architecture: cadastral codes from the service's own document record (by shapeId)
  const arDocs = [...new Set(items.filter((it) => it.kind === "ar").map((it) => (it.docUrl.match(/documentId=(\d+)/) || [])[1]).filter(Boolean))];
  for (const docId of arDocs) {
    let infos = [];
    try { infos = await tasMapInfos(docId); } catch (e) { enrichError = "არქიტექტურის განცხადების დეტალები ვერ წავიკითხე"; continue; }
    for (const it of items) {
      if (it.kind !== "ar" || !it.docUrl.includes(`documentId=${docId}`)) continue;
      const m = infos.find((x) => String(x.shapeId) === String(it.shapeId));
      if (m) Object.assign(it, { cad: m.cad, address: m.address });
    }
  }
  for (const it of items) {
    it.link = it.objId && it.lrId ? msObjectLink(it.objId, it.lrId, it.center) : (it.center ? msCenterLink(it.center) : "");
  }
  return { number, status: "found", error: enrichError, doc: items[0].docUrl, items };
}

async function lookupApps(numbers) {
  const out = [];
  for (const number of numbers) {
    try { out.push(await lookupApp(number)); }
    catch (err) { out.push({ number, status: "error", error: err.message, items: [] }); }
  }
  return out;
}

// what the history keeps for one application (no geometry)
function appHistoryRow(app) {
  return {
    code: app.number, status: app.status, error: app.error || "",
    url: app.items[0] ? app.items[0].link : "",
    doc: app.doc || "",
    items: app.items.map((it) => ({ row: it.row, type: it.type, cad: it.cad, address: it.address, link: it.link, center: it.center }))
  };
}

// what the ms.gov.ge page panel needs
const panelApps = (apps) => apps.filter((a) => a.items.length).map((a) => ({
  number: a.number, doc: a.doc || "",
  items: a.items.map((it) => ({ row: it.row, type: it.type, cad: it.cad, address: it.address, link: it.link, center: it.center || null }))
}));

// Opens (or reuses) the ms.gov.ge map, shows the panel and draws item `index` of the first application.
async function showAppsOnMs(apps, newTab, index = 0) {
  const data = { apps: panelApps(apps), index };
  if (!data.apps.length) return;
  const existing = newTab ? null : await findSiteTab(MS_TAB_PATTERN);
  if (existing) {
    await focusTab(existing);
    sendToContent(existing.id, "content_ms.js", { type: "ms-app-show", ...data })
      .catch((err) => { console.error("Showing the application failed:", err); flashBadge("!", "#b91c1c"); });
    return;
  }
  const first = apps.find((a) => a.items.length).items[index] || apps.find((a) => a.items.length).items[0];
  const tab = await chrome.tabs.create({ url: first.center ? msCenterLink(first.center) : first.link || `${MS_BASE}/msmap/`, active: true });
  await chrome.storage.session.set({ ["pending_ms_" + tab.id]: data });
  if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
}

async function openApps(numbers, newTab) {
  const apps = await lookupApps(numbers);
  await addHistory("ms-app", apps.map(appHistoryRow));
  try {
    await showAppsOnMs(apps, newTab);
  } catch (err) {
    console.error("Opening the ms.gov.ge map failed:", err);
    flashBadge("!", "#b91c1c");
    return { ok: false, error: err.message };
  }
  const results = apps.map((a) => ({ code: a.number, status: a.status, error: a.status === "error" ? a.error : "" }));
  const problem = await reportProblems("ms-app", numbers, results);
  return problem && problem.error ? { ok: false, error: problem.error.replace(/^კოდი/, "განცხადება") } : { ok: true };
}

// ---- KML: one file per application, one placemark per contour ----

function appPlacemarkXml(app, it, i) {
  const name = it.cad || `${app.number} (${i + 1})`;
  const rows = [[app.label || "განცხადება", app.number], ["თემა", it.type], ["საკადასტრო კოდი", it.cad], ["მისამართი", it.address]];
  const links = [["რუკაზე (ms.gov.ge)", it.link], ["განცხადების გვერდი", it.docUrl]];
  const html = rows.filter(([, v]) => v).map(([k, v]) => `<b>${xmlEscape(k)}:</b> ${xmlEscape(v)}`)
    .concat(links.filter(([, v]) => v).map(([k, v]) => `<b>${xmlEscape(k)}:</b> <a href="${xmlEscape(v)}">${xmlEscape(v)}</a>`))
    .join("<br>");
  const data = [[app.dataKey || "application", app.number], ["topic", it.type], ["cadastral_code", it.cad], ["address", it.address], ["map_link", it.link], ["document_link", it.docUrl]]
    .map(([k, v]) => `        <Data name="${k}"><value>${xmlEscape(v || "")}</value></Data>`).join("\n");
  return `    <Placemark>
      <name>${xmlEscape(name)}</name>
      <description><![CDATA[${html}]]></description>
      <styleUrl>#parcel</styleUrl>
      <ExtendedData>
${data}
      </ExtendedData>
${polygonsGeometryXml(it.polys)}
    </Placemark>`;
}

function buildAppKml(app) {
  const types = [...new Set(app.items.map((it) => it.type).filter(Boolean))].join("; ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${xmlEscape(app.number)}</name>
    <description>${xmlEscape(types)}</description>
    <Style id="parcel">
      <LineStyle><color>ff0000ff</color><width>2</width></LineStyle>
      <PolyStyle><color>400000ff</color></PolyStyle>
    </Style>
${app.items.filter((it) => it.polys).map((it, i) => appPlacemarkXml(app, it, i)).join("\n")}
  </Document>
</kml>
`;
}

async function downloadAppKml(numbers) {
  const apps = await lookupApps(numbers);
  for (const app of apps) {
    if (app.status !== "found") continue;
    if (!app.items.some((it) => it.polys)) { app.status = "error"; app.error = "კონტურის გეომეტრია ვერ წავიკითხე"; continue; }
    try {
      await saveKml(app.number, buildAppKml(app));
    } catch (err) {
      app.status = "error";
      app.error = "KML ვერ შეიქმნა: " + err.message;
    }
  }
  await addHistory("ms-app-kml", apps.map(appHistoryRow));
  const results = apps.map((a) => ({ code: a.number, status: a.status, error: a.status === "error" ? a.error : "" }));
  const problem = await reportProblems("ms-app-kml", numbers, results);
  return problem && problem.error ? { ok: false, error: problem.error.replace(/^კოდი/, "განცხადება") } : { ok: true };
}

// ms.gov.ge panel: KML of one contour (found by its centre) or of the whole application
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "ms-app-kml-part" || !message.number) return;
  (async () => {
    const number = String(message.number).toUpperCase();
    const [app] = await lookupApps([number]);
    if (app.status !== "found") return sendResponse({ ok: false, error: app.error || "ვერ მოიძებნა" });
    let part = app;
    const c = message.center;
    if (Array.isArray(c) && c.length === 2) {
      let best = null, bestD = Infinity;
      for (const it of app.items) {
        if (!it.center) continue;
        const d = Math.hypot(it.center[0] - c[0], it.center[1] - c[1]);
        if (d < bestD) { bestD = d; best = it; }
      }
      if (!best || bestD > 1e-5) return sendResponse({ ok: false, error: "კონტური ვერ ვიპოვე" });
      part = { ...app, items: [best] };
    }
    if (!part.items.some((it) => it.polys)) return sendResponse({ ok: false, error: "გეომეტრია ვერ წავიკითხე" });
    const one = part.items.length === 1 && part !== app;
    const name = one ? `${number}_${(part.items[0].cad || `კონტური_${(Number(message.index) || 0) + 1}`)}` : number;
    await saveKml(name, buildAppKml(part));
    await addHistory("ms-app-kml", [{ ...appHistoryRow(part) }]);
    sendResponse({ ok: true, file: name + ".kml" });
  })().catch((err) => sendResponse({ ok: false, error: err.message }));
  return true;
});

// History page: open one stored contour again (the site's search is used to draw it)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "ms-app-open" || !message.number) return;
  const app = { number: String(message.number), doc: "", status: "found",
    items: (Array.isArray(message.items) ? message.items : []).map((it, i) => ({ row: Number.isInteger(it.row) ? it.row : i, type: String(it.type || ""), cad: String(it.cad || ""), address: String(it.address || ""), link: String(it.link || ""),
      center: Array.isArray(it.center) && it.center.length === 2 && it.center.every(Number.isFinite) ? it.center : null })) };
  if (!app.items.length) return;
  // a fresh tab starts at the stored link (centre of the contour)
  const idx = Math.max(0, Math.min(app.items.length - 1, Number(message.index) || 0));
  (async () => {
    const existing = await findSiteTab(MS_TAB_PATTERN);
    if (existing) {
      await focusTab(existing);
      await sendToContent(existing.id, "content_ms.js", { type: "ms-app-show", apps: panelApps([app]), index: idx });
    } else {
      const start = app.items[idx].link && app.items[idx].link.startsWith(MS_BASE) ? app.items[idx].link.replace(/\?[^#]*/, "") : `${MS_BASE}/msmap/`;
      const tab = await chrome.tabs.create({ url: start, active: true });
      await chrome.storage.session.set({ ["pending_ms_" + tab.id]: { apps: panelApps([app]), index: idx } });
    }
    sendResponse({ ok: true });
  })().catch((err) => sendResponse({ ok: false, error: err.message }));
  return true;
});

// ======================= Map Jump: the same place on another map =======================
// Reads the place shown in the active tab (maps.gov.ge, ms.gov.ge or Google Maps) and opens it
// on one of the other two maps, always in a new tab. Not written to the history.

const DEFAULT_ZOOM = 18;
const clampZoom = (z) => Math.min(20, Math.max(3, Math.round(z)));
const SITE_NAMES = { maps: "maps.gov.ge", ms: "ms.gov.ge", google: "Google Maps", geojson: "geojson.io" };


function detectSite(url) {
  if (/^https:\/\/maps\.gov\.ge\/map\/portal/.test(url)) return "maps";
  if (/^https:\/\/ms\.gov\.ge\/msmap\//.test(url)) return "ms";
  if (/^https:\/\/(www\.)?google\.[a-z.]+\/maps/.test(url)) return "google";
  if (/^https:\/\/geojson\.io\//.test(url)) return "geojson";
  return null;
}

// geojson.io keeps the view in the address and updates it on every move: ?map=<zoom>/<lat>/<lon>
// Its zoom (Mapbox, 512 px tiles) is one less than the zoom of the other maps for the same picture.
const GEOJSON_IO_ZOOM_OFFSET = 1;
function parseGeojsonIoUrl(url) {
  const m = url.match(/[?&]map=(\d+(?:\.\d+)?)(?:%2F|\/)(-?\d+(?:\.\d+)?)(?:%2F|\/)(-?\d+(?:\.\d+)?)/i);
  return m ? { zoom: +m[1] + GEOJSON_IO_ZOOM_OFFSET, lat: +m[2], lon: +m[3], how: "რუკის ცენტრი" } : null;
}
function geojsonIoTargetUrl(loc) {
  return `https://geojson.io/?map=${clampZoom(loc.zoom) - GEOJSON_IO_ZOOM_OFFSET}/${fixed(loc.lat)}/${fixed(loc.lon)}`;
}

// ---- reading the place from a URL ----

// ms.gov.ge keeps the map centre in the hash and updates it on every move: #C=<lon>-<lat>@Z=<zoom>
function parseMsUrl(url) {
  const m = url.match(/#C=(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)@Z=(\d+(?:\.\d+)?)/);
  return m ? { lon: +m[1], lat: +m[2], zoom: +m[3], how: "რუკის ცენტრი" } : null;
}

// Google: ".../@<lat>,<lng>,<N>z" or ",<N>m" (satellite view, metres of visible height).
// A searched / dropped pin is in the data part as "!3d<lat>!4d<lng>" - that is the exact place, so it wins.
// Google keeps the pin of a place in the address after the map has been moved away from it, so the
// pin is used only while it is inside the part of the map on screen; otherwise the map centre.
function parseGoogleUrl(url, viewportHeight, viewportWidth) {
  const view = url.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?)([zm]))?/);
  const pins = [...url.matchAll(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/g)];
  if (!view && !pins.length) return null;
  let zoom = DEFAULT_ZOOM;
  if (view && view[3]) zoom = view[4] === "z" ? +view[3] : metersToZoom(+view[3], +view[1], viewportHeight);
  if (pins.length) {
    const p = pins[pins.length - 1];
    const pin = { lat: +p[1], lon: +p[2], zoom, how: "Google-ზე გახსნილი ადგილი (წითელი ნიშანი)" };
    if (!view) return pin;
    if (googlePinOnScreen(pin, { lat: +view[1], lon: +view[2] }, zoom, viewportHeight, viewportWidth)) return pin;
    return { lat: +view[1], lon: +view[2], zoom, how: "რუკის ცენტრი" };
  }
  return { lat: +view[1], lon: +view[2], zoom, how: "რუკის ცენტრი" };
}

// Is the pin within the visible map (half the window around the centre, Web Mercator metres)?
function googlePinOnScreen(pin, center, zoom, heightPx, widthPx) {
  const R = 6378137, merc = (p) => [p.lon * Math.PI / 180 * R, Math.log(Math.tan(Math.PI / 4 + p.lat * Math.PI / 360)) * R];
  const [px, py] = merc(pin), [cx, cy] = merc(center);
  const res = 2 * Math.PI * R / 256 / Math.pow(2, zoom); // metres per screen pixel at this zoom
  const halfW = ((widthPx || 1200) / 2) * res, halfH = ((heightPx || 800) / 2) * res;
  return Math.abs(px - cx) <= halfW && Math.abs(py - cy) <= halfH;
}

// Visible height in metres -> web-map zoom level (same scale on all three maps).
function metersToZoom(meters, lat, heightPx) {
  const h = heightPx || 900;
  return Math.log2((156543.03392 * Math.cos((lat * Math.PI) / 180) * h) / meters);
}

// maps.gov.ge writes "#state/point=<lon>,<lat>&...&zoom=<z>" when the map is moved or clicked.
function parseMapsStateUrl(url) {
  const m = url.match(/#state\/point=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const z = url.match(/[&?]zoom=(\d+(?:\.\d+)?)/);
  return { lon: +m[1], lat: +m[2], zoom: z ? +z[1] : DEFAULT_ZOOM, how: "რუკის ცენტრი / დაკლიკებული წერტილი" };
}

// "44.806938, 41.714521" (lon, lat) under the mouse - only if it looks like geographic degrees
// inside Georgia (another projection, e.g. UTM metres, is ignored).
function parseMapsPointer(text) {
  const m = (text || "").match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lon = +m[1], lat = +m[2];
  if (lon < 39 || lon > 47.5 || lat < 40.5 || lat > 44) return null;
  return { lon, lat };
}

async function readGooglePointer(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: "google-read-pointer" });
    const ok = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon);
    return { pointer: r && ok(r.pointer) ? r.pointer : null, right: r && ok(r.right) ? r.right : null };
  } catch (e) {
    return { pointer: null, right: null }; // tab opened before the extension was (re)loaded
  }
}

// the map centre and zoom of a Google Maps address
function parseGoogleView(url, viewportHeight) {
  const v = url.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?)([zm]))?/);
  if (!v) return null;
  const zoom = v[3] ? (v[4] === "z" ? +v[3] : metersToZoom(+v[3], +v[1], viewportHeight)) : DEFAULT_ZOOM;
  return { lat: +v[1], lon: +v[2], zoom };
}

async function readMsPointer(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: "ms-read-pointer" });
    return r && Number.isFinite(r.lon) && Number.isFinite(r.lat) ? r : null;
  } catch (e) {
    return null;
  }
}

async function readMapsPointer(tabId) {
  return (await readMapsView(tabId)).pointer;
}

// { pointer, click, moved }: the point under the mouse, the last clicked point (since the address
// last changed) and whether the map was dragged/zoomed since then.
async function readMapsView(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: "jump-read-pointer" });
    return { pointer: parseMapsPointer(r && r.text), click: parseMapsPointer(r && r.click), moved: !!(r && r.movedSinceAddress) };
  } catch (e) {
    return { pointer: null, click: null, moved: false }; // tab opened before the extension was installed/reloaded
  }
}

// While a parcel is shown (".../getinfo.alpha?lbl=...&share=1") maps.gov.ge stops updating the
// address, so the place is taken from that parcel instead: the centre of its outline.
function mapsLblFromUrl(url) {
  const m = url.match(/getinfo\.alpha\?lbl=([^&#]+)/);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; } // keeps "+" as "+"
}

async function mapsParcelLocation(lbl) {
  // the ROWID goes out exactly as the portal sends it (a literal "+", never %2B)
  const res = await fetchWithTimeout(`${MAP_BASE}/lr/bo/mg/getinfo.alpha?lbl=${lbl}&res=shp&lang=ka`, { credentials: "include" });
  if (!res.ok) throw new Error(`maps.gov.ge: HTTP ${res.status}`);
  const json = await res.json();
  const item = (json.data || [])[0];
  if (!item || !item.shape) throw new Error("maps.gov.ge: ნაკვეთის გეომეტრია ვერ მივიღე");
  const nums = (item.shape.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    minLon = Math.min(minLon, nums[i]); maxLon = Math.max(maxLon, nums[i]);
    minLat = Math.min(minLat, nums[i + 1]); maxLat = Math.max(maxLat, nums[i + 1]);
  }
  if (!isFinite(minLon)) throw new Error("maps.gov.ge: ნაკვეთის გეომეტრია ცარიელია");
  return { lon: (minLon + maxLon) / 2, lat: (minLat + maxLat) / 2, zoom: 19, how: `ნაკვეთი ${item.name || ""}`.trim() };
}

// { site, lat, lon, zoom, how } for a tab, or throws with a readable reason.
async function getLocation(tab) {
  const url = (tab && tab.url) || "";
  const site = detectSite(url);
  if (!site) throw new Error("აქტიური ტაბი არ არის maps.gov.ge, ms.gov.ge, Google Maps ან geojson.io რუკა");
  let loc = null;
  if (site === "geojson") {
    loc = parseGeojsonIoUrl(url); // the map centre (the address has no mouse point)
  }
  else if (site === "ms") {
    // the point under the mouse (computed by content_ms.js from the map view), else the map centre
    const view = parseMsUrl(url);
    const pointer = await readMsPointer(tab.id);
    loc = pointer ? { lon: pointer.lon, lat: pointer.lat, zoom: view ? view.zoom : pointer.zoom, how: "მაუსის წერტილი" } : view;
  }
  else if (site === "google") {
    // 1) the mouse over the map, 2) the point of a recent right-click (Google's exact coordinates)
    // that is still on screen, 3) the place pin if on screen, 4) the map centre
    const g = await readGooglePointer(tab.id);
    const urlLoc = parseGoogleUrl(url, tab.height, tab.width);
    const view = parseGoogleView(url, tab.height);
    if (g.pointer) loc = { lat: g.pointer.lat, lon: g.pointer.lon, zoom: g.pointer.zoom || (urlLoc ? urlLoc.zoom : DEFAULT_ZOOM), how: "მაუსის წერტილი" };
    else if (g.right && Date.now() - g.right.t < 15 * 60000 && (!view || googlePinOnScreen(g.right, view, view.zoom, tab.height, tab.width))) {
      loc = { lat: g.right.lat, lon: g.right.lon, zoom: urlLoc ? urlLoc.zoom : DEFAULT_ZOOM, how: "მარჯვენა კლიკის წერტილი" };
    } else loc = urlLoc;
  }
  else {
    // 1) the point under the mouse (shortcut pressed while hovering the map)
    // 2) the shown parcel's centre, or 3) the map centre / clicked point from the address
    const view = await readMapsView(tab.id);
    const state = parseMapsStateUrl(url);
    const lbl = mapsLblFromUrl(url);
    if (view.pointer) {
      loc = { ...view.pointer, zoom: state ? state.zoom : 19, how: "მაუსის წერტილი" };
    } else if (!lbl) {
      loc = state;
    } else if (view.click) {
      // a parcel is shown, so the address is frozen: the point clicked on the map after it
      loc = { ...view.click, zoom: 19, how: "დაკლიკებული წერტილი" };
    } else if (view.moved) {
      throw new Error("maps.gov.ge: რუკა გადაადგილდა, მისამართში კი ისევ ძველი ნაკვეთია. მიიტანე მაუსი ადგილზე და გამოიყენე შორთქათი, ან ჯერ დააკლიკე ადგილს რუკაზე");
    } else {
      loc = await mapsParcelLocation(lbl);
    }
  }
  if (!loc) throw new Error(`${SITE_NAMES[site]}: ადგილი ვერ განვსაზღვრე (გადაადგილე ან დააკლიკე რუკას და სცადე თავიდან)`);
  return { site, ...loc };
}

// ---- opening the place on a target map (always in a new tab) ----

const fixed = (n) => n.toFixed(7);

function msTargetUrl(loc) {
  return `https://ms.gov.ge/msmap/#C=${fixed(loc.lon)}-${fixed(loc.lat)}@Z=${clampZoom(loc.zoom)}`;
}

// "/place/<lat>,<lng>" puts a pin on the exact point; "!3m1!1e3" = satellite view.
function googleTargetUrl(loc) {
  const ll = `${fixed(loc.lat)},${fixed(loc.lon)}`;
  return `https://www.google.com/maps/place/${ll}/@${ll},${clampZoom(loc.zoom)}z/data=!3m1!1e3`;
}

// maps.gov.ge opens at a point from its address only together with "&share=1&layers=92,97"
// (without them the portal ignores "state/point" and shows the whole country).
// Zoom 20 = what the site's own coordinate search ends up with.
function mapsPointUrl(loc, zoom = 20) {
  return `${MAP_BASE}/map/portal#state/point=${fixed(loc.lon)},${fixed(loc.lat)}&projection=EPSG:4326&zoom=${zoom}&projection=EPSG:4326&share=1&layers=92,97`;
}

// Opens { lat, lon, zoom } on the target map in a new tab; returns the address for the history.
async function openTarget(target, loc) {
  if (target === "ms" || target === "google" || target === "geojson") {
    const url = target === "ms" ? msTargetUrl(loc) : target === "google" ? googleTargetUrl(loc) : geojsonIoTargetUrl(loc);
    await chrome.tabs.create({ url, active: true });
    return url;
  }
  // The jump itself still uses the site's coordinate search (content_jump_maps.js), because that
  // also drops a pin on the point; the history gets the equivalent "state/point...&share=1" link.
  const newTab = await chrome.tabs.create({ url: `${MAP_BASE}/map/portal`, active: true });
  await chrome.storage.session.set({ ["pending_jump_" + newTab.id]: { lon: loc.lon, lat: loc.lat } });
  return mapsPointUrl(loc);
}

async function jumpTo(target, tab) {
  const from = (tab && tab.url) || "";
  const fromSite = detectSite(from);
  const route = `${fromSite ? SITE_NAMES[fromSite] : "?"} → ${SITE_NAMES[target]}`;
  let loc;
  try {
    loc = await getLocation(tab);
  } catch (err) {
    flashBadge("?", "#b45309");
    if (fromSite) await addHistory("jump-" + target, [{ code: route, status: "error", error: err.message, from }]);
    return { ok: false, error: err.message };
  }
  if (loc.site === target) return { ok: false, error: `უკვე ${SITE_NAMES[target]}-ზე ხარ` };

  console.log(`[jump] ${loc.site} -> ${target}:`, JSON.stringify(loc));
  const to = await openTarget(target, loc);
  const place = { lat: +loc.lat.toFixed(7), lon: +loc.lon.toFixed(7), zoom: Math.round(loc.zoom), how: loc.how };
  // maps.gov.ge's own address only reopens the view with "&share=1&layers=92,97" (and it does not
  // follow the mouse point), so for that site the history keeps a link to the exact place used;
  // a shown parcel keeps its parcel link, which already works.
  const fromLink = loc.site === "maps" && !String(loc.how).startsWith("ნაკვეთი")
    ? mapsPointUrl(loc, Math.round(loc.zoom))
    : from;
  await addHistory("jump-" + target, [{ code: route, status: "opened", from: fromLink, to, place }]);
  return { ok: true, loc };
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

// ---- shortcuts, popup, content script ----

const COMMAND_TARGETS = { "5010-place-to-maps": "maps", "5020-place-to-ms": "ms", "5030-place-to-google": "google", "5040-place-to-geojson": "geojson" };

chrome.commands.onCommand.addListener(async (command) => {
  const target = COMMAND_TARGETS[command];
  if (!target) return;
  const r = await jumpTo(target, await activeTab());
  if (!r.ok) console.warn("[jump]", r.error);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;
  if (message.type === "jump-info") {
    chrome.tabs.get(message.tabId)
      .then((tab) => getLocation(tab))
      .then((loc) => sendResponse({ ok: true, loc }), (err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message.type === "jump-reopen" && message.place) {
    openTarget(message.target, message.place).then(() => sendResponse({ ok: true }), (err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message.type === "jump") {
    chrome.tabs.get(message.tabId).then((tab) => jumpTo(message.target, tab)).then(sendResponse);
    return true;
  }
  if (message.type === "jump-get-pending" && sender.tab) {
    const key = "pending_jump_" + sender.tab.id;
    (async () => {
      for (let i = 0; i < 10; i++) { // the tab can load before the key is written
        const data = await chrome.storage.session.get(key);
        if (data[key]) {
          await chrome.storage.session.remove(key);
          return sendResponse(data[key]);
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      sendResponse(null);
    })();
    return true;
  }
});

// ======================= place -> cadastral code, personal number -> parcels =======================
// Both maps answer "what is at this point" without their parcel layer being switched on:
//   maps.gov.ge: the portal search with "lon,lat" as keyword and a close zoom (at a far zoom it
//     answers with a zone code instead of the parcel);
//   ms.gov.ge: /search/search-by-xy with the registered-parcels layer (lrId 261415).
// maps.gov.ge also finds a person's parcels by an 11-digit personal number.

const MS_PARCEL_LR = 261415;
const PN_RE = /(?<![\d.\-\/])\d{11}(?![\d.\-\/])/g;
const PERSON_ACTIONS = ["maps-person", "maps-person-kml"];

function extractPersonalNumbers(text) {
  return [...new Set(String(text || "").match(PN_RE) || [])];
}

async function mapsSearchResults(keyword, point = null) {
  const res = await fetchWithTimeout(`${MAP_BASE}/map/portal/search`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", "x-requested-with": "XMLHttpRequest" },
    body: buildMapSearchBody(keyword, point),
    credentials: "include"
  });
  if (!res.ok) throw new Error(`maps.gov.ge: HTTP ${res.status}`);
  let json;
  try { json = await res.json(); } catch { throw new Error("maps.gov.ge: პასუხი JSON არ არის"); }
  if (!json.status) throw new Error("maps.gov.ge: status=false");
  return json.result || [];
}

// registered-parcel rows of a maps.gov.ge answer -> [{ cad, address, lbl, link, geometryPath }]
function mapsParcelRows(results) {
  const out = [], seen = new Set();
  for (const r of results) {
    const d = r.details || {};
    const link = d.info_link || r.resultlink || "";
    if (!link.includes("lr_parcels:")) continue; // address / street rows
    const m = link.match(/[?&]lbl=([^&#]+)/);
    if (!m) continue;
    let lbl;
    try { lbl = decodeURIComponent(m[1]); } catch { lbl = m[1]; }
    if (seen.has(lbl)) continue;
    seen.add(lbl);
    out.push({ cad: String(r.name || "").trim(), address: String(r.descript || "").replace(/\s+/g, " ").replace(/\s+,/g, ",").trim(), lbl,
               link: mapsUrlForLbl(lbl), geometryPath: d.geometry_link || `/lr/bo/mg/getinfo.alpha?lbl=${lbl}&res=shp` });
  }
  return out;
}

// polygons of a maps.gov.ge parcel ("+" in the ROWID stays raw, see searchParcel)
async function mapsGeometry(geometryPath, code) {
  let url = MAP_BASE + geometryPath;
  if (!/[?&]lang=/.test(url)) url += "&lang=ka";
  const res = await fetchWithTimeout(url, { credentials: "include" });
  if (!res.ok) throw new Error(`გეომეტრიის მოთხოვნამ დააბრუნა HTTP ${res.status}`);
  const json = await res.json();
  const item = (json.data || []).find((d) => d.name === code) || (json.data || [])[0];
  if (!item || !item.shape) throw new Error("გეომეტრია არ დაბრუნდა");
  return parseWktPolygons(item.shape);
}

// ---- place -> code ----

async function pointCodes(loc) {
  const found = new Map(), errors = [];
  const add = (cad, info) => {
    if (!cad) return;
    const cur = found.get(cad) || { cad, address: "", link: "", sources: [] };
    if (info.address && !cur.address) cur.address = info.address;
    if (info.link && !cur.link) cur.link = info.link;
    cur.sources.push(info.source);
    found.set(cad, cur);
  };
  await Promise.all([
    (async () => {
      try {
        for (const r of mapsParcelRows(await mapsSearchResults(`${loc.lon.toFixed(6)},${loc.lat.toFixed(6)}`, loc))) {
          add(r.cad, { address: r.address, link: r.link, source: "maps.gov.ge" });
        }
      } catch (e) { errors.push(e.message); }
    })(),
    (async () => {
      try {
        const r = await fetchWithTimeout(`${MS_BASE}/core-api/v1/search/search-by-xy`, {
          method: "POST", headers: { "content-type": "application/json", "accept": "*/*" },
          body: JSON.stringify({ lrIds: [MS_PARCEL_LR], x: loc.lon, y: loc.lat, zoom: 19 }), credentials: "omit"
        });
        if (!r.ok) throw new Error(`ms.gov.ge: HTTP ${r.status}`);
        const j = await r.json();
        for (const rec of (j.naprTchParcel && j.naprTchParcel.layerRecords) || []) {
          let link = "";
          try { link = msCenterLink(polysCenter(parseWktPolygons(rec.wktShape)), 19); } catch (e) { /* no geometry */ }
          add(rec.cadCode, { link, source: "ms.gov.ge" });
        }
      } catch (e) { errors.push(e.message); }
    })()
  ]);
  return { items: [...found.values()], error: found.size ? "" : errors.join("; ") };
}

// Popup button / shortcut: the code(s) at the place shown in the tab -> window with actions,
// the first code also goes to the clipboard (so the other shortcuts can use it right away).
// "41.722691, 44.762539" (Google: lat, lng) or "44.762539, 41.722691" (maps.gov.ge: lon, lat)
function parseCoordinates(text) {
  const m = String(text || "").match(/(-?\d{1,2}\.\d{3,})\s*[,;\s]\s*(-?\d{1,2}\.\d{3,})/);
  if (!m) return null;
  const a = +m[1], b = +m[2];
  const isLat = (v) => v >= 40.9 && v <= 43.7, isLon = (v) => v >= 39.9 && v <= 46.8;
  if (isLat(a) && isLon(b)) return { lat: a, lon: b };
  if (isLon(a) && isLat(b)) return { lat: b, lon: a };
  return null;
}

async function pointLookup(tab, coordsText = "") {
  let loc;
  const typed = parseCoordinates(coordsText);
  if (typed) {
    loc = { site: "coords", ...typed, zoom: 19, how: "კოორდინატები" };
  } else {
    try {
      loc = await getLocation(tab);
    } catch (err) {
      // not a map tab: coordinates copied from Google's right-click menu (or typed) also work
      const fromText = parseCoordinates(await getTextForCommand("point-code"));
      if (!fromText) {
        flashBadge("?", "#b45309");
        return { ok: false, error: err.message + " (ან დააკოპირე კოორდინატები, მაგ. Google-ის მარჯვენა კლიკის მენიუდან)" };
      }
      loc = { site: "coords", ...fromText, zoom: 19, how: "დაკოპირებული კოორდინატები" };
    }
  }
  const { items, error } = await pointCodes(loc);
  const place = { lat: +loc.lat.toFixed(7), lon: +loc.lon.toFixed(7), zoom: Math.round(loc.zoom), how: loc.how };
  const status = items.length ? "found" : (error ? "error" : "missing");
  await addHistory("point-code", [{
    code: `${SITE_NAMES[loc.site] || "კოორდინატები"} → საკადასტრო კოდი`, status, error, place,
    from: loc.site === "maps" && !String(loc.how).startsWith("ნაკვეთი") ? mapsPointUrl(loc, Math.round(loc.zoom)) : (tab.url || ""),
    url: items[0] ? items[0].link : "",
    items: items.map((it, i) => ({ row: i, type: it.sources.join(" + "), cad: it.cad, address: it.address, link: it.link }))
  }]);
  const copied = items.length ? await copyToClipboard(items[0].cad) : false;
  if (!items.length) flashBadge(status === "error" ? "!" : "✗", status === "error" ? "#b91c1c" : "#b45309");
  await showResultWindow({ kind: "point", place, items, error, copy: items[0] ? items[0].cad : "", copiedByBackground: copied === true });
  return { ok: true };
}

async function copyToClipboard(text) {
  try {
    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: [chrome.offscreen.Reason.CLIPBOARD], justification: "Copy the cadastral code" });
    }
    return await chrome.runtime.sendMessage({ target: "offscreen-doc", type: "copy-text", text });
  } catch (e) {
    console.log("Copy failed:", e && e.message);
    return false;
  }
}

// small window with codes and buttons (result.html)
// Only one such window at a time: a new result replaces the previous window.
async function showResultWindow(data) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await chrome.storage.session.set({ ["result_" + id]: data });
  const page = chrome.runtime.getURL("result.html");
  try {
    for (const w of await chrome.windows.getAll({ populate: true, windowTypes: ["popup"] })) {
      if ((w.tabs || []).some((t) => String(t.url || "").startsWith(page))) await chrome.windows.remove(w.id).catch(() => {});
    }
  } catch (e) { /* none open */ }
  const n = Math.max(1, data.items.length);
  const width = 520, height = Math.min(640, 190 + 92 * n);
  const opts = { url: `result.html#${id}`, type: "popup", width, height, focused: true };
  try {
    const w = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (w && w.width) { opts.left = Math.max(0, Math.round(w.left + w.width - width - 24)); opts.top = Math.max(0, Math.round(w.top + 110)); }
  } catch (e) { /* default position */ }
  await chrome.windows.create(opts);
}

// ---- personal number -> parcels ----

async function lookupPersons(numbers) {
  const out = [];
  for (const pn of numbers) {
    try {
      const items = mapsParcelRows(await mapsSearchResults(pn));
      out.push({ pn, status: items.length ? "found" : "missing", items });
    } catch (err) {
      out.push({ pn, status: "error", error: err.message, items: [] });
    }
  }
  return out;
}

const personHistoryRow = (p) => ({
  code: p.pn, status: p.status, error: p.error || "", url: p.items[0] ? p.items[0].link : "",
  items: p.items.map((it, i) => ({ row: i, type: "", cad: it.cad, address: it.address, link: it.link }))
});

// all parcels on the maps.gov.ge map (the open map tab, or a new one)
async function openMapsItems(items, newTab) {
  const existing = newTab ? null : await findSiteTab(MAPS_TAB_PATTERN);
  if (existing) {
    await focusTab(existing);
    sendToContent(existing.id, "content_maps.js", { type: "maps-draw", items })
      .catch((err) => { console.error("Drawing in the open tab failed:", err); flashBadge("!", "#b91c1c"); });
    return;
  }
  const tab = await chrome.tabs.create({ url: mapsUrlForLbl(items[0].lbl), active: true });
  await chrome.storage.session.set({ ["pending_maps_" + tab.id]: items });
  if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
}

async function openPersons(numbers, newTab) {
  const persons = await lookupPersons(numbers);
  await addHistory("maps-person", persons.map(personHistoryRow));
  const items = persons.flatMap((p) => p.items.map((it) => ({ code: it.cad, lbl: it.lbl })));
  if (items.length) {
    try { await openMapsItems(items, newTab); }
    catch (err) { flashBadge("!", "#b91c1c"); return { ok: false, error: err.message }; }
  }
  // the list of parcels (codes, addresses, buttons) - one window for all numbers
  await showResultWindow({
    kind: "person", pn: persons.map((p) => p.pn).join(", "),
    missing: persons.filter((p) => p.status !== "found").map((p) => p.pn + (p.error ? ` (${p.error})` : "")),
    items: persons.flatMap((p) => p.items.map((it) => ({ cad: it.cad, address: it.address, link: it.link, sources: persons.length > 1 ? [`პ/ნ ${p.pn}`] : [] }))),
    error: ""
  });
  const results = persons.map((p) => ({ code: p.pn, status: p.status, error: p.error || "" }));
  const bad = results.filter((r) => r.status !== "found");
  if (bad.length) flashBadge("✗", "#b45309");
  return bad.length === results.length && results.length === 1
    ? { ok: false, error: bad[0].status === "error" ? bad[0].error : `პირად ნომერზე ${bad[0].code} ნაკვეთი ვერ მოიძებნა` }
    : { ok: true };
}

async function downloadPersonKml(numbers) {
  const persons = await lookupPersons(numbers);
  for (const p of persons) {
    if (p.status !== "found") continue;
    for (const it of p.items) {
      try { it.polys = await mapsGeometry(it.geometryPath, it.cad); } catch (e) { it.polys = null; }
    }
    if (!p.items.some((it) => it.polys)) { p.status = "error"; p.error = "გეომეტრია ვერ წავიკითხე"; continue; }
    const doc = { number: p.pn, label: "პირადი ნომერი", dataKey: "personal_number",
      items: p.items.map((it) => ({ type: "", cad: it.cad, address: it.address, link: it.link, docUrl: "", polys: it.polys })) };
    try { await saveKml(p.pn, buildAppKml(doc)); }
    catch (err) { p.status = "error"; p.error = "KML ვერ შეიქმნა: " + err.message; }
  }
  await addHistory("maps-person-kml", persons.map(personHistoryRow));
  const results = persons.map((p) => ({ code: p.pn, status: p.status, error: p.error || "" }));
  const problem = await reportProblems("maps-person-kml", numbers, results);
  return problem && problem.error ? { ok: false, error: problem.error.replace(/^კოდი/, "პირადი ნომერი") } : { ok: true };
}

const COMMAND_POINT = "5050-place-cadastral-code";
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== COMMAND_POINT) return;
  const r = await pointLookup(await activeTab());
  if (!r.ok) console.warn("[point]", r.error);
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "point-code") return;
  chrome.tabs.get(message.tabId).then((tab) => pointLookup(tab, message.text || "")).then(sendResponse, (err) => sendResponse({ ok: false, error: err.message }));
  return true;
});

// ======================= self-update of the unpacked install =======================
// install.bat / updater.ps1 replace this extension's files on disk (manifest.json last).
// An unpacked extension serves its files straight from disk, so a newer version number in the
// manifest file means new files are in place: reload to start using them. (Store installs never
// change on disk, so this does nothing there.)
async function checkForNewFiles() {
  try {
    const res = await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" });
    const disk = await res.json();
    const running = chrome.runtime.getManifest().version;
    if (disk && disk.version && disk.version !== running) {
      console.log(`[self-update] ${running} -> ${disk.version}: reloading`);
      chrome.runtime.reload();
    }
  } catch (e) {
    console.log("[self-update] check skipped:", e && e.message);
  }
}
chrome.alarms.create("check-new-files", { periodInMinutes: 10 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "check-new-files") checkForNewFiles();
});
checkForNewFiles();
