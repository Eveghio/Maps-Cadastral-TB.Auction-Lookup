// viewer.html?code=<საკადასტრო კოდი>&kind=plan|extract&n=<N>
// საკადასტრო გეგმები / ამონაწერები ქრონოლოგიურად (1 = ბოლო), PDF ჩაშენებულად, N-ე არჩევით.
import { ABSTRACT_PAGE, TYPE_EXTRACT, TYPE_MAP, readList, fetchBytes, describeDoc, groupDocs } from "./napr_docs.js";
import { contourFromPlanGroup } from "./plan_contour.js";
import { buildKml, formatMeters, formatSquareMeters, kmlFileName } from "./contours_core.js";

const params = new URLSearchParams(location.search);
const code = (params.get("code") || "").trim();
let kind = params.get("kind") === "extract" ? "extract" : "plan";
const PARALLEL = 4;

const $ = (id) => document.getElementById(id);
const KIND_NAME = { plan: "საკადასტრო გეგმა", extract: "ამონაწერი" };
const OTHER_NAME = { "situational-drawing": "სიტუაციური ნახაზი", "measurement-drawing": "აზომვითი ნახაზი", unknown: "ტიპი ვერ დადგინდა",
  "encrypted-unsupported": "დაშიფრულია (AES), ვერ წავიკითხე", error: "ვერ ჩამოიტვირთა", "cadastral-plan": "საკადასტრო გეგმა", extract: "ამონაწერი" };

const S = {
  plan: { rows: [], docs: new Map(), started: false, groups: [], sel: null, wantN: kind === "plan" ? +params.get("n") || 1 : 1, reported: false },
  extract: { rows: [], docs: new Map(), started: false, groups: [], sel: null, wantN: kind === "extract" ? +params.get("n") || 1 : 1, reported: false }
};
let listError = "", listLoaded = false, blobUrl = "", shownRow = null;

const p2 = (n) => String(n).padStart(2, "0");
const dateText = (d) => d ? `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()}` : "?";
const timeText = (d) => d ? `${dateText(d)} ${p2(d.getHours())}:${p2(d.getMinutes())}` : "?";
const isoDay = (d) => d ? `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` : "";

// ---------- დაჯგუფება: დანომრილი (გეგმები / ამონაწერები) და "სხვა" ----------
function lists(k) {
  const st = S[k];
  if (k === "plan") return { numbered: st.groups.filter((g) => g.kind === "cadastral-plan"), other: st.groups.filter((g) => g.kind !== "cadastral-plan") };
  return { numbered: st.groups.filter((g) => g.kind !== "error"), other: st.groups.filter((g) => g.kind === "error") };
}
const doneCount = (k) => S[k].rows.filter((r) => S[k].docs.has(r.row)).length;
const prefixCount = (k) => { let i = 0; const st = S[k]; while (i < st.rows.length && st.docs.has(st.rows[i].row)) i++; return i; };
const allDone = (k) => listLoaded && doneCount(k) === S[k].rows.length;

// N-ე საიმედოდ რომ შეირჩეს, სიის თავიდან რამდენი სტრიქონი უნდა იყოს წაკითხული.
// სია განცხადების შეტანის რიგითაა; მომზადების დროით შეიძლება რამდენიმე განცხადებით "გადაასწროს".
function readyFor(k, n) {
  const st = S[k];
  if (allDone(k)) return true;
  const pre = prefixCount(k);
  if (k === "extract") return pre >= Math.max(8, 2 * n + 4);
  const preRows = new Set(st.rows.slice(0, pre).map((r) => r.row));
  const preGroups = groupDocs([...st.docs.values()].filter((d) => preRows.has(d.row.row))).filter((g) => g.kind === "cadastral-plan");
  if (preGroups.length < n) return false;
  const last = Math.max(...preGroups.slice(0, n).flatMap((g) => g.rows));
  const idx = st.rows.findIndex((r) => r.row === last);
  return pre >= idx + 1 + 2; // იმავე განცხადების დანარჩენი ასლი + მარაგი
}

// ---------- ჩამოტვირთვა ----------
async function loadList() {
  try {
    const rows = await readList(code);
    S.plan.rows = rows.filter((r) => r.type === TYPE_MAP);
    S.extract.rows = rows.filter((r) => r.type === TYPE_EXTRACT);
  } catch (e) {
    listError = e.message || String(e);
  }
  listLoaded = true;
}

