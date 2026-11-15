// Runs on maps.gov.ge/map/portal. Adds parcels by changing the portal's own
// "#search/result/...getinfo.alpha?lbl=..." hash; the portal keeps the previous parcels
// in its side panel, so several codes accumulate on the same map.
(() => {
  if (window.__mapsLookupLoaded) return; // injected twice (manifest + fallback injection)
  window.__mapsLookupLoaded = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, timeoutMs) => {
    for (let t = 0; t < timeoutMs; t += 250) {
      const v = fn();
      if (v) return v;
      await sleep(250);
    }
    return null;
  };
  const shownCodes = () =>
    [...document.querySelectorAll(".info_sidebar_container .title_el")].map((e) => e.textContent.trim().split(/\s+/)[0]);
  const hashFor = (lbl) => `#search/result/lr/bo/mg/getinfo.alpha?lbl=${lbl}&share=1&layers=92,97`;

  // "already" = shown in the side panel (adding again would duplicate it), "drawn", "failed"
  async function addOne({ code, lbl }) {
    if (shownCodes().includes(code)) return "already";
    const target = hashFor(lbl);
    if (location.hash === target) { // same hash would not fire a hashchange
      location.hash = "x";
      await sleep(300);
    }
    location.hash = target;
    return (await waitFor(() => shownCodes().includes(code), 15000)) ? "drawn" : "failed";
  }

  // One job at a time, even if a new request arrives while codes are still being added.
  let queue = Promise.resolve();
  function addAll(items, firstFromUrl) {
    const job = queue.then(async () => {
      // a freshly opened tab loads the first parcel from its own URL: let it finish first
      if (firstFromUrl && items.length) await waitFor(() => shownCodes().includes(items[0].code), 20000);
      const result = { drawn: [], already: [], failed: [] };
      for (const item of items) result[await addOne(item)].push(item.code);
      console.log("[maps-lookup] result:", JSON.stringify(result));
      return result;
    });
    queue = job.catch(() => {});
    return job;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "maps-draw" || !Array.isArray(message.items)) return;
    addAll(message.items, false).then(sendResponse);
    return true;
  });

  (async () => {
    let items = null;
    try {
      items = await chrome.runtime.sendMessage({ type: "maps-get-pending" });
    } catch (e) {
      return;
    }
    if (Array.isArray(items) && items.length) addAll(items, true);
  })();
})();
