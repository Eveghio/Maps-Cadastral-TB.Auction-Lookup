const HISTORY_KEY = "history";
const PREFS_KEY = "historyViewPrefs"; // remembered filters/sort (this browser only)
const el = (id) => document.getElementById(id);
let all = [];

// Empty set = "no filter" (everything shown); ticking chips narrows the list.
const state = { actions: new Set(), statuses: new Set(), sources: new Set(), text: "", sort: "t", dir: -1 };
const SOURCE_LABELS = { own: "ჩემი", imported: "იმპორტირებული" };
const sourceOf = (r) => (r.imported ? "imported" : "own");
const AUCTION_LINK = "https://auction.tbilisi.gov.ge/Pages/Auctions/Lot.aspx?id=";
// the same key the background uses to find a row when deleting
const rowKey = (r) => `${r.t}|${r.action}|${r.code}|${r.status}`;
const picked = new Set(); // keys of ticked rows (only rows that are shown can stay ticked)
let shownRows = [];
// registry / auction rows: the page that was opened (older auction rows: rebuilt from the lot number)
const openedLink = (r) => r.to || (r.action === "auction" && /^\d+$/.test(String(r.code)) ? AUCTION_LINK + r.code : "");

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ actions: [...state.actions], statuses: [...state.statuses], sources: [...state.sources], sort: state.sort, dir: state.dir }));
  } catch (e) { /* storage unavailable: just don't remember */ }
}
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
    if (!p) return;
    state.actions = new Set((p.actions || []).filter((a) => a in ACTIONS));
    state.statuses = new Set((p.statuses || []).filter((s) => s in STATUS_LABELS));
    state.sources = new Set((p.sources || []).filter((s) => s in SOURCE_LABELS));
    if (["t", "action", "code", "res", "status"].includes(p.sort)) state.sort = p.sort;
    if (p.dir === 1 || p.dir === -1) state.dir = p.dir;
  } catch (e) { /* ignore */ }
}

function chip(label, checked, color, onChange) {
  const l = document.createElement("label");
  l.className = "chip" + (checked ? " on" : "");
  if (color) l.style.setProperty("--c", color);
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = checked;
  cb.addEventListener("change", () => {
    l.classList.toggle("on", cb.checked);
    onChange(cb.checked);
  });
  l.append(cb, document.createTextNode(label));
  return l;
}

function toggle(set, value, on) {
  if (on) set.add(value); else set.delete(value);
  savePrefs();
  render();
}

// ეს ფილტრები ჩანს მხოლოდ მაშინ, თუ ისტორიაში ასეთი ჩანაწერი მართლა არის (პირადი ნომრით ძებნა თვალში არ უნდა ეცემოდეს)
const ACTIONS_SHOWN_ONLY_IF_USED = ["maps-person", "maps-person-kml"];

function buildFilters() {
  const ac = el("actionChips");
  ac.textContent = "";
  const usedActions = new Set(all.map((row) => row.action)); // ერთი გავლა ისტორიაზე: მსუბუქია
  // grouped by site, coloured like the popup rows
  for (const site of Object.keys(SITES)) {
    const actions = Object.keys(ACTIONS).filter((a) => ACTIONS[a].site === site
      && (!ACTIONS_SHOWN_ONLY_IF_USED.includes(a) || usedActions.has(a) || state.actions.has(a)));
    if (!actions.length) continue;
    const g = document.createElement("span");
    g.className = "group";
    g.style.setProperty("--c", SITES[site].color);
    const n = document.createElement("span");
    n.className = "gname";
    n.textContent = SITES[site].label;
    g.appendChild(n);
    for (const a of actions) g.appendChild(chip(ACTIONS[a].name, state.actions.has(a), SITES[site].color, (on) => toggle(state.actions, a, on)));
    ac.appendChild(g);
  }
  const sc = el("statusChips");
  sc.textContent = "";
  for (const s of Object.keys(STATUS_LABELS)) sc.appendChild(chip(STATUS_LABELS[s], state.statuses.has(s), null, (on) => toggle(state.statuses, s, on)));
  const src = el("sourceChips");
  src.textContent = "";
  for (const s of Object.keys(SOURCE_LABELS)) src.appendChild(chip(SOURCE_LABELS[s], state.sources.has(s), s === "imported" ? "#5e35b1" : null, (on) => toggle(state.sources, s, on)));
}

