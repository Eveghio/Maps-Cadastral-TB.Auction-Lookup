// Runs in the ms.gov.ge page itself (world MAIN), before the site's code. The site's search can list
// the contours of one application in a different order every time, so content_ms.js needs the exact
// response this page received to know which result row is which contour. This only reads the
// responses of the site's own "unified-search" requests and passes them on; it changes nothing.
(() => {
  if (window.__naprMsHook) return;
  window.__naprMsHook = true;
  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__naprUrl = String(url || "");
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (this.__naprUrl.includes("/search/unified-search")) {
      let text = "";
      try { text = JSON.parse(body).searchText || ""; } catch (e) { /* not JSON */ }
      this.addEventListener("load", () => {
        try {
          const data = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
          window.postMessage({ source: "napr-ms-hook", type: "unified-search", text, data }, location.origin);
        } catch (e) { /* ignore */ }
      });
    }
    return send.apply(this, arguments);
  };
})();