function startKind(k) {
  const st = S[k];
  if (st.started || !listLoaded || listError) return;
  st.started = true;
  let next = 0;
  const worker = async () => {
    while (next < st.rows.length) {
      const row = st.rows[next++];
      const d = { row };
      try { d.bytes = await fetchBytes(row.url); d.info = await describeDoc(d.bytes, row); }
      catch (e) { d.info = { kind: "error", error: e.message || String(e), readable: false }; }
      st.docs.set(row.row, d);
      st.groups = groupDocs([...st.docs.values()]);
      update(k);
    }
  };
  for (let i = 0; i < PARALLEL; i++) worker();
  update(k);
}

// ---------- არჩევა და ნავიგაცია ----------
function selectGroup(k, g) {
  S[k].sel = g ? g.best.row : null;
  S[k].wantN = null;
  if (k === kind) render();
}
function selectedIndex(k) {
  const { numbered } = lists(k), sel = S[k].sel;
  return sel === null ? -1 : numbered.findIndex((g) => g.rows.includes(sel));
}
function goN(k, n) { // N (1 = ბოლო); თუ ჯერ არ ჩატვირთულა - ველოდებით
  S[k].wantN = Math.max(1, n);
  update(k);
}
function step(delta) {
  const { numbered } = lists(kind);
  const i = selectedIndex(kind);
  const target = (i < 0 ? 0 : i + delta) + 1;
  if (target < 1) return flash("ეს უახლესია");
  if (target > numbered.length && allDone(kind)) return flash(numbered.length ? "ეს უძველესია" : "");
  goN(kind, target);
}
let flashTimer = null;
function flash(text) {
  if (!text) return;
  const el = $("status"), old = el.dataset.base || "";
  el.textContent = text; el.className = "";
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.textContent = old; }, 1600);
}

function update(k) {
  const st = S[k];
  if (st.wantN !== null && listLoaded && !listError) {
    const { numbered } = lists(k);
    if (readyFor(k, st.wantN)) {
      const g = numbered[st.wantN - 1] || null;
      if (g) selectGroup(k, g);
      else if (allDone(k)) { // ნაკლებია, ვიდრე ითხოვეს
        const n = st.wantN; st.wantN = null;
        if (numbered.length && st.sel === null) selectGroup(k, numbered[numbered.length - 1]);
        if (k === kind) flash(numbered.length ? `${n}-ე არ არის: სულ ${numbered.length}` : "");
      }
      report(k);
    }
  }
  if (k === kind) render();
}

// ისტორია: ერთხელ თითო ტიპზე, როცა პირველი შედეგი გამოჩნდა (ან გაირკვა, რომ არ არის)
function report(k) {
  const st = S[k];
  if (st.reported) return;
  const { numbered } = lists(k);
  if (!numbered.length && !allDone(k)) return;
  st.reported = true;
  const status = listError ? "error" : numbered.length ? "found" : "missing";
  const error = listError || (numbered.length ? "" : (k === "plan" ? "საკადასტრო გეგმა სიაში არ არის" : "ამონაწერი სიაში არ არის"));
  const url = chrome.runtime.getURL(`viewer.html?code=${encodeURIComponent(code)}&kind=${k}`);
  chrome.runtime.sendMessage({ type: "doc-history", action: k === "plan" ? "plan" : "pdf", code, status, error, url }).catch(() => {});
}

// ---------- ხატვა ----------
function groupLine(k, g, number) {
  const el = document.createElement("div");
  el.className = "item" + (S[k].sel !== null && g.rows.includes(S[k].sel) ? " sel" : "");
  const num = document.createElement("div");
  num.className = "num" + (number ? "" : " other");
  num.textContent = number || "–";
  const body = document.createElement("div"); body.className = "body";
  const when = document.createElement("div"); when.className = "when";
  const meta = document.createElement("div"); meta.className = "meta";
  const signed = g.signedRow !== null ? "ხელმოწერილი" : "ხელმოუწერელი";
  const copies = g.rows.length > 1 ? ` · ${g.rows.length} ასლი` : "";
  if (k === "extract") {
    when.textContent = g.whenSource === "list" ? `${dateText(g.when)} (სიის თარიღი)` : timeText(g.when);
    const src = g.whenSource === "prepared" ? "მომზადდა" : g.whenSource === "created" ? "PDF შეიქმნა" : "მომზადების დრო ვერ წავიკითხე";
    meta.textContent = `${src} · განცხ. ${g.appNo || "?"} (${g.docs[0].row.listDateText || "?"}) · ${signed}${copies}`;
  } else if (number) {
    when.textContent = dateText(g.prepared || g.when);
    meta.textContent = `განცხ. ${g.appNo || "?"} (${g.docs[0].row.listDateText || "?"}) · ${signed}${copies}`;
  } else {
    when.textContent = OTHER_NAME[g.kind] || g.kind;
    const err = g.docs.map((d) => d.info && d.info.error).find(Boolean);
    meta.textContent = `${g.when ? dateText(g.when) : "?"} · განცხ. ${g.appNo || "?"}${g.stamp ? " · შტამპი: " + g.stamp.slice(0, 60) : ""}${err ? " · " + err : ""}`;
  }
  body.append(when, meta);
  el.append(num, body);
  el.onclick = () => selectGroup(k, g);
  return el;
}

