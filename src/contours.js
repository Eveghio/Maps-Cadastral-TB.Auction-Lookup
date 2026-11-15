// contours.html - კონტურების სია: რამდენიმე საკადასტრო კოდის კონტური ერთად (რუკაზე ან KML-ად).
//
// სია ერთია და გროვდება: ყოველი ახალი ბრძანება არსებულ სიას ამატებს (არ ცვლის), სანამ "სიის გასუფთავებას"
// არ დააჭერ ან ბრაუზერს არ დახურავ. ასე ერთ რუკაზე შეგიძლია მოაგროვო, მაგალითად, ერთი კოდის მიმდინარე
// კონტური და მეორე კოდის მე-3 (ძველი) გეგმის კონტური.
//
// სიაში ჩანაწერი ემატება სამი გზით:
//   1. ბრძანება "კონტურები · რუკაზე" / "კონტურები · KML" (background.js -> requestFromBackground)
//   2. viewer-ის ღილაკი "კონტური რუკაზე": იქ ნაჩვენები გეგმის მზა კონტური (viewer.js წერს პირდაპირ საცავში)
//   3. ამ გვერდის ველი "კოდის დამატება"
//   4. ms.gov.ge-ს განცხადების პანელი: კოდის გარეშე კონტური მზა პოლიგონით (wantedSource "application",
//      background.js წერს პირდაპირ საცავში; წყაროს შეცვლა მას არ აქვს)
//
// თითო ჩანაწერს აქვს "რა გვინდა" (wantedSource):
//   "auto"  ჯერ რუკები (maps.gov.ge, მერე ms.gov.ge); თუ კოდი რუკებზე არ არის, ბოლო საკადასტრო გეგმა
//   "plan"  რუკებს არ ეძებს: planNumber-ე საკადასტრო გეგმა (1 = ყველაზე ახალი)
// ამას სტრიქონის ჩამოსაშლელი სიით ცვლი ("წყარო").

import { CONTOUR_SOURCE, buildGeoJson, buildGeoJsonIoLink, buildKml, describeSource, formatDate, kmlFileName } from "./contours_core.js";
import { contourFromPlanNumber, listPlans } from "./plan_contour.js";

const CADASTRAL_CODE_PATTERN = /\d+(?:\.\d+){2,9}[ა-ჰ]?/g; // იგივე, რაც background.js-ში

// ---------- სია და მისი შენახვა ----------
// სია ინახება chrome.storage.session-ში: გვერდის გადატვირთვას უძლებს, ბრაუზერის დახურვისას იშლება.
const COLLECTION_STORAGE_KEY = "contourCollection";

// ჩანაწერი (entry):
//   id             უნიკალური ნომერი
//   cadastralCode  საკადასტრო კოდი
//   wantedSource   "auto" | "plan"
//   planNumber     რომელი გეგმა (მხოლოდ "plan"-ისთვის; 1 = ყველაზე ახალი)
//   state          "working" (მუშავდება) | "ready" (კონტური მზად არის) | "missing" (ვერ ვიპოვე) | "failed" (შეცდომა)
//   contour        მზა კონტური (contours_core.js-ის ფორმით) ან null
//   problemText    რატომ ვერ მოხერხდა (missing / failed)
//   mapProblems    რუკების შეცდომები (მაგ. სერვერმა არ უპასუხა), თუნდაც კონტური მერე გეგმიდან მოვიდეს
//   plans          ამ კოდის გეგმების სია [{ planNumber, planDateMs }] ან null, თუ ჯერ არ ჩატვირთულა
//   progressText   რას აკეთებს ახლა (მხოლოდ ეკრანისთვის)
let entries = [];
const removedEntryIds = new Set(); // წაშლილები: სხვა ტაბიდან შენახულმა ძველმა ასლმა არ უნდა "გააცოცხლოს"

const newEntryId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function createEntry(cadastralCode, wantedSource = "auto", planNumber = 1) {
  return { id: newEntryId(), cadastralCode, wantedSource, planNumber, state: "working", contour: null,
    problemText: "", mapProblems: [], plans: null, progressText: "რიგშია…" };
}

