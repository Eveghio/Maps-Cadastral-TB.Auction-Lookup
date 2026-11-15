const input = document.getElementById("code");
const msg = document.getElementById("msg");

// Everything runs in background.js (runAction); the popup only shows errors.
function run(action, newTab) {
  msg.style.color = "#555";
  msg.textContent = "ვეძებ...";
  chrome.runtime.sendMessage({ type: "run", action, text: input.value, newTab }, (res) => {
    if (chrome.runtime.lastError || !res) {
      msg.style.color = "#c62828";
      msg.textContent = "შეცდომა: პასუხი ვერ მივიღე";
      return;
    }
    if (res.ok) return window.close();
    msg.style.color = "#c62828";
    msg.textContent = res.error;
  });
}

for (const btn of document.querySelectorAll("button[data-action]")) {
  btn.addEventListener("click", (e) => {
    const action = btn.dataset.action;
    const canNewTab = ["maps-map", "ms-map", "ms-app", "maps-person"].includes(action);
    run(action, canNewTab && (btn.dataset.new === "1" || e.shiftKey));
  });
}
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    // only an application number (no cadastral code) -> ms.gov.ge application
    const v = input.value;
    const noCode = !/\d+\.\d+\.\d+/.test(v);
    const isApp = noCode && /(^|[^\w.\-])(AR\d{1,10}|\d{1,15}-\d{1,15})(?![\w.\-])/i.test(v);
    const isPerson = noCode && !isApp && /(^|[^\d.\-\/])\d{11}(?![\d.\-\/])/.test(v);
    run(isApp ? "ms-app" : isPerson ? "maps-person" : "maps-map", e.shiftKey);
  }
});
document.getElementById("contoursList").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "contours-open-list", text: input.value }, () => window.close());
});
document.getElementById("historyLink").addEventListener("click", (e) => {
  e.preventDefault();
  openHistoryPage().then(() => window.close());
});
// "This place ->": the place shown in the active tab, opened on another map
const JUMP_NAMES = { maps: "maps.gov.ge", ms: "ms.gov.ge", google: "Google Maps", geojson: "geojson.io" };
(async () => {
  const info = document.getElementById("jumpInfo");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  // "code": the place on the map in this tab, or coordinates typed/pasted into the box
  const pc = document.getElementById("pointCode");
  pc.disabled = false;
  pc.onclick = () => {
    msg.style.color = "#555";
    msg.textContent = "ვეძებ...";
    chrome.runtime.sendMessage({ type: "point-code", tabId: tab.id, text: input.value }, (r) => {
      if (r && r.ok) window.close();
      else { msg.style.color = "#c62828"; msg.textContent = (r && r.error) || "შეცდომა"; }
    });
  };
  chrome.runtime.sendMessage({ type: "jump-info", tabId: tab.id }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) {
      info.className = "err";
      info.textContent = (res && res.error) || "ადგილი ვერ განვსაზღვრე";
      return;
    }
    const l = res.loc;
    info.textContent = `${JUMP_NAMES[l.site]} · ${l.how} · ${l.lat.toFixed(6)}, ${l.lon.toFixed(6)} · ზუმი ${Math.round(l.zoom)}`;
    for (const b of document.querySelectorAll("button[data-jump]")) {
      const target = b.dataset.jump;
      b.disabled = target === l.site;
      b.onclick = () => {
        msg.textContent = "";
        chrome.runtime.sendMessage({ type: "jump", target, tabId: tab.id }, (r) => {
          if (r && r.ok) window.close();
          else { msg.style.color = "#c62828"; msg.textContent = (r && r.error) || "შეცდომა"; }
        });
      };
    }
  });
})();
input.focus();
