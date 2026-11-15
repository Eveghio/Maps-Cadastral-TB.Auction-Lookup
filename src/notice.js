const close = () => window.close();
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === "Escape") {
    e.preventDefault();
    close();
  }
});
document.getElementById("close").addEventListener("click", close);
document.getElementById("history").addEventListener("click", () => openHistoryPage().then(close));

function addList(title, rows) {
  if (!rows.length) return;
  const h = document.createElement("h2");
  h.textContent = `${title} (${rows.length})`;
  const ul = document.createElement("ul");
  for (const r of rows) {
    const li = document.createElement("li");
    li.textContent = r.code;
    if (r.error) {
      const e = document.createElement("div");
      e.className = "err";
      e.textContent = r.error;
      li.appendChild(e);
    }
    ul.appendChild(li);
  }
  document.getElementById("lists").append(h, ul);
}

(async () => {
  const key = "notice_" + location.hash.slice(1);
  const data = (await chrome.storage.session.get(key))[key];
  if (!data) {
    document.getElementById("title").textContent = "შეტყობინება აღარ არის ხელმისაწვდომი";
    return;
  }
  await chrome.storage.session.remove(key);
  const results = data.results;
  const missing = results.filter((r) => r.status === "missing");
  const errors = results.filter((r) => r.status === "error");
  const found = results.length - missing.length - errors.length;
  const what = actionLabel(data.action);
  document.title = `${what}: ვერ მოიძებნა ${missing.length + errors.length}`;
  document.getElementById("title").textContent = `${what}: ${results.length}-დან ${missing.length + errors.length} კოდი ვერ დამუშავდა`;
  document.getElementById("sum").textContent = `მოიძებნა: ${found} · ვერ მოიძებნა: ${missing.length}` + (errors.length ? ` · შეცდომა: ${errors.length}` : "");
  addList("ვერ მოიძებნა", missing);
  addList("შეცდომა", errors);
  document.getElementById("close").focus();
})();
