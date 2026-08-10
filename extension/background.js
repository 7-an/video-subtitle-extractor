const NATIVE_HOST = "com.chrono_asr.host";
const STORAGE_KEY = "tubeCaptionLastResult";
const clients = new Set();
let nativePort = null;
let activeJob = null;
let partialResult = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "tubecaption-popup") return;
  clients.add(port);

  port.onDisconnect.addListener(() => clients.delete(port));
  port.onMessage.addListener((message) => {
    if (message?.type === "startAsr") startAsr(message);
    if (message?.type === "cancelAsr") cancelAsr();
    if (message?.type === "getState") sendState(port);
  });

  sendState(port);
});

function sendState(port) {
  if (activeJob) {
    safePost(port, { type: "jobState", status: "running", jobId: activeJob.jobId });
    return;
  }
  chrome.storage.local.get(STORAGE_KEY).then((stored) => {
    if (stored[STORAGE_KEY]) safePost(port, { type: "cachedResult", data: stored[STORAGE_KEY] });
  });
}

function startAsr(message) {
  if (activeJob) {
    broadcast({ type: "error", error: "已有本地识别任务正在运行。" });
    return;
  }

  if (!isYouTubeUrl(message.url)) {
    broadcast({ type: "error", error: "只允许识别 HTTPS YouTube 视频地址。" });
    return;
  }

  const jobId = crypto.randomUUID();
  activeJob = { jobId, url: message.url };
  partialResult = null;

  try {
    ensureNativePort();
    nativePort.postMessage({
      action: "transcribe",
      jobId,
      url: message.url,
      language: message.language || "auto",
      model: message.model || "small"
    });
    broadcast({ type: "progress", jobId, stage: "starting", message: "正在启动本地识别助手…" });
  } catch (error) {
    finishWithError(error.message);
  }
}

function ensureNativePort() {
  if (nativePort) return;
  nativePort = chrome.runtime.connectNative(NATIVE_HOST);
  nativePort.onMessage.addListener(handleNativeMessage);
  nativePort.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message;
    nativePort = null;
    if (activeJob) finishWithError(error || "本地识别助手已断开。请重新运行安装脚本。");
  });
}

function handleNativeMessage(message) {
  if (!activeJob || message.jobId !== activeJob.jobId) return;

  if (message.type === "progress") {
    broadcast(message);
    return;
  }

  if (message.type === "resultStart") {
    partialResult = { ...message.data, segments: [] };
    return;
  }

  if (message.type === "resultChunk") {
    if (partialResult) partialResult.segments.push(...(message.segments || []));
    return;
  }

  if (message.type === "resultEnd") {
    if (!partialResult) return finishWithError("本地助手返回了不完整的识别结果。");
    partialResult.text = partialResult.segments.map((item) => item.text).join("\n");
    finishWithResult(partialResult);
    return;
  }

  if (message.type === "result") finishWithResult(message.data);
  if (message.type === "error") finishWithError(message.error || "本地识别失败。", message.details);
}

async function finishWithResult(data) {
  await chrome.storage.local.set({ [STORAGE_KEY]: data });
  broadcast({ type: "result", data });
  activeJob = null;
  partialResult = null;
}

function finishWithError(error, details = "") {
  broadcast({ type: "error", error, details });
  activeJob = null;
  partialResult = null;
}

function cancelAsr() {
  if (!activeJob || !nativePort) return;
  nativePort.postMessage({ action: "cancel", jobId: activeJob.jobId });
  broadcast({ type: "progress", stage: "cancelling", message: "正在取消任务…" });
}

function broadcast(message) {
  for (const port of clients) safePost(port, message);
}

function safePost(port, message) {
  try {
    port.postMessage(message);
  } catch (_error) {
    clients.delete(port);
  }
}

function isYouTubeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(url.hostname);
  } catch (_error) {
    return false;
  }
}
