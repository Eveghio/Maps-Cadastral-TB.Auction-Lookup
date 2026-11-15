// Shared by popup.html, notice.html and history.html

// site -> colour (the same colours as the popup rows)
const SITES = {
  maps: { label: "maps.gov.ge", color: "#2e7d32" },
  ms: { label: "ms.gov.ge", color: "#1d6fb8" },
  registry: { label: "რეესტრი", color: "#8d5a00" },
  auction: { label: "აუქციონი", color: "#8d5a00" },
  contours: { label: "კონტურები", color: "#e65100" },
  jump: { label: "ადგილი →", color: "#444" }
};

// action -> site + short name (order = order in the history filter)
const ACTIONS = {
  "maps-map": { site: "maps", name: "რუკა" },
  "maps-kml": { site: "maps", name: "KML" },
  "maps-person": { site: "maps", name: "პირადი ნომრით" },
  "maps-person-kml": { site: "maps", name: "პირადი ნომრით KML" },
  "ms-map": { site: "ms", name: "რუკა" },
  "ms-kml": { site: "ms", name: "KML" },
  "ms-app": { site: "ms", name: "განცხადება" },
  "ms-app-kml": { site: "ms", name: "განცხადების KML" },
  "pdf": { site: "registry", name: "ამონაწერი" },
  "plan": { site: "registry", name: "საკადასტრო გეგმა" },
  "abstract": { site: "registry", name: "ყველა დოკუმენტის გვერდი" },
  "contours-map": { site: "contours", name: "რუკაზე (geojson.io)" },
  "contours-kml": { site: "contours", name: "KML" },
  "plan-kml": { site: "contours", name: "გეგმა → KML" },
  "auction": { site: "auction", name: "ლოტი" },
  "jump-maps": { site: "jump", name: "maps.gov.ge" },
  "jump-ms": { site: "jump", name: "ms.gov.ge" },
  "jump-google": { site: "jump", name: "Google Maps" },
  "jump-geojson": { site: "jump", name: "geojson.io" },
  "point-code": { site: "jump", name: "საკადასტრო კოდი" }
};

const STATUS_LABELS = { found: "მოიძებნა", missing: "ვერ მოიძებნა", error: "შეცდომა", opened: "გაიხსნა" };

function actionLabel(action) {
  const a = ACTIONS[action];
  if (!a) return action;
  return a.site === "jump" ? `ადგილი → ${a.name}` : `${SITES[a.site].label} · ${a.name}`;
}
function actionColor(action) {
  const a = ACTIONS[action];
  return a ? SITES[a.site].color : "#555";
}

// Open the history page, or bring it to the front if it is already open.
async function openHistoryPage() {
  const url = chrome.runtime.getURL("history.html");
  const [tab] = await chrome.tabs.query({ url });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

function formatTime(t) {
  const d = new Date(t), p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
