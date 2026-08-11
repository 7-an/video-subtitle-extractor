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
    if (message?.type === "getState") sendState(port, message.videoId);
  });
});

function sendState(port, videoId) {
  if (!videoId) return;
  if (activeJob?.videoId === videoId) {
    safePost(port, {
      type: "jobState",
      status: "running",
      jobId: activeJob.jobId,
      videoId
    });
    return;
  }
  chrome.storage.local.get(STORAGE_KEY).then((stored) => {
    const result = stored[STORAGE_KEY];
    if (result?.videoId === videoId) {
      safePost(port, { type: "cachedResult", videoId, data: result });
    }
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

  const videoId = parseYouTubeVideoId(message.url);
  if (!videoId || (message.videoId && message.videoId !== videoId)) {
    broadcast({ type: "error", error: "视频地址与当前页面不匹配。", videoId: message.videoId || videoId });
    return;
  }

  const jobId = crypto.randomUUID();
  activeJob = { jobId, url: message.url, videoId };
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
    broadcast({
      type: "progress",
      jobId,
      videoId,
      stage: "starting",
      message: "正在启动本地识别助手…"
    });
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
    broadcast({ ...message, videoId: activeJob.videoId });
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
  const videoId = activeJob?.videoId || data?.videoId || "";
  if (!data?.segments?.length || data.videoId !== videoId) {
    finishWithError("本地助手返回了空结果或其他视频的结果。");
    return;
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: data });
  broadcast({ type: "result", videoId, data });
  activeJob = null;
  partialResult = null;
}

function finishWithError(error, details = "") {
  const videoId = activeJob?.videoId || "";
  broadcast({ type: "error", videoId, error, details });
  activeJob = null;
  partialResult = null;
}

function cancelAsr() {
  if (!activeJob || !nativePort) return;
  nativePort.postMessage({ action: "cancel", jobId: activeJob.jobId });
  broadcast({
    type: "progress",
    videoId: activeJob.videoId,
    stage: "cancelling",
    message: "正在取消任务…"
  });
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

function parseYouTubeVideoId(value) {
  try {
    const url = new URL(value);
    if (url.hostname === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] || "";
    if (url.pathname.startsWith("/shorts/")) return url.pathname.split("/")[2] || "";
    return url.searchParams.get("v") || "";
  } catch (_error) {
    return "";
  }
}