// everything the text filter looks at (code / route, links, coordinates)
function haystack(r) {
  const p = r.place ? `${r.place.lat}, ${r.place.lon} ${r.place.how || ""}` : "";
  const items = Array.isArray(r.items) ? r.items.map((it) => `${it.type} ${it.cad} ${it.address} ${it.link}`).join(" ") : "";
  return `${r.code} ${r.from || ""} ${openedLink(r)} ${p} ${r.doc || ""} ${items}`.toLowerCase();
}

// Older rows kept maps.gov.ge "#state/point=..." links without "&share=1&layers=92,97",
// which the site opens without moving to the point: complete them when shown.
function workingLink(url) {
  if (url && url.startsWith("https://maps.gov.ge/map/portal#state/point=") && !/[&?]share=1/.test(url)) {
    return url + "&share=1&layers=92,97";
  }
  return url;
}

function anchor(url, text, onClick) {
  const a = document.createElement("a");
  a.href = url;
  a.textContent = text || url;
  a.title = url;
  a.target = "_blank";
  a.rel = "noopener";
  if (onClick) a.addEventListener("click", onClick);
  return a;
}

// "searched" column of a Map Jump row: route, place, and the page it started from
function fillJumpQuery(cell, r) {
  cell.textContent = "";
  const route = document.createElement("div");
  route.className = "route";
  route.textContent = r.code;
  cell.appendChild(route);
  if (r.place) {
    const p = document.createElement("div");
    p.className = "place";
    p.textContent = `${r.place.lat}, ${r.place.lon} · ზუმი ${r.place.zoom} · ${r.place.how}`;
    cell.appendChild(p);
  }
  if (r.from) {
    const d = document.createElement("div");
    d.className = "from";
    const b = document.createElement("b");
    b.textContent = "საიდან: ";
    d.append(b, anchor(workingLink(r.from)));
    cell.appendChild(d);
  }
}

// "result" column: the page that was opened (link), or the saved KML file
// ms.gov.ge application: one line per contour (code, address, link); a contour without its own
// objId link (architecture) is drawn again through the extension
function fillAppResult(cell, r) {
  if (String(r.action) === "ms-app-kml" && r.status === "found") {
    const f = document.createElement("div");
    f.className = "file";
    f.textContent = `ფაილი: ${r.code}.kml`;
    cell.appendChild(f);
  }
  r.items.forEach((it, i) => {
    const d = document.createElement("div");
    d.className = "appitem";
    const b = document.createElement("b");
    b.textContent = `${i + 1}. ${it.cad || "კოდი არ არის"}` + (r.action === "point-code" && it.type ? ` (${it.type})` : "");
    d.appendChild(b);
    if (it.address) d.appendChild(document.createTextNode(` · ${it.address}`));
    if (it.link) {
      d.appendChild(document.createElement("br"));
      const own = !String(r.action).startsWith("ms-app") || it.link.includes("objId=");
      d.appendChild(anchor(it.link, own ? it.link : `${it.link}  (დაიხატება ძიებით)`, own ? null : (e) => {
        e.preventDefault();
        chrome.runtime.sendMessage({ type: "ms-app-open", number: r.code, items: r.items, index: i });
      }));
    }
    cell.appendChild(d);
  });
  if (r.doc) {
    const d = document.createElement("div");
    d.className = "appitem";
    const b = document.createElement("b");
    b.textContent = "განცხადება: ";
    d.append(b, anchor(r.doc));
    cell.appendChild(d);
  }
}

function fillResult(cell, r) {
  if (Array.isArray(r.items)) return fillAppResult(cell, r);
  if (r.note) { // contours: where the contour came from + the list page
    const source = document.createElement("span");
    source.className = "file";
    source.textContent = `წყარო: ${r.note} `;
    cell.appendChild(source);
    if (r.to) cell.appendChild(anchor(r.to, "სია"));
    return;
  }
  if (String(r.action).endsWith("-kml")) {
    if (r.status === "found") {
      const f = document.createElement("span");
      f.className = "file";
      f.textContent = `ფაილი: ${r.code}.kml`;
      cell.appendChild(f);
    }
    return;
  }
  const url = openedLink(r);
  if (!url) return;
  // rows from v3.2/3.3 stored only ".../map/portal" for maps.gov.ge jumps: re-open those through
  // the extension (coordinate search); newer rows carry a working "state/point...&share=1" link
  const oldMapsJump = r.action === "jump-maps" && r.place && !url.includes("#state/point");
  const reopen = oldMapsJump
    ? (e) => { e.preventDefault(); chrome.runtime.sendMessage({ type: "jump-reopen", target: "maps", place: r.place }); }
    : null;
  if (String(r.action).startsWith("jump-")) {
    const b = document.createElement("b");
    b.textContent = "სად: ";
    cell.appendChild(b);
  }
  cell.appendChild(anchor(url, oldMapsJump ? `${url}  (ძიება: ${r.place.lon},${r.place.lat})` : url, reopen));
}