// საცავში არსებული ჩანაწერები, რომლებიც აქ ჯერ არ გვაქვს (მაგ. viewer-მა დაამატა), სიას ემატება
async function mergeEntriesFromStorage() {
  const stored = (await chrome.storage.session.get(COLLECTION_STORAGE_KEY))[COLLECTION_STORAGE_KEY] || [];
  const knownIds = new Set(entries.map((entry) => entry.id));
  for (const storedEntry of stored) {
    if (!knownIds.has(storedEntry.id) && !removedEntryIds.has(storedEntry.id)) entries.push(storedEntry);
  }
}

async function saveEntries() {
  await mergeEntriesFromStorage();
  await chrome.storage.session.set({ [COLLECTION_STORAGE_KEY]: entries });
}

const byId = (id) => document.getElementById(id);
const readyContoursOf = (list) => list.filter((entry) => entry.state === "ready").map((entry) => entry.contour);

// ---------- ერთი ჩანაწერის დამუშავება ----------

// background.js ეძებს კოდს რუკებზე (იგივე ძებნა, რასაც "რუკაზე" და "KML" ღილაკები იყენებენ)
async function findContourOnMaps(cadastralCode) {
  const answer = await chrome.runtime.sendMessage({ type: "find-contour-on-maps", code: cadastralCode });
  return answer || { found: false, problems: ["background-მა არ უპასუხა"] };
}

function setProgress(entry, text) {
  entry.progressText = text;
  render();
}

async function processEntry(entry) {
  entry.contour = null;
  entry.problemText = "";
  entry.mapProblems = [];

  let planNumber = entry.planNumber;
  if (entry.wantedSource === "auto") {
    setProgress(entry, "ვეძებ რუკებზე…");
    const onMaps = await findContourOnMaps(entry.cadastralCode);
    entry.mapProblems = onMaps.problems || [];
    if (onMaps.found) {
      entry.contour = {
        cadastralCode: entry.cadastralCode,
        source: onMaps.source === "ms" ? CONTOUR_SOURCE.MS : CONTOUR_SOURCE.MAPS,
        polygons: onMaps.polygons,
        address: onMaps.address || "",
        planDateMs: null,
        accuracyMeters: null,
        warnings: []
      };
      entry.state = "ready";
      return;
    }
    planNumber = 1; // რუკებზე არ არის -> ბოლო საკადასტრო გეგმა
  }

  const notOnMapsPrefix = entry.wantedSource === "auto" ? "რუკებზე არ არის" : "";
  setProgress(entry, (notOnMapsPrefix ? notOnMapsPrefix + ". " : "") + "ვკითხულობ საკადასტრო გეგმებს რეესტრიდან…");
  try {
    const fromPlan = await contourFromPlanNumber(entry.cadastralCode, planNumber);
    entry.plans = fromPlan.plans;
    if (fromPlan.contour) {
      entry.contour = fromPlan.contour;
      entry.state = "ready";
    } else {
      entry.state = "missing";
      entry.problemText = (notOnMapsPrefix ? notOnMapsPrefix + "; " : "") + fromPlan.reason;
    }
  } catch (error) {
    entry.state = "failed";
    entry.problemText = `რეესტრის წაკითხვა ვერ მოხერხდა: ${error.message || error}`;
  }
}

// ამუშავებს ყველა ჩანაწერს, რომელიც "working" მდგომარეობაშია. რიგრიგობით: რუკების სერვერებს და რეესტრს
// ერთდროულად ბევრი მოთხოვნა ანელებს. თუ უკვე მუშაობს, იმავე გაშვებას ელოდება.
let processingRun = null;
function processWaitingEntries() {
  if (!processingRun) {
    processingRun = (async () => {
      for (;;) {
        const entry = entries.find((candidate) => candidate.state === "working");
        if (!entry) break;
        await processEntry(entry);
        if (entry.state === "working") entry.state = "failed"; // დაცვა უსასრულო ციკლისგან
        await saveEntries();
        render();
      }
    })().finally(() => { processingRun = null; });
  }
  return processingRun;
}