function render() {
  const st = S[kind];
  for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("on", b.dataset.kind === kind);
  $("pageLink").href = ABSTRACT_PAGE + encodeURIComponent(code);
  const status = $("status");
  const list = $("list");
  list.textContent = "";
  if (!code) { status.textContent = "საკადასტრო კოდი არ არის მითითებული"; status.className = "err"; return; }
  if (!listLoaded) { status.textContent = "რეესტრის სია იტვირთება…"; status.className = ""; return; }
  if (listError) { status.textContent = "რეესტრის გვერდი ვერ წავიკითხე: " + listError; status.className = "err"; showDoc(null); return; }

  const total = st.rows.length, done = doneCount(kind);
  const { numbered, other } = lists(kind);
  let base;
  if (!total) base = kind === "plan" ? "„საკადასტრო რუკა“ სიაში არ არის" : "ამონაწერი სიაში არ არის";
  else if (done < total) base = `წაკითხულია ${done} / ${total} ფაილი…`;
  else base = kind === "plan" ? `${numbered.length} საკადასტრო გეგმა · ${other.length} სხვა ნახაზი` : `${numbered.length} ამონაწერი`;
  status.textContent = base; status.dataset.base = base; status.className = "";

  if (numbered.length) {
    const h = document.createElement("div"); h.className = "sec";
    h.textContent = kind === "plan" ? "საკადასტრო გეგმები (1 = ბოლო)" : "ამონაწერები (1 = ბოლო)";
    list.append(h);
    numbered.forEach((g, i) => list.append(groupLine(kind, g, i + 1)));
  }
  if (done < total) {
    const p = document.createElement("div"); p.className = "pending";
    p.textContent = st.wantN !== null ? `${st.wantN}-ე ${kind === "plan" ? "გეგმის" : "ამონაწერის"} შესარჩევად ჯერ კიდევ ვკითხულობ…` : "დანარჩენი იტვირთება…";
    list.append(p);
  }
  if (other.length) {
    const h = document.createElement("div"); h.className = "sec";
    h.textContent = kind === "plan" ? "„საკადასტრო რუკად“ მონიშნული, მაგრამ გეგმა არ არის" : "ვერ ჩამოიტვირთა";
    list.append(h);
    other.forEach((g) => list.append(groupLine(kind, g, 0)));
  }
  if (!numbered.length && done === total && total && kind === "plan") {
    const p = document.createElement("div"); p.className = "pending";
    p.textContent = "ნამდვილი საკადასტრო გეგმა ვერ ვიპოვე. ქვემოთ ჩამოთვლილი ნახაზები შეგიძლია ხელით ნახო.";
    list.prepend(p);
  }

  const sel = st.sel === null ? null : st.groups.find((g) => g.rows.includes(st.sel)) || null;
  const idx = selectedIndex(kind);
  $("newer").disabled = !(idx > 0);
  $("older").disabled = !(idx >= 0 ? idx + 1 < numbered.length || !allDone(kind) : numbered.length);
  showDoc(sel, idx >= 0 ? idx + 1 : 0, numbered.length);
}

