// Runs on ms.gov.ge/msmap. Draws parcels by using the site's own search: type the code,
// click the "registered land parcels" result. The site keeps those outlines (keepResult),
// so several codes accumulate on the same map.
(() => {
  if (window.__msLookupLoaded) return; // injected twice (manifest + fallback injection)
  window.__msLookupLoaded = true;

  // Hand this browser's own ms.gov.ge session token to the extension (it stays in this browser).
  // The site may renew it (e.g. after its login redirect), so keep watching for a little while.
  let lastToken = null;
  const reportToken = () => {
    let t = null;
    try { t = localStorage.getItem("session-token"); } catch (e) { /* storage blocked */ }
    if (t && t !== lastToken && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(t)) {
      lastToken = t;
      chrome.runtime.sendMessage({ type: "ms-token", token: t }).catch(() => {});
    }
  };
  reportToken();
  let checks = 0;
  const tokenTimer = setInterval(() => { reportToken(); if (++checks >= 15) clearInterval(tokenTimer); }, 2000);
  window.addEventListener("storage", reportToken);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, timeoutMs) => {
    for (let t = 0; t < timeoutMs; t += 250) {
      const v = fn();
      if (v) return v;
      await sleep(250);
    }
    return null;
  };

  async function drawOne(code) {
    const input = await waitFor(() => document.querySelector('input[name="searchText"].app-custom-search-input'), 20000);
    if (!input) {
      console.warn("[ms-lookup] search box not found");
      return false;
    }
    input.focus();
    input.value = code;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    for (const type of ["keydown", "keypress", "keyup"]) {
      input.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    }
    // The NAPR row shows the code followed by "registered land parcels"; match the code exactly.
    const item = await waitFor(() =>
      [...document.querySelectorAll(".app-search-input-result-item-div")].find((d) => {
        const text = d.textContent.replace(/\s+/g, " ").trim();
        return text.split(" ")[0] === code && text.includes("რეგისტრირებული");
      }), 15000);
    if (!item) {
      console.warn(`[ms-lookup] no NAPR result row for ${code}`);
      return false;
    }
    item.click();
    // let the dropdown close and the outline render before the next code
    await waitFor(() => !document.querySelector(".app-search-input-result-item-div"), 3000);
    await sleep(300);
    console.log(`[ms-lookup] drew ${code}`);
    return true;
  }

  // One job at a time, even if a new request arrives while codes are still being drawn.
  let queue = Promise.resolve();
  function drawCodes(codes) {
    const job = queue.then(async () => {
      const drawn = [], failed = [];
      for (const code of codes) ((await drawOne(code)) ? drawn : failed).push(code);
      return { drawn, failed };
    });
    queue = job.catch(() => {});
    return job;
  }

  // ---------- applications (განცხადებები) ----------
  // The site draws an application contour only from its own search result row, and each new one
  // replaces the previous one. A small panel keeps a button for every contour, so any of them can be
  // drawn again; it stays until closed (× or Esc).

  // The page's own search responses (ms_hook.js), newest per search text.
  const siteResults = {};
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (e.source !== window || !m || m.source !== "napr-ms-hook" || m.type !== "unified-search") return;
    siteResults[String(m.text || "").trim().toUpperCase()] = { data: m.data, at: Date.now() };
  });

  // centre of a WKT outline (EPSG:4326 or Web Mercator) - only to tell contours apart
  function wktCenter(wkt) {
    const nums = String(wkt || "").match(/-?\d+(?:\.\d+)?/g);
    if (!nums || nums.length < 2) return null;
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (let k = 0; k + 1 < nums.length; k += 2) {
      let x = +nums[k], y = +nums[k + 1];
      if (Math.abs(x) > 180 || Math.abs(y) > 90) {
        const R = 6378137;
        x = (x / R) * 180 / Math.PI;
        y = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI;
      }
      a = Math.min(a, x); b = Math.max(b, x); c = Math.min(c, y); d = Math.max(d, y);
    }
    return [(a + b) / 2, (c + d) / 2];
  }

  // Which of the rows (in the order the page lists them) is the contour with this centre?
  function rowForCenter(number, center) {
    const r = siteResults[number];
    if (!center || !r) return -1;
    const same = (v) => String(v || "").trim().toUpperCase() === number;
    const geoms = [
      ...(r.data.universalIntegrationResult || []).filter((u) => same(u.clientDocumentNo)).map((u) => u.geometry),
      ...(r.data.architectureResult || []).filter((a) => same(a.appId)).map((a) => a.geometry)
    ];
    let best = -1, bestD = Infinity;
    geoms.forEach((g, k) => {
      const c = wktCenter(g);
      if (!c) return;
      const dd = Math.hypot(c[0] - center[0], c[1] - center[1]);
      if (dd < bestD) { bestD = dd; best = k; }
    });
    return bestD < 1e-5 ? best : -1; // ~1 m: the same outline
  }

  // Search the number and click the row of the contour (found by its centre in the page's own
  // response; `row` = the position the extension saw, used only if that cannot be checked).
  async function drawAppRow(number, row, center) {
    const since = Date.now();
    const input = await waitFor(() => document.querySelector('input[name="searchText"].app-custom-search-input'), 20000);
    if (!input) return false;
    input.focus();
    input.value = number;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    for (const type of ["keydown", "keypress", "keyup"]) {
      input.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    }
    const rowsOf = () => [...document.querySelectorAll(".app-search-input-result-item-div")]
      .filter((d) => d.textContent.replace(/\s+/g, " ").trim().split(" ")[0].toUpperCase() === number);
    if (!(await waitFor(() => rowsOf().length > row, 15000))) return false;
    // the rows on screen belong to the newest response (if the site did not search again, the previous one)
    await waitFor(() => siteResults[number] && siteResults[number].at >= since, 2000);
    await sleep(150);
    const rows = rowsOf();
    if (rows.length <= row) return false;
    const exact = rowForCenter(number, center);
    rows[exact >= 0 && exact < rows.length ? exact : row].click();
    await waitFor(() => !document.querySelector(".app-search-input-result-item-div"), 3000);
    input.blur();
    return true;
  }

  let panel = null, panelApps = [], active = null;
  function closePanel() {
    if (panel) panel.remove();
    panel = null;
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panel && !(e.target && e.target.matches && e.target.matches("input, textarea"))) closePanel();
  }, true);

  function renderPanel() {
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "napr-app-panel";
      const root = panel.attachShadow({ mode: "open" });
      root.innerHTML = `<style>
        * { box-sizing: border-box; }
        .box { position: fixed; top: 76px; right: 14px; z-index: 2147483000; width: 380px; max-width: calc(100vw - 28px); max-height: 66vh; display: flex; flex-direction: column;
               background: #fff; border: 1px solid #1d6fb8; border-radius: 8px; box-shadow: 0 4px 18px rgba(0,0,0,.25); font: 13px sans-serif; color: #222; }
        .head { display: flex; align-items: center; gap: 6px; padding: 6px 8px; background: #1d6fb8; color: #fff; border-radius: 7px 7px 0 0; cursor: move; }
        .head b { flex: 1; font-size: 13px; }
        .head button { background: none; border: none; color: #fff; font-size: 18px; cursor: pointer; line-height: 1; padding: 0 2px; }
        .body { overflow-y: auto; overflow-x: hidden; padding: 4px 6px 6px; }
        .app { margin-top: 6px; }
        .num { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 12.5px; }
        .num .grow { flex: 1; }
        .num a { font-weight: 400; font-size: 11.5px; color: #1d6fb8; text-decoration: none; }
        .kml { flex: none; font: 600 10.5px sans-serif; padding: 2px 6px; border: 1px solid #1d6fb8; border-radius: 4px; background: #fff; color: #1d6fb8; cursor: pointer; }
        .kml:hover { background: #e8f0fa; }
        .kml.done { border-color: #15803d; color: #15803d; }
        .kml.fail { border-color: #b91c1c; color: #b91c1c; }
        .item.on .kml { background: #fff; }
        .type { color: #555; font-size: 11.5px; margin: 1px 0 3px; }
        .item { display: flex; align-items: flex-start; gap: 6px; width: 100%; text-align: left; margin: 3px 0; padding: 5px 7px; border: 1px solid #c9d7e8;
                border-radius: 6px; background: #f6f9fd; cursor: pointer; font: 12.5px sans-serif; color: #222; }
        .item:hover { background: #e8f0fa; }
        .item.on { background: #1d6fb8; color: #fff; border-color: #1d6fb8; }
        .item.on .sub, .item.on a { color: #dce9f7; }
        .item.bad { border-color: #b91c1c; }
        .n { font-weight: 700; min-width: 16px; }
        .main { flex: 1; min-width: 0; }
        .sub { font-size: 11px; color: #666; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .item a { flex: none; font-size: 11px; color: #1d6fb8; text-decoration: none; white-space: nowrap; padding-top: 2px; }
        .acts { flex: none; display: flex; align-items: center; gap: 6px; }
        .hint { font-size: 10.5px; color: #888; padding: 0 8px 6px; }
      </style>
      <div class="box"><div class="head"><b>განცხადებები</b><button title="დახურვა (Esc)">×</button></div><div class="body"></div>
      <div class="hint">კონტურზე დაჭერა = რუკაზე დასმა · KML = ფაილის ჩამოტვირთვა · Esc = დახურვა</div></div>`;
      root.querySelector(".head button").addEventListener("click", closePanel);
      // the panel can be dragged out of the way by its header
      const box = root.querySelector(".box"), head = root.querySelector(".head");
      head.addEventListener("mousedown", (e) => {
        if (e.target.tagName === "BUTTON") return;
        const r = box.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
        const move = (ev) => { box.style.left = (ev.clientX - dx) + "px"; box.style.top = (ev.clientY - dy) + "px"; box.style.right = "auto"; };
        const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
        e.preventDefault();
      });
      document.body.appendChild(panel);
    }
    const body = panel.shadowRoot.querySelector(".body");
    body.textContent = "";
    panelApps.forEach((app, a) => {
      const wrap = document.createElement("div");
      wrap.className = "app";
      const num = document.createElement("div");
      num.className = "num";
      const label = document.createElement("span");
      label.textContent = app.number;
      num.appendChild(label);
      if (app.doc) {
        const d = document.createElement("a");
        d.href = app.doc; d.target = "_blank"; d.rel = "noopener"; d.textContent = "განცხადება ↗";
        num.appendChild(d);
      }
      const grow = document.createElement("span");
      grow.className = "grow";
      num.appendChild(grow);
      if (app.items.length > 1) num.appendChild(kmlButton(app, null, "KML (ყველა)", "ყველა კონტური ერთ .kml ფაილში"));
      const types = [...new Set(app.items.map((it) => it.type).filter(Boolean))];
      const type = document.createElement("div");
      type.className = "type";
      type.textContent = types.join("; ");
      wrap.append(num, type);
      app.items.forEach((it, i) => {
        const b = document.createElement("div");
        b.className = "item" + (active && active.a === a && active.i === i ? " on" : "") + (it.bad ? " bad" : "");
        b.setAttribute("role", "button");
        const n = document.createElement("span"); n.className = "n"; n.textContent = (i + 1) + ".";
        const main = document.createElement("div"); main.className = "main";
        const t = document.createElement("div"); t.textContent = it.cad || `კონტური ${i + 1}`;
        const sub = document.createElement("div"); sub.className = "sub"; sub.textContent = it.address || (it.cad ? "" : "საკადასტრო კოდი არ არის მითითებული");
        sub.title = sub.textContent;
        main.append(t, sub);
        const acts = document.createElement("div");
        acts.className = "acts";
        if (it.link && it.link.includes("objId=")) {
          const l = document.createElement("a");
          l.href = it.link; l.target = "_blank"; l.rel = "noopener"; l.textContent = "ლინკი ↗"; l.title = it.link;
          l.addEventListener("click", (e) => e.stopPropagation());
          acts.appendChild(l);
        }
        acts.appendChild(kmlButton(app, i, "KML", "ამ კონტურის .kml ფაილი"));
        b.append(n, main, acts);
        b.addEventListener("click", () => select(a, i));
        wrap.appendChild(b);
      });
      body.appendChild(wrap);
    });
  }

  // KML of one contour (index) or of the whole application (index = null), made by the extension
  function kmlButton(app, index, text, title) {
    const k = document.createElement("button");
    k.className = "kml";
    k.textContent = text;
    k.title = title;
    k.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (k.disabled) return;
      k.disabled = true;
      k.textContent = "…";
      k.classList.remove("done", "fail");
      const it = index === null ? null : app.items[index];
      let res = null;
      try {
        res = await chrome.runtime.sendMessage({ type: "ms-app-kml-part", number: app.number, index, center: it ? it.center : null });
      } catch (err) { res = { ok: false, error: err.message }; }
      k.disabled = false;
      k.textContent = res && res.ok ? "✓ " + text : "! " + text;
      k.classList.add(res && res.ok ? "done" : "fail");
      k.title = res && res.ok ? `ჩამოიტვირთა: ${res.file}` : `ვერ მოხერხდა: ${(res && res.error) || "?"}`;
    });
    return k;
  }

  let drawQueue = Promise.resolve();
  function select(a, i) {
    active = { a, i };
    renderPanel();
    const app = panelApps[a], it = app.items[i];
    drawQueue = drawQueue.then(async () => {
      const ok = await drawAppRow(app.number, Number.isInteger(it.row) ? it.row : i, it.center || null);
      it.bad = !ok;
      if (!ok) console.warn(`[ms-lookup] could not draw ${app.number} #${i + 1}`);
      renderPanel();
    }).catch(() => {});
    return drawQueue;
  }

  function showApps(apps, index) {
    if (!Array.isArray(apps) || !apps.length) return;
    panelApps = apps;
    active = null;
    renderPanel();
    const i = Math.max(0, Math.min((apps[0].items || []).length - 1, Number(index) || 0));
    return select(0, i);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "ms-app-show") return;
    Promise.resolve(showApps(message.apps, message.index)).then(() => sendResponse({ ok: true }));
    return true;
  });

  // ---------- the point under the mouse ----------
  // The site shows only the map centre, so the point is computed like the map does it: centre and
  // zoom from the address (#C=lon-lat@Z=zoom), Web Mercator, 256-pixel tiles (checked against the
  // coordinates the site itself sends when the map is clicked).
  let mouse = null;
  document.addEventListener("mousemove", (e) => {
    const vp = document.querySelector(".ol-viewport");
    const inside = vp && vp.contains(e.target) && !(panel && panel.contains(e.target));
    mouse = inside ? { x: e.clientX, y: e.clientY } : null;
  }, true);
  document.addEventListener("mouseleave", () => { mouse = null; });

  function pointerLonLat() {
    const vp = document.querySelector(".ol-viewport");
    const m = location.hash.match(/C=(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)@Z=(\d+(?:\.\d+)?)/);
    if (!mouse || !vp || !m) return null;
    const R = 6378137, r = vp.getBoundingClientRect();
    const lon0 = +m[1], lat0 = +m[2], zoom = +m[3];
    const cx = lon0 * Math.PI / 180 * R, cy = Math.log(Math.tan(Math.PI / 4 + lat0 * Math.PI / 360)) * R;
    const res = 2 * Math.PI * R / 256 / Math.pow(2, zoom);
    const x = cx + (mouse.x - (r.left + r.width / 2)) * res, y = cy - (mouse.y - (r.top + r.height / 2)) * res;
    return { lon: x / R * 180 / Math.PI, lat: (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI, zoom };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "ms-read-pointer") return;
    sendResponse(pointerLonLat());
  });

  // "Add to the open map" requests from the extension
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "ms-draw" || !Array.isArray(message.codes)) return;
    drawCodes(message.codes).then(sendResponse);
    return true;
  });

  // A tab the extension just opened: pick up its codes
  (async () => {
    let codes = null;
    try {
      codes = await chrome.runtime.sendMessage({ type: "ms-get-pending" });
    } catch (e) {
      return;
    }
    if (!codes) return; // tab was not opened by the extension
    if (codes.apps) return showApps(codes.apps, codes.index); // applications
    if (!Array.isArray(codes)) codes = [codes];
    const result = await drawCodes(codes);
    console.log("[ms-lookup] result:", JSON.stringify(result));
  })();
})();