// ---------- შედეგის გამოყენება ----------

// ჩვენი გახსნილი geojson.io ტაბი: ხელახლა ჩვენებისას ის იცვლება ახლით იმავე ადგილას.
// ნომერი chrome.storage.session-შიც ინახება, რომ სიის გვერდის გადატვირთვის მერეც იგივე ტაბი ვიპოვოთ.
const GEOJSON_TAB_STORAGE_KEY = "contoursGeoJsonIoTabId";
let geoJsonIoTabId = null;

// geojson.io მონაცემს (#data=...) მხოლოდ გვერდის პირველი ჩატვირთვისას კითხულობს და მერე მისამართს თავისით
// ცვლის. ამიტომ უკვე გახსნილ ტაბში ახალი ბმულის ჩაწერა (+ reload) საიმედოდ არ მუშაობდა: ახალი კონტური
// რუკაზე არ ჩნდებოდა. ახლა ძველ ტაბს ვხურავთ და იმავე ფანჯარაში, იმავე პოზიციაზე ვხსნით ახალს.
async function showOnGeoJsonIo() {
  const link = await buildGeoJsonIoLink(readyContoursOf(entries));
  if (!link) {
    showMessage("კონტურები ბმულისთვის ზედმეტად დიდია. გამოიყენე „GeoJSON ფაილი“ და ფაილი geojson.io-ზე ჩააგდე.", true);
    return;
  }
  const newTabOptions = { url: link, active: true };
  if (geoJsonIoTabId === null) geoJsonIoTabId = (await chrome.storage.session.get(GEOJSON_TAB_STORAGE_KEY))[GEOJSON_TAB_STORAGE_KEY] ?? null;
  if (geoJsonIoTabId !== null) {
    try {
      const oldTab = await chrome.tabs.get(geoJsonIoTabId);
      newTabOptions.windowId = oldTab.windowId;
      newTabOptions.index = oldTab.index;
      await chrome.tabs.remove(oldTab.id);
    } catch (error) {
      // ძველი ტაბი უკვე დახურულია: უბრალოდ ახალს ვხსნით
    }
  }
  const tab = await chrome.tabs.create(newTabOptions);
  geoJsonIoTabId = tab.id;
  await chrome.storage.session.set({ [GEOJSON_TAB_STORAGE_KEY]: tab.id });
  if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
}

function saveFile(fileName, text, mimeType) {
  const blobAddress = URL.createObjectURL(new Blob([text], { type: mimeType }));
  chrome.downloads.download({ url: blobAddress, filename: fileName, saveAs: false },
    () => setTimeout(() => URL.revokeObjectURL(blobAddress), 30000));
}

function downloadKmlOf(list) {
  const contours = readyContoursOf(list);
  for (const contour of contours) saveFile(kmlFileName(contour), buildKml(contour), "application/vnd.google-earth.kml+xml");
  return contours.length;
}

function downloadGeoJsonFile() {
  const contours = readyContoursOf(entries);
  const fileName = (contours.length === 1 ? contours[0].cadastralCode : `konturebi_${contours.length}`) + ".geojson";
  saveFile(fileName, JSON.stringify(buildGeoJson(contours), null, 1), "application/geo+json");
  showMessage(`ჩამოიტვირთა ${fileName}.`);
}

function writeHistory(historyAction, list) {
  if (!list.length) return;
  const rows = list.map((entry) => ({
    code: entry.cadastralCode,
    status: entry.state === "ready" ? "found" : entry.state === "missing" ? "missing" : "error",
    error: entry.state === "ready" ? "" : entry.problemText,
    note: entry.state === "ready" ? describeSource(entry.contour) : ""
  }));
  chrome.runtime.sendMessage({ type: "contours-history", action: historyAction, rows, url: chrome.runtime.getURL("contours.html") }).catch(() => {});
}

