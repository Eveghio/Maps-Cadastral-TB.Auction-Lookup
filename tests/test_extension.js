// გამოყენება: node tests/test_extension.js src tests/fixtures tests/out [cadastre_pdf_to_kml.html]
// საიტები (რეესტრი, maps.gov.ge, ms.gov.ge, geojson.io) იმიტირებულია; ცოცხალი შემოწმება მხოლოდ მომხმარებლის ბრაუზერით.
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path"), zlib = require("zlib");
const EXT = path.resolve(process.argv[2]), FX = path.resolve(process.argv[3]), OUT = path.resolve(process.argv[4]), ORIGINAL_HTML = process.argv[5];
const TYPE_MAP = "საკადასტრო რუკა";
const C1 = "01.10.14.028.016", C2 = "01.72.14.011.200", A = "01.10.10.001.001", B = "01.10.10.001.002", D = "01.99.99.999.999", H = "01.55.55.555.555";
const registry = { [C1]: [["plan_c_2026.pdf", "882026000001", "19/07/2026"], ["plan_c_2015.pdf", "882015000009", "01/09/2015"]], [C2]: [["plan_hole_rc4.pdf", "882025000002", "01/02/2025"]] };
const listHtml = (code) => `<html><body><table>${(registry[code] || []).map(([f, reg, d], i) => `<tr onclick="openWindow('https://bs.napr.gov.ge/GetBlob?pid=101&amp;bid=${f}');" id="${i}"><td>&nbsp;რეგისტრაციის ნომერი:&nbsp;${reg}</td><td>&nbsp;${d}</td><td>&nbsp;${i}</td><td>&nbsp;${TYPE_MAP}&nbsp;</td></tr>`).join("")}</table><script>function openWindow(u){}</script></body></html>`;
const WKT_A = "POLYGON ((44.78 41.70, 44.781 41.70, 44.781 41.701, 44.78 41.701, 44.78 41.70))";
const WKT_B = "MULTIPOLYGON (((44.79 41.71, 44.791 41.71, 44.791 41.711, 44.79 41.71)), ((44.80 41.72, 44.801 41.72, 44.801 41.721, 44.80 41.72)))";
const decodeLink = (url) => JSON.parse(zlib.gunzipSync(Buffer.from(url.split("#data=gz:")[1], "base64url")).toString("utf8"));
const featuresText = (fc) => fc.features.map((f) => `${f.properties["კოდი"]}/${f.properties["წყარო"]}`).join(" ; ");
(async () => {
  // ყოველ ჯერზე სუფთა პროფილი: ძველ პროფილში Chrome service worker-ის ძველ ასლს იყენებს
  fs.rmSync(path.join(OUT, "profile"), { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(path.join(OUT, "profile"), { headless: false, viewport: { width: 1280, height: 760 },
    args: ["--headless=new", `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  await ctx.route("https://abstract.reestri.gov.ge/**", (r) => r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: listHtml(new URL(r.request().url()).searchParams.get("cad_code")) }));
  await ctx.route("https://bs.napr.gov.ge/**", (r) => r.fulfill({ status: 200, contentType: "application/pdf", body: fs.readFileSync(path.join(FX, new URL(r.request().url()).searchParams.get("bid"))) }));
  await ctx.route("https://maps.gov.ge/**", (r) => {
    const req = r.request(), url = req.url();
    if (url.includes("/map/portal/search")) {
      const code = new URLSearchParams(req.postData() || "").get("keyword");
      if (code === H) return; // never answers: the extension must give up by itself
      const result = code === A ? [{ name: A, descript: "თბილისი, სატესტო ქ. 1", details: { info_link: "/x?lbl=lr_parcels:AAA+B", geometry_link: "/lr/bo/mg/getinfo.alpha?lbl=lr_parcels:AAA+B&res=shp" } }] : [];
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: true, result }) });
    }
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [{ name: A, shape: WKT_A, shape_format: "WKT", proj: "EPSG:4326" }] }) });
  });
  await ctx.route("https://ms.gov.ge/**", (r) => {
    if (r.request().method() === "GET") return r.fulfill({ status: 200, contentType: "text/html", body: "<html><body>ms.gov.ge mock</body></html>" });
    const code = JSON.parse(r.request().postData() || "{}").searchText;
    // განცხადება AR777: ორი კონტური საკადასტრო კოდის გარეშე
    if (code === "AR777") return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ architectureResult: [
      { appId: "AR777", type: "სატესტო თემა", geometry: WKT_B, appUrl: "", objectid: 1 },
      { appId: "AR777", type: "სატესტო თემა", geometry: WKT_A, appUrl: "", objectid: 2 }] }) });
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ naprSearchResult: code === B || code === H ? { cadCode: code, wktShape: WKT_B } : { cadCode: null, wktShape: null } }) });
  });
  // (ეს route ზოგად ms.gov.ge-ს route-ზე გვიან რეგისტრირდება, რომ მას გადაფაროს)
  const orthoTileRequests = []; // DEMO2: რა თავსართებით მივიდა ორთოფოტოს ფილის მოთხოვნა
  await ctx.route("https://ms.gov.ge/gis-api/v1/tileserver/**", (r) => {
    const h = r.request().headers();
    orthoTileRequests.push(`referer=${h.referer || "-"} origin=${h.origin || "-"}`);
    r.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64") });
  });
  // geojson.io-ს იმიტაცია: ღილაკი "Label:", რომელიც (დაგვიანებით) ხსნის ფანჯარას <select>-ით, როგორც ნამდვილ საიტზე
  const GEOJSON_IO_MOCK = `<html><title>geojson.io mock</title><body><button id="lb">Label: </button><div id="pop"></div><script>
    let label = "", open = false;
    const lb = document.getElementById("lb"), pop = document.getElementById("pop");
    const draw = () => { lb.textContent = "Label: " + label; pop.innerHTML = open ? '<select id="sel"><option value=""></option><option value="კოდი">კოდი</option><option value="წყარო">წყარო</option></select>' : "";
      if (open) { const sel = document.getElementById("sel"); sel.value = label; sel.addEventListener("change", (e) => { label = e.target.value; draw(); }); } };
    lb.addEventListener("click", () => { open = !open; setTimeout(draw, 150); });
  </script></body></html>`;
  await ctx.route("https://geojson.io/**", (r) => r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: GEOJSON_IO_MOCK }));
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const id = new URL(sw.url()).host;
  const errs = [];
  const watch = (p) => { p.on("pageerror", (e) => errs.push(String(e))); p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); }); return p; };
  const settled = (p) => p.waitForFunction(() => document.querySelectorAll("#rows tr").length > 0 && !/მუშავდება/.test(document.getElementById("summary").textContent) && !document.querySelector("#rows td.working"), null, { timeout: 60000 });
  const table = async (p) => (await p.locator("#rows tr").evaluateAll((rows) => rows.map((r) => [...r.querySelectorAll("td")].slice(0, 3).map((c) => c.innerText.replace("⠿", "").replace(/\s*\n\s*/g, " / ")).join(" | "))));
  const geoPage = () => ctx.pages().find((p) => p.url().startsWith("https://geojson.io/"));

  const cmds = await sw.evaluate(async () => (await chrome.commands.getAll()).map((c) => `${c.name}${c.shortcut ? "=" + c.shortcut : ""}`));
  console.log("COMMANDS (" + cmds.length + "):", cmds.join(", "));

  // 1) list page opened by a command with five codes
  const hub = watch(await ctx.newPage());
  await hub.goto(`chrome-extension://${id}/contours.html?add=${[A, B, C1, D].join(",")}&then=none`);
  await settled(hub);
  console.log("1) url after start:", hub.url().split("/").pop(), "|", await hub.locator("#summary").innerText());
  for (const row of await table(hub)) console.log("   ", row);

  // 2) a second command while the list is open: adds C2, A is not added twice, whole list goes to the map
  const r2 = await sw.evaluate(async (t) => runAction("contours-map", t), `${A} ${C2}`);
  await ctx.waitForEvent("page", { timeout: 20000 }).catch(() => {});
  await hub.waitForTimeout(1500);
  console.log("2) run:", JSON.stringify(r2), "| rows:", (await table(hub)).length, "| map opened:", !!geoPage(), "| message:", await hub.locator("#message").innerText());
  // D is missing but was not part of this request -> the map still opens with every ready contour
  if (geoPage()) console.log("   map features:", featuresText(decodeLink(geoPage().url())));

  // 3) change the source of C1 to an older plan
  const rowC1 = hub.locator("#rows tr", { hasText: C1 }).first();
  console.log("3) C1 options:", (await rowC1.locator("select option").allInnerTexts()).join(" | "));
  await rowC1.locator("select").selectOption("plan:2");
  await settled(hub);
  console.log("   C1 after plan 2:", (await table(hub)).find((t) => t.startsWith(C1)));
  // duplicate A (second row from plan -> A has no plan) and remove it again; remove D
  await hub.locator("#rows tr", { hasText: D }).locator("button", { hasText: "✕" }).click();
  await hub.locator("#rows tr", { hasText: C1 }).first().locator("button", { hasText: "⧉" }).click();
  await settled(hub);
  for (const row of await table(hub)) console.log("   ", row);

  // 4) viewer: plan 1 of C1 is already... the list has C1 plan 2 and (duplicate) plan 1; add C2's plan from the viewer -> not duplicated? C2 is from auto(plan) -> same date -> not added twice
  const viewer = watch(await ctx.newPage());
  await viewer.goto(`chrome-extension://${id}/viewer.html?code=${C1}&kind=plan&n=1`);
  await viewer.waitForFunction(() => /საკადასტრო გეგმა 1 \//.test(document.getElementById("docbar").textContent), null, { timeout: 15000 });
  // 4a) 1–9 კლავიშები გვერდზე დაკლიკების გარეშე უნდა მუშაობდეს (ფოკუსი PDF-ში არ რჩება)
  await viewer.waitForTimeout(800);
  const focusedAfterLoad = await viewer.evaluate(() => document.activeElement && document.activeElement.tagName);
  await viewer.keyboard.press("2");
  const keyTwoWorked = await viewer.waitForFunction(() => /საკადასტრო გეგმა 2 \//.test(document.getElementById("docbar").textContent), null, { timeout: 5000 }).then(() => true, () => false);
  await viewer.keyboard.press("1");
  await viewer.waitForFunction(() => /საკადასტრო გეგმა 1 \//.test(document.getElementById("docbar").textContent), null, { timeout: 5000 });
  console.log("4a) viewer focus after load:", focusedAfterLoad, "| key 2 without click:", keyTwoWorked);
  const codesInDocument = await viewer.evaluate(() => { const box = document.getElementById("docCodes"); return box.hidden ? "(დამალულია)" : box.innerText; });
  const codesFromText = await viewer.evaluate(async () => (await import("./napr_docs.js")).cadastralCodesInText("ნაკვეთის წინა ნომერი: 01.14.10.002.059; 01.14.10.002.083; 72.16.01.001 თარიღი 17.11.2026").join(","));
  console.log("4a) codes in document:", codesInDocument, "| from text:", codesFromText);
  const before = (await table(hub)).length;
  await viewer.click("#contourMap");
  await hub.waitForTimeout(2500);
  console.log("4) viewer add (same plan already in list): rows", before, "->", (await table(hub)).length, "| geojson tabs:", ctx.pages().filter((p) => p.url().startsWith("https://geojson.io/")).length);
  await hub.locator("#rows tr", { hasText: C1 }).nth(1).locator("button", { hasText: "✕" }).click();
  await viewer.click("#contourMap");
  await hub.waitForTimeout(2500);
  console.log("   after removing it and adding from viewer: rows", (await table(hub)).length, "| map features:", featuresText(decodeLink(geoPage().url())));
  // 4b) შორთქათი ღია ამონაწერის/გეგმის გვერდზე: ახალი კოდი იმავე ტაბში იხსნება (ახალი ტაბი არ ემატება)
  const pagesBeforeReplace = ctx.pages().length;
  await viewer.bringToFront();
  const replaceResult = await sw.evaluate(async ([code]) => {
    const [viewerTab] = await chrome.tabs.query({ url: chrome.runtime.getURL("viewer.html") + "*" });
    const sameCode = await openDocViewer(new URL(viewerTab.url).searchParams.get("code"), "plan", viewerTab); // იგივე: არაფერი იცვლება
    await openDocViewer(code, "extract", viewerTab);
    return { sameCode: sameCode.ok, tabId: viewerTab.id };
  }, [C2]);
  await viewer.waitForURL((u) => u.href.includes(encodeURIComponent(C2)) && u.href.includes("kind=extract"), { timeout: 10000 });
  console.log("4b) viewer replaced in same tab:", viewer.url().includes(C2), "| tabs", pagesBeforeReplace, "->", ctx.pages().length, "| same code no-op ok:", replaceResult.sameCode);
  await hub.screenshot({ path: path.join(OUT, "list.png"), fullPage: true });

  // 5) reload the list page: the list survives
  await hub.reload(); await settled(hub);
  console.log("5) after reload rows:", (await table(hub)).length);

  // 6) KML command for C2 and D: only these, D missing
  await sw.evaluate(async (t) => runAction("contours-kml", t), `${C2} ${D}`);
  await hub.waitForTimeout(1500); await settled(hub);
  console.log("6) kml message:", await hub.locator("#message").innerText());
  console.log("   downloads:", (await sw.evaluate(async () => (await chrome.downloads.search({})).length)));

  // 7) a map that never answers
  const t0 = Date.now();
  await hub.fill("#codesInput", `ტექსტი ${H}`); await hub.click("#addCodes");
  await hub.waitForFunction((code) => [...document.querySelectorAll("#rows tr")].some((r) => r.innerText.includes(code) && !r.querySelector("td.working")), H, { timeout: 60000 });
  console.log("7) hanging maps.gov.ge:", ((Date.now() - t0) / 1000).toFixed(1) + " s ->", (await table(hub)).find((t) => t.startsWith(H)));

  // 8) clear
  await hub.click("#clearList");
  console.log("8) cleared: rows", (await table(hub)).length, "| stored:", await sw.evaluate(async () => ((await chrome.storage.session.get("contourCollection")).contourCollection || []).length));

  // 8b) popup-ის ღილაკი "სია" ველში ჩაწერილი კოდით: გასუფთავებული სიის მერე კოდი სიას უნდა დაემატოს
  const popupPage = watch(await ctx.newPage());
  await popupPage.goto(`chrome-extension://${id}/popup.html`);
  await popupPage.fill("#code", `კოდი ${A}`);
  await popupPage.click("#contoursList").catch(() => {}); // popup თავს ხურავს
  await hub.waitForFunction((code) => [...document.querySelectorAll("#rows tr")].some((r) => r.innerText.includes(code) && !r.querySelector("td.working")), A, { timeout: 30000 }).catch(() => {});
  console.log("8b) popup list button with a code: rows", (await table(hub)).length, "->", (await table(hub)).map((t) => t.split(" | ")[0]).join(", "));

  // 8c) უკვე გახსნილ geojson.io-ს ტაბზე ახალი კონტურის დამატება: ტაბი ერთი რჩება და ახალ კოდსაც შეიცავს
  await sw.evaluate(async (t) => runAction("contours-map", t), B);
  await hub.waitForTimeout(2500);
  console.log("8c) map after adding one more code: geojson tabs", ctx.pages().filter((p) => p.url().startsWith("https://geojson.io/")).length, "| features:", geoPage() ? featuresText(decodeLink(geoPage().url())) : "none");

  // 8d) "წერტილი -> კოდი" ფანჯრის ღილაკები "სიაში" და "geojson.io"
  await sw.evaluate(async (code) => chrome.storage.session.set({ result_t8d: { kind: "point", place: { lat: 41.7, lon: 44.78, how: "ტესტი" }, items: [{ cad: code, address: "" }] } }), C2);
  const resultPage = watch(await ctx.newPage());
  await resultPage.goto(`chrome-extension://${id}/result.html#t8d`);
  await resultPage.locator("button.b-cont", { hasText: "სიაში" }).click();
  await hub.waitForFunction((code) => [...document.querySelectorAll("#rows tr")].some((r) => r.innerText.includes(code) && !r.querySelector("td.working")), C2, { timeout: 30000 }).catch(() => {});
  console.log("8d) result window 'სიაში': rows", (await table(hub)).map((t) => t.split(" | ")[0]).join(", "));
  await resultPage.locator("button.b-cont", { hasText: "geojson.io" }).click();
  await hub.waitForTimeout(2500);
  console.log("8d) result window 'geojson.io': geojson tabs", ctx.pages().filter((p) => p.url().startsWith("https://geojson.io/")).length, "| features:", geoPage() ? featuresText(decodeLink(geoPage().url())) : "none");

  // 8e) განცხადების კონტურები კოდის გარეშე: სიაში მზა პოლიგონით (მწვანე), შემდეგ geojson.io
  await hub.click("#clearList").catch(() => {});
  const appList = await hub.evaluate(() => chrome.runtime.sendMessage({ type: "ms-app-contours", number: "AR777", action: "list", center: null }));
  await hub.waitForTimeout(1500);
  console.log("8e) application 'ყველა სიაში':", JSON.stringify(appList), "| rows:", (await table(hub)).join(" ; "));
  const appListAgain = await hub.evaluate(() => chrome.runtime.sendMessage({ type: "ms-app-contours", number: "AR777", action: "map", center: null }));
  await hub.waitForTimeout(2500);
  console.log("8e) again + map:", JSON.stringify(appListAgain), "| rows:", (await table(hub)).length, "| features:", geoPage() ? featuresText(decodeLink(geoPage().url())) : "none");
  // პანელი ms.gov.ge-ზე: "⋯" მენიუ
  await sw.evaluate(async () => runAction("ms-app", "AR777", true));
  await hub.waitForTimeout(3000);
  const msPage = ctx.pages().find((p) => p.url().startsWith("https://ms.gov.ge/msmap"));
  if (msPage) {
    watch(msPage);
    await msPage.waitForTimeout(1500);
    const panelHost = msPage.locator("#napr-app-panel");
    await panelHost.locator(".item .more").first().click();
    const menuTexts = await panelHost.locator(".menu button").allInnerTexts();
    await msPage.screenshot({ path: path.join(OUT, "ms_panel_menu.png") });
    console.log("8e) panel menu:", menuTexts.join(" | "));
  } else console.log("8e) panel: ms.gov.ge tab not found");

  // 8f) geojson.io-ზე "Label:" ავტომატურად "კოდი" ხდება
  if (geoPage()) await geoPage().waitForFunction(() => /კოდი/.test(document.querySelector("#lb").textContent) && !document.querySelector("#pop select"), null, { timeout: 15000 }).catch(() => {});
  if (geoPage()) console.log("8f) geojson.io label:", JSON.stringify(await geoPage().locator("#lb").innerText()), "| popup closed:", (await geoPage().locator("#pop select").count()) === 0);

  // 8g) რიგი: კოდით დალაგება, გადათრევა; "ახალ ტაბში" ძველ geojson.io ტაბს ტოვებს
  await hub.fill("#codesInput", `${B} ${A}`); await hub.click("#addCodes");
  await settled(hub); await hub.waitForTimeout(500);
  const order = async () => (await table(hub)).map((t) => t.split(" | ")[0].trim()).join(", ");
  console.log("8g) before:", await order());
  await hub.click("#sortByCode"); await hub.waitForTimeout(300);
  console.log("8g) sorted:", await order());
  await hub.click("#sortByCode"); await hub.waitForTimeout(300);
  console.log("8g) sorted desc:", await order());
  // სტრიქონის ტექსტიდან გადათრევა არ უნდა მოხდეს (ტექსტი ინიშნება), მხოლოდ ⠿-ით
  await hub.locator("#rows tr").nth(3).locator(".code-text").dragTo(hub.locator("#rows tr").nth(0)); await hub.waitForTimeout(500);
  console.log("8g) drag by text (must not move):", await order());
  await hub.locator("#rows tr").nth(3).locator(".grip").dragTo(hub.locator("#rows tr").nth(0)); await hub.waitForTimeout(500);
  console.log("8g) last dragged to top by ⠿:", await order());
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: `chrome-extension://${id}` }).catch(() => {});
  const firstCode = (await order()).split(", ")[0];
  await hub.locator("#rows tr").nth(0).locator(".code-text").click(); await hub.waitForTimeout(300);
  console.log("8g) click code -> message:", await hub.locator("#message").innerText(), "| clipboard same:", (await hub.evaluate(() => navigator.clipboard.readText()).catch((e) => "ERR " + e.message)) === firstCode);
  const tabsBefore = ctx.pages().filter((p) => p.url().startsWith("https://geojson.io/")).length;
  await hub.click("#openOnMapNewTab"); await hub.waitForTimeout(1500);
  const geoTabs = ctx.pages().filter((p) => p.url().startsWith("https://geojson.io/"));
  console.log("8g) new tab: geojson tabs", tabsBefore, "->", geoTabs.length, "| newest features:", featuresText(decodeLink(geoTabs[geoTabs.length - 1].url())));
  await hub.click("#openOnMap"); await hub.waitForTimeout(1500);
  console.log("8g) then 'რუკაზე ჩვენება': geojson tabs", ctx.pages().filter((p) => p.url().startsWith("https://geojson.io/")).length);

  // 8h) DEMO2: "რუკაზე + ორთო 2024" -> geojson.io-ს localStorage-ში ფენა; ჩვეულებრივი ჩვენება მას შლის
  console.log("8h) DNR rulesets:", JSON.stringify(await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets())));
  await hub.click("#openOnMapWithOrtho"); await hub.waitForTimeout(2000);
  const orthoLayers = async () => geoPage().evaluate(() => (JSON.parse(localStorage.getItem("customRasterLayers") || "[]")).map((l) => l.name + " " + l.tileUrl).join(" ; "));
  console.log("8h) ortho link:", geoPage().url().split("#")[0], "| layers:", await orthoLayers());
  const fetchResult = await geoPage().evaluate(() => fetch("https://ms.gov.ge/gis-api/v1/tileserver/image2024/81841/48798/17").then((r) => "ok " + r.status, (e) => "FAIL " + e.message));
  console.log("8h) tile fetch from geojson.io:", fetchResult, "| server saw:", orthoTileRequests.slice(-1)[0] || "nothing");
  await hub.click("#openOnMap"); await hub.waitForTimeout(2000);
  console.log("8h) plain link:", geoPage().url().split("#")[0], "| layers:", JSON.stringify(await orthoLayers()));

  // 9) geojson.io in "this place ->"
  const jump = await sw.evaluate(async () => {
    const loc = await getLocation({ url: "https://geojson.io/?map=16.5%2F41.7084%2F44.7835" });
    return { loc, toMs: msTargetUrl(loc), back: geojsonIoTargetUrl({ lat: 41.7084, lon: 44.7835, zoom: 18 }), plain: parseGeojsonIoUrl("https://geojson.io/?map=17/41.7/44.78") };
  });
  console.log("9) jump:", JSON.stringify(jump));

  // 10) history + popup
  const hist = await sw.evaluate(async () => ((await chrome.storage.local.get("history")).history || []).map((r) => `${r.action}:${r.code}:${r.status}:${r.note || r.error}`));
  console.log("10) history:", hist.join(" ; "));
  const popup = watch(await ctx.newPage()); await popup.setViewportSize({ width: 360, height: 600 });
  await popup.goto(`chrome-extension://${id}/popup.html`); await popup.waitForTimeout(500);
  await popup.screenshot({ path: path.join(OUT, "popup.png"), fullPage: true });

  // 10b) ისტორიის ფილტრი "პირადი ნომრით" ჩანს მხოლოდ მაშინ, როცა ასეთი ჩანაწერი ისტორიაშია
  const historyPage = watch(await ctx.newPage());
  await historyPage.goto(`chrome-extension://${id}/history.html`); await historyPage.waitForTimeout(800);
  const personChips = () => historyPage.locator("#actionChips").innerText().then((t) => (t.match(/პირადი ნომრით/g) || []).length);
  const chipsBefore = await personChips();
  await sw.evaluate(async () => addHistory("maps-person", [{ code: "01234567890", status: "missing", error: "" }]));
  await historyPage.waitForTimeout(800);
  console.log("10b) person filter chips: before", chipsBefore, "-> after a person row", await personChips());

  // 11) the user's updated HTML on the same PDFs
  if (ORIGINAL_HTML) {
    const files = ["plan_c_2026.pdf", "plan_c_2015.pdf", "plan_hole_rc4.pdf", "plan_one_line.pdf", "plan_2010_spaces.pdf"];
    const po = await ctx.newPage();
    await po.goto("file://" + ORIGINAL_HTML);
    await po.setInputFiles("input[type=file]", files.map((f) => path.join(FX, f)));
    await po.waitForFunction((n) => window.__cadResults && window.__cadResults.length >= n, files.length, { timeout: 30000 });
    const orig = await po.evaluate(() => window.__cadResults.map((r) => ({ stem: r.stem, coords: new TextDecoder().decode(r.kml).match(/<coordinates>([^<]*)<\/coordinates>/g) })));
    const mine = await hub.evaluate(async (files) => { const conv = await import("./plan_converter.js"); const out = [];
      for (const f of files) { const b = new Uint8Array(await (await fetch("https://bs.napr.gov.ge/GetBlob?pid=101&bid=" + f)).arrayBuffer()); const r = await conv.convertPlanPdf(b);
        out.push({ coords: r.polygons.flatMap((poly) => poly.map((ring) => "<coordinates>" + ring.map(([lo, la]) => `${lo.toFixed(8)},${la.toFixed(8)},0`).join(" ") + "</coordinates>")), diff: r.areaDifferencePercent.toFixed(3), warnings: r.warnings }); }
      return out; }, files);
    orig.forEach((o, i) => console.log("11) HTML vs EXTENSION", files[i], "identical:", JSON.stringify(o.coords) === JSON.stringify(mine[i].coords), "| area diff %:", mine[i].diff, "|", mine[i].warnings.join(" ").slice(0, 90)));
  }
  // 12) how Chrome orders the shortcuts page
  try {
    const sp = await ctx.newPage(); await sp.goto("chrome://extensions/shortcuts"); await sp.waitForTimeout(1500);
    const order = await sp.evaluate(() => { const out = []; const walk = (root) => { for (const el of root.querySelectorAll("*")) { if (el.classList && el.classList.contains("command-name")) out.push(el.textContent.trim()); if (el.shadowRoot) walk(el.shadowRoot); } }; walk(document); return out; });
    console.log("12) SHORTCUTS PAGE ORDER:", order.map((t) => t.split(" ")[0]).join(" "));
  } catch (e) { console.log("12) shortcuts page not readable:", String(e).slice(0, 100)); }
  console.log("ERRORS:", errs.length ? errs : "none");
  await ctx.close();
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
