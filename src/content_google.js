// Runs on Google Maps. Google does not show the coordinates under the mouse, so they are computed
// from the address (@lat,lng,<zoom>z or <metres>m) and the window size, like the map draws them
// (the map canvas fills the whole window, the side panel lies over it). In the satellite view the
// "metres" value is about 1.75% off the drawn scale; that factor is re-measured from Google's own
// right-click menu (which shows the exact coordinates) whenever the user opens it.
(() => {
  if (window.__naprGoogleLoaded) return;
  window.__naprGoogleLoaded = true;

  const R = 6378137;
  let scaleM = 1.0175;
  try { chrome.storage.local.get("googleScaleM").then((d) => { if (d && d.googleScaleM) scaleM = d.googleScaleM; }).catch(() => {}); } catch (e) { /* ignore */ }

  function view() {
    const m = location.href.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?)([zm])/);
    if (!m) return null;
    const lat = +m[1], lon = +m[2], v = +m[3], unit = m[4];
    const base = unit === "z" ? 2 * Math.PI * R / 256 / Math.pow(2, v) : (v / window.innerHeight) / Math.cos(lat * Math.PI / 180);
    return { lat, lon, unit, base, res: unit === "m" ? base * scaleM : base, zoom: unit === "z" ? v : Math.log2(2 * Math.PI * R / 256 / (base * scaleM)) };
  }
  const merc = (lat, lon) => [lon * Math.PI / 180 * R, Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * R];
  const unmerc = (x, y) => ({ lon: x / R * 180 / Math.PI, lat: (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI });

  function pointAt(x, y) {
    const v = view();
    if (!v) return null;
    const [cx, cy] = merc(v.lat, v.lon);
    return { ...unmerc(cx + (x - window.innerWidth / 2) * v.res, cy - (y - window.innerHeight / 2) * v.res), zoom: v.zoom };
  }

  // the mouse, only while it is over the map itself
  let mouse = null;
  document.addEventListener("mousemove", (e) => { mouse = e.target && e.target.tagName === "CANVAS" ? { x: e.clientX, y: e.clientY } : null; }, true);
  document.addEventListener("mouseleave", () => { mouse = null; });

  // Google's right-click menu shows the exact point ("41.722691, 44.762539")
  let right = null;
  document.addEventListener("contextmenu", (e) => {
    if (!e.target || e.target.tagName !== "CANVAS") return;
    const at = { x: e.clientX, y: e.clientY, v: view() };
    let tries = 0;
    const read = () => {
      const t = [...document.querySelectorAll('[role="menu"] *, [role="menuitemradio"], [role="menuitem"]')]
        .map((n) => n.textContent.trim()).find((s) => /^-?\d+\.\d+,\s*-?\d+\.\d+$/.test(s));
      if (!t) { if (++tries < 15) setTimeout(read, 100); return; }
      const [lat, lon] = t.split(",").map(Number);
      right = { lat, lon, t: Date.now() };
      // re-measure the satellite scale factor from this exact point
      if (at.v && at.v.unit === "m") {
        const [cx, cy] = merc(at.v.lat, at.v.lon), [gx, gy] = merc(lat, lon);
        const dx = at.x - window.innerWidth / 2, dy = at.y - window.innerHeight / 2;
        if (Math.hypot(dx, dy) > 150) {
          const ratio = (Math.abs(dx) > Math.abs(dy) ? (gx - cx) / dx : -(gy - cy) / dy) / at.v.base;
          if (ratio > 0.95 && ratio < 1.1) { scaleM = ratio; try { chrome.storage.local.set({ googleScaleM: ratio }); } catch (err) { /* ignore */ } }
        }
      }
    };
    setTimeout(read, 150);
  }, true);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "google-read-pointer") return;
    sendResponse({ pointer: mouse ? pointAt(mouse.x, mouse.y) : null, right });
  });
})();