// ---------- მოთხოვნა: კოდების დამატება და (სურვილისამებრ) მოქმედება, როცა მზად იქნება ----------
// codes        დასამატებელი კოდები (შეიძლება ცარიელი: მაშინ მხოლოდ მოქმედება არსებულ სიაზე)
// actionWhenReady  "map" (მთელი სია geojson.io-ზე) | "kml" (ამ მოთხოვნის კოდების .kml) | "none"
async function handleRequest(codes, actionWhenReady) {
  await mergeEntriesFromStorage(); // მაგ. viewer-ის ახლახან დამატებული კონტური

  const requestEntries = [], newEntries = [];
  for (const cadastralCode of codes) {
    // იგივე კოდი "auto" წყაროთი უკვე სიაშია -> მეორედ არ ვამატებთ
    let entry = entries.find((existing) => existing.cadastralCode === cadastralCode && existing.wantedSource === "auto");
    if (!entry) {
      entry = createEntry(cadastralCode);
      entries.push(entry);
      newEntries.push(entry);
    } else if (entry.state === "failed") {
      entry.state = "working"; // წინა ჯერზე შეცდომა იყო (მაგ. სერვერი არ პასუხობდა): ხელახლა ვცდით
    }
    requestEntries.push(entry);
  }
  await saveEntries();
  render();
  await processWaitingEntries();

  if (actionWhenReady !== "none") writeHistory(actionWhenReady === "kml" ? "contours-kml" : "contours-map", newEntries);
  const notReadyCount = requestEntries.filter((entry) => entry.state !== "ready").length;

  if (actionWhenReady === "kml") {
    const downloadedCount = downloadKmlOf(requestEntries);
    showMessage(notReadyCount
      ? `ჩამოიტვირთა ${downloadedCount} KML ფაილი; ${notReadyCount} კოდი ვერ ვიპოვე (იხ. სია).`
      : `ჩამოიტვირთა ${downloadedCount} KML ფაილი.`, notReadyCount > 0);
  } else if (actionWhenReady === "map") {
    if (!readyContoursOf(entries).length) showMessage("სიაში მზა კონტური არ არის.", true);
    else if (notReadyCount) showMessage(`${notReadyCount} კოდი ვერ ვიპოვე (იხ. სია). დანარჩენის სანახავად დააჭირე „რუკაზე ჩვენება“.`, true);
    else await showOnGeoJsonIo();
  }
}

// ---------- ხატვა ----------

function showMessage(text, isProblem = false) {
  const message = byId("message");
  message.textContent = text;
  message.className = isProblem ? "problem" : "";
}

function detailsElement(entry) {
  const details = document.createElement("div");
  details.className = "details";
  const addLine = (text, className = "") => {
    const line = document.createElement("div");
    line.textContent = text;
    line.className = className;
    details.append(line);
  };

  if (entry.state === "working") addLine(entry.progressText || "რიგშია…");
  if (entry.state === "missing" || entry.state === "failed") addLine(entry.problemText);

  const contour = entry.contour;
  if (contour && contour.address) addLine(contour.address);
  if (contour && contour.source === CONTOUR_SOURCE.APPLICATION && contour.applicationTopic) addLine(contour.applicationTopic);
  if (contour && contour.source === CONTOUR_SOURCE.PLAN) {
    if (contour.areaInPdf != null) {
      addLine(`ფართობი გეგმაში ${contour.areaInPdf} კვ.მ, კონტურიდან ${contour.areaCalculated.toFixed(1)} კვ.მ (სხვაობა ${contour.areaDifferencePercent.toFixed(2)}%)`,
        contour.areaIsSuspicious ? "warning" : "");
    }
    if (contour.accuracyMeters) {
      addLine(`სავარაუდო ცდომილება: ჩვეულებრივ ±${contour.accuracyMeters.typical.toFixed(1)} მ, მაქს. ±${contour.accuracyMeters.max.toFixed(1)} მ${contour.isRaster ? " (საზღვარი სურათიდან)" : ""}`);
    }
    for (const warning of contour.warnings) addLine(warning, "warning");
  }
  for (const problem of entry.mapProblems || []) addLine(problem, "warning");
  return details;
}

