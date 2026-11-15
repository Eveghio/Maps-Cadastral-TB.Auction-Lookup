// Codes found at a place (point) or a person's parcels (person), with buttons for the usual actions.
const el = (id) => document.getElementById(id);
const close = () => window.close();
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } });
el("close").addEventListener("click", close);
el("history").addEventListener("click", () => openHistoryPage().then(close));

// the extension's normal actions, as if the code had been typed into the popup
// The map tab gets the focus when an action opens something; this window then comes back to the
// front (Chrome has no "always on top" for extension windows).
async function backToFront() {
  try {
    const w = await chrome.windows.getCurrent();
    setTimeout(() => chrome.windows.update(w.id, { focused: true }).catch(() => {}), 600);
  } catch (e) { /* ignore */ }
}

function run(action, text, btn) {
  const old = btn.textContent.replace(/^[✓!] /, "");
  btn.textContent = "…";
  chrome.runtime.sendMessage({ type: "run", action, text, newTab: false }, (res) => {
    btn.textContent = res && res.ok ? "✓ " + old : "! " + old;
    if (res && !res.ok) btn.title = res.error || "";
    backToFront();
  });
}

// კონტურების სიაში დამატება ისე, როგორც popup-ის ღილაკი "სია" (ველში ჩაწერილი კოდით)
function addToContourList(cadastralCode, btn) {
  const oldText = btn.textContent.replace(/^[✓!] /, "");
  btn.textContent = "…";
  chrome.runtime.sendMessage({ type: "contours-open-list", text: cadastralCode }, (res) => {
    btn.textContent = res && res.ok ? "✓ " + oldText : "! " + oldText;
    backToFront();
  });
}

// copy from this (focused) window; the background copy is only a fallback
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { return false; }
}

function button(cls, text, title, onClick) {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = text;
  b.title = title;
  b.addEventListener("click", () => onClick(b));
  return b;
}

function itemBox(it) {
  const box = document.createElement("div");
  box.className = "item";
  const cad = document.createElement("div");
  cad.className = "cad";
  cad.textContent = it.cad;
  if (it.sources && it.sources.length) {
    const s = document.createElement("small");
    s.textContent = it.sources.join(" + ");
    cad.appendChild(s);
  }
  const addr = document.createElement("div");
  addr.className = "addr";
  addr.textContent = it.address || "";
  const acts = document.createElement("div");
  acts.className = "acts";
  acts.append(
    button("b-maps", "maps.gov.ge რუკა", "ღია maps.gov.ge რუკაზე დამატება", (b) => run("maps-map", it.cad, b)),
    button("b-maps", "KML", "maps.gov.ge-დან .kml", (b) => run("maps-kml", it.cad, b)),
    button("b-ms", "ms.gov.ge რუკა", "ms.gov.ge რუკაზე დამატება", (b) => run("ms-map", it.cad, b)),
    button("b-cont", "სიაში", "კონტურების სიაში დამატება (რუკის გახსნის გარეშე)", (b) => addToContourList(it.cad, b)),
    button("b-cont", "geojson.io", "სიაში დამატება და მთელი სია geojson.io-ს რუკაზე", (b) => run("contours-map", it.cad, b)),
    button("b-reg", "ამონაწერი", "ქრონოლოგიურად ბოლო ამონაწერი", (b) => run("pdf", it.cad, b)),
    button("b-reg", "გეგმა", "ბოლო საკადასტრო გეგმა", (b) => run("plan", it.cad, b)),
    button("b-reg", "ყველა დოკ.", "რეესტრის გვერდი ყველა დოკუმენტით", (b) => run("abstract", it.cad, b)),
    button("b-copy", "კოპირება", "კოდის კოპირება", async (b) => {
      b.textContent = (await copyText(it.cad)) ? "✓ დაკოპირდა" : "! ვერ დაკოპირდა";
    })
  );
  box.append(cad, addr, acts);
  return box;
}

(async () => {
  const key = "result_" + location.hash.slice(1);
  const data = (await chrome.storage.session.get(key))[key];
  if (!data) { el("title").textContent = "შედეგი აღარ არის ხელმისაწვდომი"; return; }
  await chrome.storage.session.remove(key);
  const items = data.items || [];
  if (data.kind === "point") {
    document.title = items.length ? `საკადასტრო კოდი: ${items[0].cad}` : "საკადასტრო კოდი ვერ მოიძებნა";
    el("title").textContent = items.length ? (items.length === 1 ? "ამ ადგილას არის ნაკვეთი" : `ამ ადგილას ${items.length} ნაკვეთია`) : "ამ ადგილას რეგისტრირებული ნაკვეთი ვერ მოიძებნა";
    el("sum").textContent = `${data.place.lat}, ${data.place.lon} · ${data.place.how}`;
    if (data.copy) {
      const ok = (await copyText(data.copy)) || data.copiedByBackground;
      el("copied").hidden = false;
      el("copied").style.color = ok ? "" : "#b45309";
      el("copied").textContent = ok
        ? `${data.copy} დაკოპირდა (Ctrl+V). კოდის შორთქათები (მაგ. maps.gov.ge რუკა) ბუფერიდან კითხულობენ, თუ გვერდზე სხვა კოდი არ გაქვს მონიშნული - ამიტომ ახლავე შეგიძლია დააჭირო.`
        : `${data.copy} ვერ დაკოპირდა - გამოიყენე „კოპირება“ ღილაკი.`;
    }
  } else {
    document.title = `პირადი ნომერი ${data.pn}: ${items.length} ნაკვეთი`;
    el("title").textContent = items.length ? `პირადი ნომერი ${data.pn}: ${items.length} ნაკვეთი` : `პირად ნომერზე ${data.pn} ნაკვეთი ვერ მოიძებნა`;
    el("sum").textContent = items.length ? "ყველა დაემატა maps.gov.ge რუკას" : "";
    if (items.length && data.missing && data.missing.length) { el("err").hidden = false; el("err").textContent = `ვერ მოიძებნა: ${data.missing.join(", ")}`; }
    if (items.length) {
      el("all").hidden = false;
      el("all").addEventListener("click", () => run("maps-person-kml", data.pn, el("all")));
    }
  }
  if (data.error) { el("err").hidden = false; el("err").textContent = data.error; }
  for (const it of items) el("list").appendChild(itemBox(it));
  el("close").focus();
  fitHeight();
})();

// the window gets exactly the height of its content (no scrollbar for a short list)
async function fitHeight() {
  try {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const w = await chrome.windows.getCurrent();
    const frame = window.outerHeight - window.innerHeight;
    const want = Math.min(screen.availHeight - 60, document.documentElement.scrollHeight + frame + 2);
    if (Math.abs(want - window.outerHeight) > 4) await chrome.windows.update(w.id, { height: Math.round(want) });
  } catch (e) { /* keep the size */ }
}
