(() => {
  if (window.__TUBECAPTION_CONTENT__) return;
  window.__TUBECAPTION_CONTENT__ = true;

  const REQUEST_SOURCE = "tubecaption-extension";
  const RESPONSE_SOURCE = "tubecaption-page";
  const pending = new Map();

  injectPageBridge();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !["TCL_GET_VIDEO", "TCL_FETCH_CAPTION"].includes(message.type)) {
      return false;
    }

    const action = message.type === "TCL_GET_VIDEO" ? "getVideo" : "fetchCaption";
    sendToPage(action, message.payload || {})
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (!message || message.source !== RESPONSE_SOURCE || !message.requestId) return;

    const request = pending.get(message.requestId);
    if (!request) return;

    clearTimeout(request.timeout);
    pending.delete(message.requestId);
    if (message.ok) request.resolve(message.data);
    else request.reject(new Error(message.error || "YouTube page request failed."));
  });

  function injectPageBridge() {
    if (document.getElementById("tubecaption-page-bridge")) return;
    const script = document.createElement("script");
    script.id = "tubecaption-page-bridge";
    script.src = chrome.runtime.getURL("page.js");
    script.onload = () => script.remove();
    const target = document.documentElement || document.head;
    if (target) {
      target.appendChild(script);
    } else {
      document.addEventListener("DOMContentLoaded", () => {
        (document.documentElement || document.head).appendChild(script);
      }, { once: true });
    }
  }

  function sendToPage(action, payload) {
    const requestId = `${Date.now()}-${crypto.randomUUID()}`;
    const message = { source: REQUEST_SOURCE, requestId, action, payload };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("等待 YouTube 页面数据超时，请刷新页面后重试。"));
      }, 30000);

      pending.set(requestId, { resolve, reject, timeout });
      window.postMessage(message, window.location.origin);
    });
  }
})();
