// plan_test.js - საკადასტრო გეგმების მასობრივი შემოწმება (plan_test.html).
//
// თითო კოდზე:
//   1. რეესტრიდან გეგმები (napr_docs.js → findDocuments), ბოლო 1 / 3 / ყველა;
//   2. გეგმა → კონტური (plan_contour.js → contourFromPlanGroup, იგივე ბირთვი, რაც ვებ-ხელსაწყოში);
//   3. ოფიციალური კონტური maps.gov.ge / ms.gov.ge-დან (background.js → "find-contour-on-maps");
//   4. შედარება (plan_compare.js): IoU, უდიდესი გადახრა, ფართობები;
//   5. კატეგორია (RESULT_CATEGORIES) და სტრიქონი ცხრილში.
// ბოლოს: CSV და „ZIP Claude-ისთვის“ (შედეგი + PDF-ები + ოფიციალური და გამოთვლილი კონტურები GeoJSON-ად),
// რომლითაც გარდაქმნის ალგორითმი (cadastre-pdf-to-kml → tool/batch_test.mjs) უმჯობესდება.

import { findDocuments } from "./napr_docs.js";
import { contourFromPlanGroup } from "./plan_contour.js";
import { makeZip } from "./plan_converter.js";
import { compareContours, polygonsAreaSquareMeters } from "./plan_compare.js";

// IoU, რომლის ქვემოთაც გეგმის კონტური ოფიციალურს "არ ემთხვევა"
const MIN_GOOD_IOU = 0.97;
// მეხსიერება: ათასობით კოდზე ყველა PDF-ს ვერ შევინახავთ. პრობლემურები ყველა, კარგები - მაქსიმუმ ამდენი
const MAX_GOOD_PDFS_IN_ZIP = 300;
// საკადასტრო კოდი ტექსტში (იგივე, რაც ექსთენშენის სხვა ნაწილებში)
const CADASTRAL_CODE_PATTERN = /\d+(?:\.\d+){2,9}[ა-ჰ]?/g;

// კატეგორია -> [აღწერა, ფერი]. რიგი = ჯამის ცხრილის რიგი
const RESULT_CATEGORIES = {
  matches: ["ემთხვევა ოფიციალურ კონტურს", "good"],
  area_ok_no_official: ["ოფიციალური კონტური არ არის; ფართობი ემთხვევა", "good"],
  raster: ["რასტრული გეგმა (დაბალი სიზუსტე)", "middle"],
  old_plan_differs: ["ძველი გეგმა: საზღვარი მას შემდეგ შეიცვალა (მოსალოდნელია)", "middle"],
  differs: ["ბოლო გეგმა ოფიციალურს არ ემთხვევა", "bad"],
  area_mismatch: ["ფართობი გეგმაში დაწერილს არ ემთხვევა", "bad"],
  outside_georgia: ["კონტური საქართველოს გარეთ ხვდება", "bad"],
  grid_missing: ["საყრდენი ბადე ვერ მოიძებნა", "bad"],
  no_boundary: ["წითელი საზღვარი ვერ მოიძებნა", "bad"],
  conversion_failed: ["გარდაქმნა ვერ მოხერხდა (სხვა მიზეზი)", "bad"],
  no_plan: ["რეესტრში საკადასტრო გეგმა არ არის", "middle"],
  registry_error: ["რეესტრი არ პასუხობს / შეცდომა", "middle"]
};
const PROBLEM_CATEGORIES = new Set(["differs", "area_mismatch", "outside_georgia", "grid_missing", "no_boundary", "conversion_failed", "raster"]);

const byId = (id) => document.getElementById(id);
const resultRows = [];      // ცხრილის სტრიქონები (CSV/JSON)
const pdfFiles = new Map(); // ZIP-ის სახელი -> { bytes, problem }
const officialFeatures = [], planFeatures = [];
let stopRequested = false;
let goodPdfCount = 0;

// ---------- ერთი კოდი ----------

async function findOfficialContour(cadastralCode) {
  const answer = await chrome.runtime.sendMessage({ type: "find-contour-on-maps", code: cadastralCode }).catch(() => null);
  return answer && answer.found ? answer : null;
}

function categoryOfError(message) {
  if (/საყრდენი ბადე/.test(message)) return "grid_missing";
  if (/საზღვარი|სურათია|რასტრ/.test(message)) return "no_boundary";
  return "conversion_failed";
}