const resultText = (r) => r.note ? r.note : String(r.action).endsWith("-kml") ? (r.status === "found" ? `${r.code}.kml` : "") : openedLink(r);

function sortValue(r, key) {
  if (key === "action") return actionLabel(r.action);
  if (key === "status") return STATUS_LABELS[r.status] || r.status;
  if (key === "res") return resultText(r);
  return r[key];
}

// the rows the current filters let through, in the current sort order
function filteredRows() {
  const text = state.text;
  const rows = all.filter((r) =>
    (!state.actions.size || state.actions.has(r.action)) &&
    (!state.statuses.size || state.statuses.has(r.status)) &&
    (!state.sources.size || state.sources.has(sourceOf(r))) &&
    (!text || haystack(r).includes(text.toLowerCase()))
  );
  // stable sort; ties keep newest first
  rows.sort((a, b) => {
    const va = sortValue(a, state.sort), vb = sortValue(b, state.sort);
    const c = typeof va === "number" ? va - vb : String(va).localeCompare(String(vb), "ka", { numeric: true });
    return c !== 0 ? c * state.dir : b.t - a.t;
  });
  return rows;
}

function filterActive() {
  return state.actions.size || state.statuses.size || state.sources.size || state.text;
}

// buttons + "select all" box, without redrawing the table
function updateSelectionUi() {
  const n = picked.size;
  el("delSel").disabled = !n;
  el("delSel").textContent = n ? `მონიშნულის წაშლა (${n})` : "მონიშნულის წაშლა";
  el("delShown").hidden = !(filterActive() && shownRows.length && shownRows.length !== all.length);
  el("delShown").textContent = `ნაჩვენების წაშლა (${shownRows.length})`;
  const box = el("selAll");
  box.checked = shownRows.length > 0 && n === shownRows.length;
  box.indeterminate = n > 0 && n < shownRows.length;
}

function render() {
  const rows = filteredRows();
  shownRows = rows;
  // a row hidden by the filter is no longer ticked, so "delete ticked" never removes unseen rows
  const visible = new Set(rows.map(rowKey));
  for (const k of [...picked]) if (!visible.has(k)) picked.delete(k);
  const tbody = el("rows");
  tbody.textContent = "";
  for (const r of rows) {
    const tr = document.createElement("tr");
    const td = (cls, txt) => { const c = document.createElement("td"); if (cls) c.className = cls; c.textContent = txt; tr.appendChild(c); return c; };
    const key = rowKey(r);
    const selCell = td("sel", "");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.key = key;
    cb.checked = picked.has(key);
    if (cb.checked) tr.className = "picked";
    selCell.appendChild(cb);
    const timeCell = td("time", formatTime(r.t));
    if (r.imported) {
      const b = document.createElement("span");
      b.className = "imp";
      b.textContent = "იმპორტი";
      b.title = `ფაილი: ${r.imported.file || "?"}\nიმპორტირდა: ${formatTime(r.imported.at)}`;
      timeCell.appendChild(b);
    }
    const act = td("act", actionLabel(r.action));
    act.style.color = actionColor(r.action);
    const codeCell = td("code", r.code);
    if (String(r.action).startsWith("jump-") || r.action === "point-code") fillJumpQuery(codeCell, r);
    if (Array.isArray(r.items)) {
      const types = [...new Set(r.items.map((it) => it.type).filter(Boolean))].join("; ");
      if (types) {
        const t = document.createElement("div");
        t.className = "place";
        t.textContent = types;
        codeCell.appendChild(t);
      }
    }
    fillResult(td("res", ""), r);
    const res = td(r.status, STATUS_LABELS[r.status] || r.status);
    if (r.error) {
      const e = document.createElement("div");
      e.className = "errtext";
      e.textContent = r.error;
      res.appendChild(e);
    }
    tbody.appendChild(tr);
  }
  el("empty").hidden = rows.length > 0;
  el("count").textContent = `ნაჩვენებია ${rows.length} / სულ ${all.length}`;
  updateSelectionUi();
  for (const th of document.querySelectorAll("th[data-sort]")) {
    th.querySelector(".arrow").textContent = th.dataset.sort === state.sort ? (state.dir === 1 ? "▲" : "▼") : "";
  }
}

async function load() {
  all = (await chrome.storage.local.get(HISTORY_KEY))[HISTORY_KEY] || [];
  buildFilters(); // ფილტრების სია ისტორიის შიგთავსზეა დამოკიდებული (იხ. ACTIONS_SHOWN_ONLY_IF_USED)
  render();
}