function showDoc(g, number = 0, count = 0) {
  const bar = $("docbar"), frame = $("pdf"), empty = $("empty");
  const doc = g ? S[kind].docs.get(g.best.row) : null;
  $("openTab").disabled = $("download").disabled = !doc || !doc.bytes;
  updateContourButtons(doc);
  if (!doc || !doc.bytes) {
    frame.hidden = true; empty.hidden = false;
    empty.textContent = listError ? "" : !listLoaded || doneCount(kind) < S[kind].rows.length ? "იტვირთება…" : "აირჩიე დოკუმენტი სიიდან";
    bar.textContent = "";
    document.title = `${code} · ${KIND_NAME[kind]}`;
    shownRow = null;
    return;
  }
  const head = number ? `${KIND_NAME[kind]} ${number} / ${count}` : (OTHER_NAME[g.kind] || g.kind);
  const when = kind === "extract" ? `მომზადდა ${timeText(g.when)}` : `თარიღი ${dateText(g.prepared || g.when)}`;
  bar.innerHTML = "";
  const b = document.createElement("b"); b.textContent = head;
  bar.append(b, ` · ${when} · განცხადება ${g.appNo || "?"} (შეტანილია ${g.docs[0].row.listDateText || "?"}) · ${g.signedRow !== null ? "ხელმოწერილი ასლი" : "ხელმოუწერელი ასლი"}`);
  document.title = `${code} · ${head}`;
  if (shownRow === doc.row.row) return; // იგივე ფაილი უკვე ჩანს
  shownRow = doc.row.row;
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = URL.createObjectURL(new Blob([doc.bytes], { type: "application/pdf" }));
  frame.src = blobUrl;
  frame.hidden = false; empty.hidden = true;
}

function currentDoc() {
  const st = S[kind];
  const g = st.sel === null ? null : st.groups.find((x) => x.rows.includes(st.sel));
  return g ? { g, doc: st.docs.get(g.best.row) } : null;
}

// ---------- მართვა ----------
for (const b of document.querySelectorAll(".tabs button")) b.onclick = () => switchKind(b.dataset.kind);
function switchKind(k) {
  if (k === kind) return;
  kind = k;
  shownRow = null;
  startKind(k);
  update(k);
}
$("older").onclick = () => step(+1);
$("newer").onclick = () => step(-1);
$("openTab").onclick = () => { const c = currentDoc(); if (c && c.doc) chrome.tabs.create({ url: c.doc.row.url }); };
$("download").onclick = () => {
  const c = currentDoc(); if (!c || !c.doc || !c.doc.bytes) return;
  const d = c.g.prepared || c.g.when;
  const name = `${code.replace(/[\\/:*?"<>|]/g, "_")}_${kind === "plan" ? "gegma" : "amonaweri"}_${isoDay(d) || "date"}.pdf`;
  const url = URL.createObjectURL(new Blob([c.doc.bytes], { type: "application/pdf" }));
  chrome.downloads.download({ url, filename: name, saveAs: false }, () => setTimeout(() => URL.revokeObjectURL(url), 30000));
};
document.addEventListener("keydown", (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (/^[1-9]$/.test(e.key)) { goN(kind, +e.key); e.preventDefault(); }
  else if (e.key === "ArrowDown" || e.key === "PageDown" || e.key === "ArrowRight") { step(+1); e.preventDefault(); }
  else if (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "ArrowLeft") { step(-1); e.preventDefault(); }
});
(async () => {
  $("code").textContent = code || "?";
  render();
  if (!code) return;
  await loadList();
  startKind(kind);
  update(kind);
  if (listError) { report(kind); return; }
})();

// =====================================================================
// ნაჩვენები გეგმის კონტური: "კონტური → KML" და "კონტური რუკაზე"
// (გეგმის PDF -> კონტური: plan_contour.js / plan_converter.js)
// =====================================================================

// ერთი გეგმა ორჯერ რომ არ გარდაიქმნას: გასაღები = გეგმის ფაილის ნომერი სიაში, მნიშვნელობა = კონტური ან Error
const convertedContours = new Map();
let contourInfoIsForRow = null; // რომელი გეგმის შედეგი წერია ამჟამად #contourInfo-ში

// ღილაკები ჩანს მხოლოდ "საკადასტრო გეგმა" ჩანართზე, როცა რომელიმე ფაილი არჩეულია
function updateContourButtons(shownDocument) {
  const canConvert = kind === "plan" && !!shownDocument && !!shownDocument.bytes;
  $("contourKml").hidden = $("contourMap").hidden = !canConvert;
  // სხვა ფაილზე გადასვლისას წინა გეგმის შედეგი აღარ უნდა ჩანდეს
  const shownRow = canConvert ? shownDocument.row.row : null;
  if (shownRow !== contourInfoIsForRow) $("contourInfo").hidden = true;
}