async function testOneCode(cadastralCode, plansPerCode) {
  let registry;
  try {
    registry = await findDocuments(cadastralCode, "plan");
  } catch (error) {
    addRow({ cadastralCode, category: "registry_error", message: error.message || String(error) });
    return;
  }
  if (!registry.numbered.length) {
    addRow({ cadastralCode, category: "no_plan", message: registry.other.length ? `არის ${registry.other.length} სხვა ნახაზი` : "" });
    return;
  }
  const official = await findOfficialContour(cadastralCode);
  if (official) officialFeatures.push({ type: "Feature", properties: { code: cadastralCode, source: official.source }, geometry: { type: "MultiPolygon", coordinates: official.polygons } });
  const officialArea = official ? polygonsAreaSquareMeters(official.polygons) : null;

  const planGroups = plansPerCode === "all" ? registry.numbered : registry.numbered.slice(0, Number(plansPerCode));
  for (const [index, planGroup] of planGroups.entries()) {
    const planNumber = index + 1;
    const row = { cadastralCode, planNumber, applicationNumber: planGroup.appNo || "", planDate: planDateText(planGroup), officialArea, officialSource: official ? official.source : "" };
    const bestCopy = planGroup.docs.find((copy) => copy.row === planGroup.best && copy.bytes) || planGroup.docs.find((copy) => copy.bytes);
    row.pdfName = `pdf/${cadastralCode.replace(/[^\d.]/g, "_")}_${planNumber}_${row.applicationNumber || "x"}.pdf`;
    try {
      const contour = await contourFromPlanGroup(cadastralCode, planGroup, planNumber);
      Object.assign(row, {
        areaInPdf: contour.areaInPdf, areaCalculated: contour.areaCalculated, areaDifferencePercent: contour.areaDifferencePercent,
        isRaster: contour.isRaster, message: [...contour.warnings, ...contour.notes].join(" | ")
      });
      planFeatures.push({ type: "Feature", properties: { code: cadastralCode, plan: planNumber, app: row.applicationNumber }, geometry: { type: "MultiPolygon", coordinates: contour.polygons } });
      if (official) {
        const comparison = compareContours(contour.polygons, official.polygons);
        Object.assign(row, { iou: comparison.iou, hausdorffMeters: comparison.hausdorffMeters, meanDistanceMeters: comparison.meanDistanceMeters,
          shiftEastMeters: comparison.shiftEastMeters, shiftNorthMeters: comparison.shiftNorthMeters });
      }
      row.category = categoryOfResult(row, contour, planNumber);
    } catch (error) {
      row.message = error.message || String(error);
      row.category = categoryOfError(row.message);
    }
    const problem = PROBLEM_CATEGORIES.has(row.category);
    if (bestCopy && (problem || goodPdfCount < MAX_GOOD_PDFS_IN_ZIP)) {
      if (!problem) goodPdfCount++;
      pdfFiles.set(row.pdfName, { bytes: bestCopy.bytes, problem });
    }
    addRow(row);
  }
}

function categoryOfResult(row, contour, planNumber) {
  if (contour.insideGeorgia === false) return "outside_georgia";
  if (contour.isRaster) return "raster";
  if (Number.isFinite(row.iou) && row.iou < MIN_GOOD_IOU) return planNumber === 1 ? "differs" : "old_plan_differs";
  if (contour.areaIsSuspicious) return "area_mismatch";
  return Number.isFinite(row.iou) ? "matches" : "area_ok_no_official";
}

function planDateText(planGroup) {
  const date = planGroup.prepared || planGroup.when;
  return date ? date.toISOString().slice(0, 10) : "";
}

// ---------- ცხრილი ----------

const formatNumber = (value, digits) => Number.isFinite(value) ? value.toFixed(digits) : "";

function addRow(row) {
  resultRows.push(row);
  const [label, tone] = RESULT_CATEGORIES[row.category];
  const tr = document.createElement("tr");
  const cells = [
    [row.cadastralCode, "code"], [row.planNumber ? `${row.planNumber} · ${row.planDate || ""}` : "", ""], [label, tone],
    [row.areaInPdf ?? "", "number"], [formatNumber(row.areaCalculated, 2), "number"], [formatNumber(row.areaDifferencePercent, 2), "number"],
    [formatNumber(row.officialArea, 1), "number"], [formatNumber(row.iou, 4), "number"], [formatNumber(row.hausdorffMeters, 2), "number"], [row.message || "", "message"]
  ];
  for (const [text, className] of cells) {
    const td = document.createElement("td");
    td.textContent = text;
    if (className) td.className = className;
    tr.append(td);
  }
  byId("rows").append(tr);
  renderSummary();
}

function renderSummary() {
  const counts = {};
  for (const row of resultRows) counts[row.category] = (counts[row.category] || 0) + 1;
  const withIou = resultRows.filter((row) => Number.isFinite(row.iou) && row.planNumber === 1).map((row) => row.iou).sort((a, b) => a - b);
  const table = document.createElement("table");
  for (const [key, [label, tone]] of Object.entries(RESULT_CATEGORIES)) {
    if (!counts[key]) continue;
    const tr = table.insertRow();
    tr.insertCell().textContent = label; tr.cells[0].className = tone;
    tr.insertCell().textContent = counts[key]; tr.cells[1].className = "number";
    tr.insertCell().textContent = `${(100 * counts[key] / resultRows.length).toFixed(1)}%`; tr.cells[2].className = "number";
  }
  const summary = byId("summary");
  summary.replaceChildren(table);
  if (withIou.length) {
    const line = document.createElement("div");
    line.textContent = `ბოლო გეგმა vs ოფიციალური (${withIou.length}): IoU მედიანა ${withIou[Math.floor(withIou.length / 2)].toFixed(4)}, მინიმუმი ${withIou[0].toFixed(4)}`;
    summary.append(line);
  }
}