// ჩამოსაშლელი სია "წყარო": რუკა (ავტომატურად) ან კონკრეტული გეგმა
const LOAD_PLANS_OPTION = "load-plans";

function sourceSelectElement(entry) {
  const select = document.createElement("select");
  select.title = "საიდან აიღოს კონტური";
  const addOption = (value, text) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    select.append(option);
  };

  addOption("auto", "რუკა (თუ არ არის: ბოლო გეგმა)");
  if (entry.plans) {
    for (const plan of entry.plans) addOption(`plan:${plan.planNumber}`, `გეგმა ${plan.planNumber} · ${formatDate(plan.planDateMs) || "თარიღი უცნობია"}`);
  } else {
    addOption("plan:1", "ბოლო საკადასტრო გეგმა");
    if (entry.wantedSource === "plan" && entry.planNumber > 1) addOption(`plan:${entry.planNumber}`, `გეგმა ${entry.planNumber}`);
    addOption(LOAD_PLANS_OPTION, "სხვა გეგმა… (სიის ჩატვირთვა)");
  }
  select.value = entry.wantedSource === "auto" ? "auto" : `plan:${entry.planNumber}`;
  select.disabled = entry.state === "working";

  select.onchange = async () => {
    if (select.value === LOAD_PLANS_OPTION) {
      select.disabled = true;
      showMessage(`${entry.cadastralCode}: ვკითხულობ გეგმების სიას რეესტრიდან…`);
      try {
        entry.plans = await listPlans(entry.cadastralCode);
        showMessage(entry.plans.length ? `${entry.cadastralCode}: ${entry.plans.length} საკადასტრო გეგმა. აირჩიე სიიდან.` : `${entry.cadastralCode}: რეესტრში საკადასტრო გეგმა არ არის.`, !entry.plans.length);
      } catch (error) {
        showMessage(`${entry.cadastralCode}: გეგმების სია ვერ წავიკითხე: ${error.message || error}`, true);
      }
      await saveEntries();
      render();
      return;
    }
    if (select.value === "auto") {
      entry.wantedSource = "auto";
    } else {
      entry.wantedSource = "plan";
      entry.planNumber = +select.value.split(":")[1];
    }
    entry.state = "working";
    entry.progressText = "რიგშია…";
    showMessage("");
    await saveEntries();
    render();
    await processWaitingEntries();
  };
  return select;
}

function smallButton(text, title, onClick) {
  const button = document.createElement("button");
  button.className = "small";
  button.textContent = text;
  button.title = title;
  button.onclick = onClick;
  return button;
}