for (const th of document.querySelectorAll("th[data-sort]")) {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (state.sort === key) state.dir = -state.dir;
    else { state.sort = key; state.dir = key === "t" ? -1 : 1; }
    savePrefs();
    render();
  });
}
el("text").addEventListener("input", () => { state.text = el("text").value.trim(); render(); });
el("reset").addEventListener("click", () => {
  state.actions.clear();
  state.statuses.clear();
  state.sources.clear();
  state.text = "";
  el("text").value = "";
  savePrefs();
  buildFilters();
  render();
});
// ---------- ticking and deleting rows ----------
el("rows").addEventListener("change", (e) => {
  const cb = e.target;
  if (!cb.matches('input[type="checkbox"][data-key]')) return;
  if (cb.checked) picked.add(cb.dataset.key); else picked.delete(cb.dataset.key);
  cb.closest("tr").classList.toggle("picked", cb.checked);
  updateSelectionUi();
});
el("selAll").addEventListener("change", () => {
  const on = el("selAll").checked;
  picked.clear();
  if (on) for (const r of shownRows) picked.add(rowKey(r));
  for (const cb of el("rows").querySelectorAll('input[type="checkbox"][data-key]')) {
    cb.checked = on;
    cb.closest("tr").classList.toggle("picked", on);
  }
  updateSelectionUi();
});

async function deleteKeys(keys, question) {
  if (!keys.length || !confirm(question)) return;
  const res = await new Promise((resolve) => chrome.runtime.sendMessage({ type: "history-delete", keys }, resolve));
  if (!res || !res.ok) return say("წაშლა ვერ მოხერხდა: " + ((res && res.error) || "პასუხი ვერ მივიღე"), true);
  picked.clear();
  say(`წაიშალა ${res.removed} ჩანაწერი · დარჩა ${res.total}`);
}
el("delSel").addEventListener("click", () =>
  deleteKeys([...picked], `წაიშალოს მონიშნული ${picked.size} ჩანაწერი?`));
el("delShown").addEventListener("click", () =>
  deleteKeys(shownRows.map(rowKey), `წაიშალოს ფილტრით ნაჩვენები ${shownRows.length} ჩანაწერი?\nდანარჩენი ${all.length - shownRows.length} ჩანაწერი დარჩება.`));

el("clear").addEventListener("click", async () => {
  if (!all.length) return;
  if (!confirm(`წაიშალოს ისტორიის ყველა ჩანაწერი (${all.length})?`)) return;
  await chrome.storage.local.remove(HISTORY_KEY);
});
// ---------- export / import ----------

function say(text, isError = false) {
  const n = el("note");
  n.className = isError ? "err" : "";
  n.textContent = text;
}

// Small modal with radio-button questions. Resolves to { groupName: value } or null (cancelled).
function askDialog({ title, info, groups, okText }) {
  return new Promise((resolve) => {
    el("dlgTitle").textContent = title;
    const body = el("dlgBody");
    body.textContent = "";
    if (info) {
      const p = document.createElement("p");
      p.textContent = info;
      body.appendChild(p);
    }
    for (const g of groups) {
      const fs = document.createElement("fieldset");
      const lg = document.createElement("legend");
      lg.textContent = g.label;
      fs.appendChild(lg);
      for (const o of g.options) {
        const l = document.createElement("label");
        const r = document.createElement("input");
        r.type = "radio";
        r.name = g.name;
        r.value = o.value;
        r.checked = !!o.checked;
        l.append(r, document.createTextNode(" " + o.text));
        fs.appendChild(l);
      }
      body.appendChild(fs);
    }
    el("dlgOk").textContent = okText;
    el("overlay").hidden = false;
    const done = (ok) => {
      el("overlay").hidden = true;
      document.removeEventListener("keydown", onKey);
      el("dlgOk").onclick = el("dlgCancel").onclick = null;
      if (!ok) return resolve(null);
      const out = {};
      for (const g of groups) out[g.name] = (body.querySelector(`input[name="${g.name}"]:checked`) || {}).value;
      resolve(out);
    };
    const onKey = (e) => {
      if (e.key === "Escape") done(false);
      else if (e.key === "Enter") { e.preventDefault(); done(true); }
    };
    document.addEventListener("keydown", onKey);
    el("dlgOk").onclick = () => done(true);
    el("dlgCancel").onclick = () => done(false);
    el("dlgOk").focus();
  });
}