function showContourInfo(planRow, lines, isProblem = false) {
  const info = $("contourInfo");
  info.textContent = "";
  for (const text of lines) {
    const line = document.createElement("div");
    line.textContent = text;
    info.append(line);
  }
  info.className = isProblem ? "problem" : "";
  info.hidden = false;
  contourInfoIsForRow = planRow;
}

// ამჟამად ნაჩვენები გეგმის კონტური (ან null, თუ ვერ გარდაიქმნა; მიზეზი #contourInfo-ში იწერება)
async function contourOfShownPlan() {
  const shown = currentDoc();
  if (!shown || !shown.doc || !shown.doc.bytes) return null;
  const planGroup = shown.g, planRow = planGroup.best.row;

  if (!convertedContours.has(planRow)) {
    showContourInfo(planRow, ["კონტურს ვითვლი გეგმის PDF-იდან…"]);
    try {
      convertedContours.set(planRow, await contourFromPlanGroup(code, planGroup, selectedIndex("plan") + 1 || null));
    } catch (error) {
      convertedContours.set(planRow, error);
    }
  }
  const result = convertedContours.get(planRow);
  if (result instanceof Error) {
    showContourInfo(planRow, [`ამ ფაილიდან კონტური ვერ გამოვთვალე: ${result.message}`], true);
    return null;
  }

  const lines = [];
  if (result.areaInPdf != null) {
    lines.push(`კონტური მზად არის. ფართობი გეგმაში ${result.areaInPdf} კვ.მ, კონტურიდან ${formatSquareMeters(result.areaCalculated)} კვ.მ (სხვაობა ${result.areaDifferencePercent.toFixed(2)}%).`);
  } else {
    lines.push("კონტური მზად არის.");
  }
  lines.push(`სავარაუდო ცდომილება: ჩვეულებრივ ±${formatMeters(result.accuracyMeters.typical)} მ, მაქს. ±${formatMeters(result.accuracyMeters.max)} მ${result.isRaster ? " (საზღვარი სურათიდან არის ამოღებული)" : ""}.`);
  lines.push(...result.warnings);
  lines.push(...(result.notes || []));
  showContourInfo(planRow, lines, result.areaIsSuspicious || !result.insideGeorgia);
  return result;
}

$("contourKml").onclick = async () => {
  const contour = await contourOfShownPlan();
  if (!contour) return;
  const blobAddress = URL.createObjectURL(new Blob([buildKml(contour)], { type: "application/vnd.google-earth.kml+xml" }));
  chrome.downloads.download({ url: blobAddress, filename: kmlFileName(contour), saveAs: false },
    () => setTimeout(() => URL.revokeObjectURL(blobAddress), 30000));
};

// ნაჩვენები გეგმის კონტური ემატება კონტურების სიას (contours.html) და მთელი სია იხსნება რუკაზე.
// ასე ერთ რუკაზე გროვდება სხვადასხვა კოდის და სხვადასხვა დროის გეგმების კონტურები.
const COLLECTION_STORAGE_KEY = "contourCollection"; // იგივე გასაღები, რაც contours.js-ში

$("contourMap").onclick = async () => {
  const contour = await contourOfShownPlan();
  if (!contour) return;
  const planNumber = selectedIndex("plan") + 1; // 0, თუ ნაჩვენები ფაილი დანომრილი გეგმა არ არის (სხვა ნახაზი)
  contour.planNumber = planNumber || null;

  const stored = (await chrome.storage.session.get(COLLECTION_STORAGE_KEY))[COLLECTION_STORAGE_KEY] || [];
  const alreadyInList = stored.some((entry) => entry.state === "ready" && entry.contour
    && entry.cadastralCode === code && entry.contour.source === contour.source && entry.contour.planDateMs === contour.planDateMs);
  if (!alreadyInList) {
    stored.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      cadastralCode: code, wantedSource: "plan", planNumber: planNumber || 1,
      state: "ready", contour, problemText: "", mapProblems: [], plans: null, progressText: ""
    });
    await chrome.storage.session.set({ [COLLECTION_STORAGE_KEY]: stored });
  }
  // background.js ხსნის (ან წინ მოაქვს) კონტურების სიის გვერდს და სთხოვს მთელი სიის რუკაზე ჩვენებას
  chrome.runtime.sendMessage({ type: "contours-show", then: "map" }).catch(() => {});
};