// ---------- ჩამოტვირთვები ----------

const CSV_COLUMNS = ["cadastralCode", "planNumber", "planDate", "applicationNumber", "category", "areaInPdf", "areaCalculated", "areaDifferencePercent",
  "officialArea", "officialSource", "iou", "hausdorffMeters", "meanDistanceMeters", "shiftEastMeters", "shiftNorthMeters", "isRaster", "pdfName", "message"];

function csvText() {
  const cell = (value) => {
    const text = value === undefined || value === null ? "" : typeof value === "number" ? String(+value.toFixed(6)) : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return "﻿" + CSV_COLUMNS.join(",") + "\n" + resultRows.map((row) => CSV_COLUMNS.map((column) => cell(row[column])).join(",")).join("\n") + "\n";
}

function saveFile(bytesOrText, fileName, type) {
  const url = URL.createObjectURL(new Blob([bytesOrText], { type }));
  const link = document.createElement("a");
  link.href = url; link.download = fileName; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");

function downloadZip() {
  const encoder = new TextEncoder();
  const onlyProblems = byId("onlyProblemPdfs").checked;
  const files = [
    { name: "results.csv", data: encoder.encode(csvText()) },
    { name: "results.json", data: encoder.encode(JSON.stringify(resultRows, null, 1)) },
    { name: "official.geojson", data: encoder.encode(JSON.stringify({ type: "FeatureCollection", features: officialFeatures })) },
    { name: "plans.geojson", data: encoder.encode(JSON.stringify({ type: "FeatureCollection", features: planFeatures })) }
  ];
  for (const [name, file] of pdfFiles) if (!onlyProblems || file.problem) files.push({ name, data: file.bytes });
  saveFile(makeZip(files), `plan_test_${stamp()}.zip`, "application/zip");
}

// ---------- გაშვება ----------

async function runAll() {
  const codes = [...new Set((byId("codesInput").value.match(CADASTRAL_CODE_PATTERN) || []))];
  if (!codes.length) { byId("progress").textContent = "კოდი ვერ ვიპოვე ტექსტში."; return; }
  const plansPerCode = byId("plansPerCode").value;
  const parallel = Math.min(6, Math.max(1, Number(byId("parallel").value) || 2));
  stopRequested = false;
  byId("start").disabled = true; byId("stop").disabled = false;
  const startedAt = Date.now();
  let nextIndex = 0, finished = 0;
  const showProgress = () => {
    const seconds = (Date.now() - startedAt) / 1000;
    const left = finished ? seconds / finished * (codes.length - finished) : 0;
    byId("progress").textContent = `${finished} / ${codes.length} კოდი` + (finished && finished < codes.length ? `, დარჩა ≈ ${Math.ceil(left / 60)} წთ` : "") + (stopRequested ? " (ჩერდება…)" : "");
  };
  const worker = async () => {
    while (nextIndex < codes.length && !stopRequested) {
      const code = codes[nextIndex++];
      try { await testOneCode(code, plansPerCode); }
      catch (error) { addRow({ cadastralCode: code, category: "conversion_failed", message: error.message || String(error) }); }
      finished++;
      showProgress();
      byId("downloadZip").disabled = byId("downloadCsv").disabled = false;
    }
  };
  showProgress();
  await Promise.all(Array.from({ length: parallel }, worker));
  byId("start").disabled = false; byId("stop").disabled = true;
  byId("progress").textContent = `დასრულდა: ${finished} / ${codes.length} კოდი, ${Math.round((Date.now() - startedAt) / 1000)} წმ.` + (stopRequested ? " შეჩერდა." : "");
}

byId("start").addEventListener("click", runAll);
byId("stop").addEventListener("click", () => { stopRequested = true; byId("stop").disabled = true; });
byId("downloadZip").addEventListener("click", downloadZip);
byId("downloadCsv").addEventListener("click", () => saveFile(csvText(), `plan_test_${stamp()}.csv`, "text/csv"));
window.addEventListener("beforeunload", (event) => { if (byId("stop").disabled === false) event.preventDefault(); });

// კოდები ბმულიდან (#codes=...) - მაგ. კონტურების სიიდან გადმოსვლისას
const codesFromLink = decodeURIComponent(location.hash.replace(/^#codes=/, ""));
if (codesFromLink && location.hash.startsWith("#codes=")) byId("codesInput").value = codesFromLink.split(",").join("\n");
