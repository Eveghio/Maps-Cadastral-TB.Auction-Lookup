// maps.gov.ge tab opened by Map Jump: search the coordinates with the site's own search box.
(() => {
  if (window.__mapJumpLoaded) return;
  window.__mapJumpLoaded = true;

  // The coordinates line in the bottom bar follows the mouse while it is over the map and is
  // empty otherwise. Read it at the moment of the request.
  // While a parcel is shown the site no longer updates its address, so a moved map cannot be read
  // from it: remember the point of the last click on the map, and whether the map was moved since
  // the address last changed.
  const readout = () => {
    const el = document.querySelector("div.p-3.font-thin.font-monospace");
    return el ? el.textContent.trim() : "";
  };
  const onMap = (e) => { const vp = document.querySelector(".ol-viewport"); return vp && vp.contains(e.target); };
  let down = null, lastClick = null, hashAt = Date.now(), movedAt = 0;
  window.addEventListener("hashchange", () => { hashAt = Date.now(); });
  document.addEventListener("mousedown", (e) => { down = onMap(e) ? { x: e.clientX, y: e.clientY } : null; }, true);
  document.addEventListener("mouseup", (e) => {
    if (!down) return;
    const dist = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    if (dist > 5) movedAt = Date.now();          // dragged the map
    else if (readout()) lastClick = { text: readout(), t: Date.now() }; // clicked a point
    down = null;
  }, true);
  document.addEventListener("wheel", (e) => { if (onMap(e)) movedAt = Date.now(); }, { capture: true, passive: true });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "jump-read-pointer") return;
    sendResponse({ text: readout(), click: lastClick && lastClick.t > hashAt ? lastClick.text : "", movedSinceAddress: movedAt > hashAt });
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, timeoutMs) => {
    for (let t = 0; t < timeoutMs; t += 250) {
      const v = fn();
      if (v) return v;
      await sleep(250);
    }
    return null;
  };

  (async () => {
    let loc = null;
    try {
      loc = await chrome.runtime.sendMessage({ type: "jump-get-pending" });
    } catch (e) {
      return;
    }
    if (!loc) return; // not opened by Map Jump

    // the map is ready once the site writes its default "#state/..." address
    await waitFor(() => location.hash.startsWith("#state/"), 20000);
    const box = await waitFor(() => document.querySelector("input#search_box"), 10000);
    const btn = document.querySelector("#search_button");
    if (!box || !btn) return console.warn("[map-jump] search box not found");

    box.value = `${loc.lon.toFixed(7)},${loc.lat.toFixed(7)}`;
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.dispatchEvent(new Event("change", { bubbles: true }));
    btn.click();
    console.log("[map-jump] searched", box.value);
  })();
})();
