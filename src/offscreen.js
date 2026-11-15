chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "offscreen-doc") return;

  if (message.type === "get-clipboard-data") {
    try {
      const textarea = document.createElement("textarea");
      document.body.appendChild(textarea);
      textarea.focus();
      document.execCommand("paste");
      const text = textarea.value;
      document.body.removeChild(textarea);
      sendResponse(text);
    } catch (err) {
      console.error("Paste failed:", err);
      sendResponse("");
    }
  }
  if (message.type === "copy-text") {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = String(message.text || "");
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(textarea);
      sendResponse(ok);
    } catch (err) {
      console.error("Copy failed:", err);
      sendResponse(false);
    }
  }
  return true;
});