function render() {
  const tableBody = byId("rows");
  tableBody.textContent = "";
  for (const entry of entries) {
    const row = document.createElement("tr");

    const codeCell = document.createElement("td");
    codeCell.className = "code";
    codeCell.textContent = entry.cadastralCode;

    const sourceCell = document.createElement("td");
    sourceCell.className = "source";
    if (entry.state === "ready") {
      sourceCell.classList.add({ [CONTOUR_SOURCE.PLAN]: "from-plan", [CONTOUR_SOURCE.APPLICATION]: "from-application" }[entry.contour.source] || "from-map");
      const dot = document.createElement("span");
      dot.className = "dot";
      sourceCell.append(dot, describeSource(entry.contour));
    } else {
      sourceCell.classList.add(entry.state);
      sourceCell.textContent = { working: "მუშავდება…", missing: "ვერ ვიპოვე", failed: "შეცდომა" }[entry.state];
    }

    const detailsCell = document.createElement("td");
    detailsCell.append(detailsElement(entry));

    const controlsCell = document.createElement("td");
    controlsCell.className = "controls";
    const isApplicationContour = entry.wantedSource === "application"; // მზა პოლიგონი: წყარო და ასლი არ აქვს
    if (!isApplicationContour) controlsCell.append(
      sourceSelectElement(entry),
      smallButton("⧉", "ამ კოდის კიდევ ერთი სტრიქონი (მაგ. მიმდინარე საზღვარი და ძველი გეგმა ერთად)", async () => {
        const copy = createEntry(entry.cadastralCode, "plan", 1);
        copy.plans = entry.plans;
        entries.splice(entries.indexOf(entry) + 1, 0, copy);
        await saveEntries();
        render();
        await processWaitingEntries();
      }));
    controlsCell.append(
      smallButton("✕", "სიიდან ამოღება", async () => {
        removedEntryIds.add(entry.id);
        entries = entries.filter((other) => other !== entry);
        await chrome.storage.session.set({ [COLLECTION_STORAGE_KEY]: entries });
        render();
      })
    );

    row.append(codeCell, sourceCell, detailsCell, controlsCell);
    tableBody.append(row);
  }
  byId("emptyList").hidden = entries.length > 0;

  const readyCount = readyContoursOf(entries).length;
  const workingCount = entries.filter((entry) => entry.state === "working").length;
  const fromPlanCount = readyContoursOf(entries).filter((contour) => contour.source === CONTOUR_SOURCE.PLAN).length;
  byId("summary").textContent = !entries.length ? ""
    : workingCount ? `მუშავდება: დარჩა ${workingCount} / ${entries.length}`
    : `სიაში ${entries.length} სტრიქონია, მზად არის ${readyCount}` + (fromPlanCount ? ` (მათგან ${fromPlanCount} საკადასტრო გეგმიდან)` : "");
  for (const buttonId of ["openOnMap", "downloadKml", "downloadGeoJson"]) byId(buttonId).disabled = !readyCount || workingCount > 0;
  byId("clearList").disabled = !entries.length || workingCount > 0;
}

// ---------- ღილაკები ----------

byId("openOnMap").onclick = showOnGeoJsonIo;
byId("downloadKml").onclick = () => showMessage(`ჩამოიტვირთა ${downloadKmlOf(entries)} KML ფაილი.`);
byId("downloadGeoJson").onclick = downloadGeoJsonFile;
byId("clearList").onclick = async () => {
  for (const entry of entries) removedEntryIds.add(entry.id);
  entries = [];
  await chrome.storage.session.set({ [COLLECTION_STORAGE_KEY]: [] });
  showMessage("სია გასუფთავდა.");
  render();
};

function addCodesFromInput() {
  const input = byId("codesInput");
  const codes = [...new Set(input.value.match(CADASTRAL_CODE_PATTERN) || [])];
  if (!codes.length) return showMessage("ველში საკადასტრო კოდი ვერ ვიპოვე.", true);
  input.value = "";
  showMessage("");
  handleRequest(codes, "none");
}
byId("addCodes").onclick = addCodesFromInput;
byId("codesInput").addEventListener("keydown", (event) => { if (event.key === "Enter") addCodesFromInput(); });

// ---------- გაშვება ----------

let myTabId = null;

// background.js -> ეს გვერდი (როცა გვერდი უკვე ღიაა): ახალი ბრძანება
chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "contours-request" || message.tabId !== myTabId) return;
  handleRequest(message.codes || [], message.then || "none");
});

async function start() {
  try { myTabId = (await chrome.tabs.getCurrent()).id; } catch (error) { /* ტაბში არ ვართ */ }
  await mergeEntriesFromStorage();
  render();

  // გვერდი ახლახან გაიხსნა ბრძანებით: contours.html?add=<კოდი,კოდი>&then=map|kml
  const pageParameters = new URLSearchParams(location.search);
  const codes = (pageParameters.get("add") || "").split(",").map((code) => code.trim()).filter(Boolean);
  const actionWhenReady = ["map", "kml"].includes(pageParameters.get("then")) ? pageParameters.get("then") : "none";
  // პარამეტრებს მისამართიდან ვშლით, რომ გვერდის გადატვირთვამ (F5) ბრძანება მეორედ არ შეასრულოს
  history.replaceState(null, "", location.pathname);

  await handleRequest(codes, actionWhenReady); // ასევე ამთავრებს წინა ჯერზე შეწყვეტილ ("working") ჩანაწერებს
}

start();