el("export").addEventListener("click", async () => {
  if (!all.length) return say("ისტორია ცარიელია, გასატანი არაფერია", true);
  const shown = filteredRows();
  const ticked = shown.filter((r) => picked.has(rowKey(r)));
  let rows = all;
  if (shown.length !== all.length || ticked.length) {
    const options = [{ value: "all", text: `მთელი ისტორია (${all.length})`, checked: !ticked.length }];
    if (shown.length !== all.length) options.push({ value: "shown", text: `მხოლოდ ნაჩვენები, ფილტრის მიხედვით (${shown.length})` });
    if (ticked.length) options.push({ value: "ticked", text: `მხოლოდ მონიშნული (${ticked.length})`, checked: true });
    const a = await askDialog({ title: "ისტორიის ექსპორტი", groups: [{ name: "what", label: "რა გავიტანო?", options }], okText: "ექსპორტი" });
    if (!a) return;
    if (a.what === "shown") rows = shown;
    if (a.what === "ticked") rows = ticked;
  }
  // "imported" marks are not exported: whoever imports the file decides that for themselves
  const data = {
    format: "napr-lookup-history",
    version: 1,
    exportedAt: new Date().toISOString(),
    count: rows.length,
    rows: rows.map(({ imported, ...r }) => r).sort((a, b) => a.t - b.t)
  };
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  const name = `napr-history-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.json`;
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  say(`გატანილია ${rows.length} ჩანაწერი: ${name}`);
});

el("import").addEventListener("click", () => el("importFile").click());
el("importFile").addEventListener("change", async () => {
  const file = el("importFile").files[0];
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    el("importFile").value = "";
    return say(`${file.name}: ფაილი ვერ წავიკითხე (JSON არ არის)`, true);
  }
  el("importFile").value = ""; // the same file can be chosen again later
  const rows = Array.isArray(data) ? data
    : (data && data.format === "napr-lookup-history" && Array.isArray(data.rows)) ? data.rows : null;
  if (!rows) return say(`${file.name}: ეს არ არის ამ ექსთენშენის ისტორიის ფაილი`, true);
  if (!rows.length) return say(`${file.name}: ფაილში ჩანაწერი არ არის`, true);

  const times = rows.map((r) => r && Number(r.t)).filter((t) => Number.isFinite(t) && t > 0);
  const range = times.length ? ` · ${formatTime(Math.min(...times)).slice(0, 10)} – ${formatTime(Math.max(...times)).slice(0, 10)}` : "";
  const ans = await askDialog({
    title: `იმპორტი: ${file.name}`,
    info: `ფაილში ${rows.length} ჩანაწერია${range}`,
    groups: [
      { name: "mode", label: "როგორ შევიდეს?", options: [
        { value: "add", text: "დაემატოს არსებულ ისტორიას (ზუსტი დუბლიკატები გამოტოვდება)", checked: true },
        { value: "replace", text: `სრულად ჩაანაცვლოს არსებული ისტორია (წაიშლება ${all.length} ჩანაწერი)` }] },
      { name: "mark", label: "მოინიშნოს, რომ იმპორტირებულია?", options: [
        { value: "yes", text: "კი: ექნება ნიშანი „იმპორტი“ და ცალკე გაიფილტრება", checked: true },
        { value: "no", text: "არა: ჩაითვლება ჩემ ჩანაწერებად" }] }
    ],
    okText: "იმპორტი"
  });
  if (!ans) return;
  if (ans.mode === "replace" && all.length && !confirm(`ნამდვილად წაიშალოს არსებული ${all.length} ჩანაწერი და მის ნაცვლად ჩაიწეროს ფაილი?`)) return;

  const res = await new Promise((resolve) => chrome.runtime.sendMessage(
    { type: "history-import", rows, mode: ans.mode, markImported: ans.mark === "yes", fileName: file.name }, resolve));
  if (!res || !res.ok) return say("იმპორტი ვერ მოხერხდა: " + ((res && res.error) || "პასუხი ვერ მივიღე"), true);
  const parts = [`${ans.mode === "replace" ? "ისტორია ჩანაცვლდა" : "დაემატა"}: ${res.added} ჩანაწერი`];
  if (res.skipped) parts.push(`დუბლიკატი გამოტოვდა: ${res.skipped}`);
  if (res.invalid) parts.push(`არასწორი ჩანაწერი გამოტოვდა: ${res.invalid}`);
  if (res.dropped) parts.push(`ლიმიტის (10 000) გამო წაიშალა უძველესი: ${res.dropped}`);
  say(parts.join(" · "));
});

// refresh live while the page is open
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && HISTORY_KEY in changes) load();
});

loadPrefs();
buildFilters();
load();
