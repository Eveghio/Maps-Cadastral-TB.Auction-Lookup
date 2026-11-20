// გეგმების მასობრივი შემოწმების (plan_test.html) ტესტი, საიტების იმიტაციით.
// გამოყენება: node tests/test_plan_test.js src <ფიქსტურების საქაღალდე> <out>
//   ფიქსტურები: <კოდი>.pdf (გეგმა) და არასავალდებულო <კოდი>.wkt (ოფიციალური კონტური, EPSG:4326).
//   კოდი, რომელსაც PDF არ აქვს, მაგრამ codes.txt-შია, = "რეესტრში გეგმა არ არის".
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const EXT = path.resolve(process.argv[2]), FX = path.resolve(process.argv[3]), OUT = path.resolve(process.argv[4]);
const TYPE_MAP = "საკადასტრო რუკა";
const codes = fs.readFileSync(path.join(FX, "codes.txt"), "utf8").split(/\s+/).filter(Boolean);
const hasPlan = (code) => fs.existsSync(path.join(FX, code + ".pdf"));
const listHtml = (code) => `<html><body><table>${hasPlan(code) ? `<tr onclick="openWindow('https://bs.napr.gov.ge/GetBlob?pid=101&amp;bid=${code}.pdf');" id="0"><td>&nbsp;რეგისტრაციის ნომერი:&nbsp;882000000001</td><td>01/01/2024</td><td>882000000001</td><td>${TYPE_MAP}</td></tr>` : ""}</table></body></html>`;
(async () => {
  fs.rmSync(path.join(OUT, "profile"), { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(path.join(OUT, "profile"), { headless: false, acceptDownloads: true,
    args: ["--headless=new", `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  await ctx.route("https://abstract.reestri.gov.ge/**", (r) => r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: listHtml(new URL(r.request().url()).searchParams.get("cad_code")) }));
  await ctx.route("https://bs.napr.gov.ge/**", (r) => r.fulfill({ status: 200, contentType: "application/pdf", body: fs.readFileSync(path.join(FX, new URL(r.request().url()).searchParams.get("bid"))) }));
  await ctx.route("https://maps.gov.ge/**", (r) => {
    const req = r.request(), url = req.url();
    if (url.includes("/map/portal/search")) {
      const code = new URLSearchParams(req.postData() || "").get("keyword");
      const wkt = path.join(FX, code + ".wkt");
      const result = fs.existsSync(wkt) ? [{ name: code, descript: "", details: { info_link: "/x?lbl=lr_parcels:" + code, geometry_link: "/lr/bo/mg/getinfo.alpha?lbl=lr_parcels:" + code + "&res=shp" } }] : [];
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: true, result }) });
    }
    const code = decodeURIComponent(url).match(/lr_parcels:([\d.]+)/)[1];
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [{ name: code, shape: fs.readFileSync(path.join(FX, code + ".wkt"), "utf8"), shape_format: "WKT", proj: "EPSG:4326" }] }) });
  });
  await ctx.route("https://ms.gov.ge/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ naprSearchResult: { cadCode: null, wktShape: null } }) }));
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const id = new URL(sw.url()).host;
  const errors = [];
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e))); page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`chrome-extension://${id}/plan_test.html#codes=${encodeURIComponent(codes.join(","))}`);
  console.log("1) codes from link:", JSON.stringify(await page.inputValue("#codesInput")));
  await page.click("#start");
  await page.waitForFunction(() => /დასრულდა/.test(document.getElementById("progress").textContent), null, { timeout: 120000 });
  console.log("2) progress:", await page.innerText("#progress"));
  const rows = await page.locator("#rows tr").evaluateAll((trs) => trs.map((tr) => [...tr.cells].map((c) => c.innerText).slice(0, 9).join(" | ")));
  for (const row of rows) console.log("   ", row);
  console.log("3) summary:", (await page.innerText("#summary")).replace(/\n/g, " ; "));
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#downloadZip")]);
  const zipPath = path.join(OUT, "plan_test.zip"); await download.saveAs(zipPath);
  console.log("4) zip:", download.suggestedFilename(), execFileSync("unzip", ["-l", zipPath]).toString().split("\n").filter((l) => /\.(csv|json|geojson|pdf)$/.test(l)).map((l) => l.trim().split(/\s+/).pop()).join(", "));
  console.log("   testzip:", execFileSync("unzip", ["-tq", zipPath]).toString().trim());
  console.log("ERRORS:", errors.length ? errors : "none");
  await ctx.close();
})();
