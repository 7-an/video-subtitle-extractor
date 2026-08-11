const state = {
  tab: null,
  video: null,
  result: null,
  running: false
};

const nodes = {
  statusBadge: document.getElementById("statusBadge"),
  videoTitle: document.getElementById("videoTitle"),
  videoMeta: document.getElementById("videoMeta"),
  trackSelect: document.getElementById("trackSelect"),
  extractButton: document.getElementById("extractButton"),
  asrButton: document.getElementById("asrButton"),
  cancelButton: document.getElementById("cancelButton"),
  message: document.getElementById("message"),
  progress: document.getElementById("progress"),
  resultPanel: document.getElementById("resultPanel"),
  resultLabel: document.getElementById("resultLabel"),
  segmentCount: document.getElementById("segmentCount"),
  preview: document.getElementById("preview")
};

const background = chrome.runtime.connect({ name: "tubecaption-popup" });
background.onMessage.addListener(handleBackgroundMessage);

nodes.extractButton.addEventListener("click", extractExistingCaption);
nodes.asrButton.addEventListener("click", startAsr);
nodes.cancelButton.addEventListener("click", () => background.postMessage({ type: "cancelAsr" }));
document.querySelectorAll("[data-format]").forEach((button) => {
  button.addEventListener("click", () => downloadResult(button.dataset.format));
});

initialize();

async function initialize() {
  clearResult();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab;

  if (!isSupportedUrl(tab?.url)) {
    setStatus("不支持", "error");
    nodes.videoTitle.textContent = "请打开 YouTube 视频";
    setMessage("支持普通视频和 Shorts 页面。", true);
    return;
  }

  try {
    const response = await sendToTab("TCL_GET_VIDEO");
    if (!response.ok) throw new Error(response.error);
    state.video = response.data;
    renderVideo(response.data);
    background.postMessage({ type: "getState", videoId: response.data.videoId });
  } catch (error) {
    clearResult();
    const fallbackVideoId = parseVideoId(tab?.url);
    state.video = { videoId: fallbackVideoId, tracks: [] };
    setStatus("需刷新", "error");
    nodes.videoTitle.textContent = cleanTitle(tab.title || "YouTube 视频");
    nodes.asrButton.disabled = false;
    if (fallbackVideoId) background.postMessage({ type: "getState", videoId: fallbackVideoId });
    setMessage(`页面连接失败：${error.message} 请刷新视频页面后重试。`, true);
  }
}

function renderVideo(video) {
  const tracks = video.tracks || [];
  setStatus("可处理", "ok");
  nodes.videoTitle.textContent = video.title || "YouTube 视频";
  nodes.videoMeta.textContent = [video.author, formatDuration(video.durationSeconds)].filter(Boolean).join(" · ");
  nodes.trackSelect.innerHTML = "";

  if (tracks.length) {
    for (const track of tracks) {
      const option = document.createElement("option");
      option.value = track.id;
      option.textContent = track.label;
      nodes.trackSelect.appendChild(option);
    }
    nodes.trackSelect.disabled = false;
    nodes.extractButton.disabled = false;
    setMessage(`检测到 ${tracks.length} 条字幕轨；也可以改用本地语音识别。`);
  } else {
    const option = document.createElement("option");
    option.textContent = "该视频没有字幕轨";
    nodes.trackSelect.appendChild(option);
    nodes.trackSelect.disabled = true;
    nodes.extractButton.disabled = true;
    setMessage("没有检测到 YouTube 字幕轨，可使用本地 Whisper 生成字幕。", false);
  }

  nodes.asrButton.disabled = false;
}

async function extractExistingCaption() {
  const track = state.video?.tracks?.find((item) => item.id === nodes.trackSelect.value);
  if (!track) return setMessage("请先选择字幕轨。", true);

  clearResult();
  setWorking(true, "正在读取 YouTube 字幕…", false);
  try {
    const response = await sendToTab("TCL_FETCH_CAPTION", {
      track,
      videoId: state.video.videoId
    });
    if (!response.ok) throw new Error(response.error);
    if (!showResult(response.data)) throw new Error("字幕结果与当前视频不匹配，请重试。");
    setMessage("已有字幕提取完成。");
  } catch (error) {
    clearResult();
    setMessage(error.message, true);
  } finally {
    setWorking(false);
  }
}

function startAsr() {
  if (!state.tab?.url) return;
  clearResult();
  state.running = true;
  setWorking(true, "正在连接本地识别助手…", true);
  background.postMessage({
    type: "startAsr",
    url: state.tab.url,
    videoId: state.video?.videoId || "",
    language: "auto",
    model: "small"
  });
}

function handleBackgroundMessage(message) {
  if (!isMessageForCurrentVideo(message)) return;

  if (message.type === "jobState" && message.status === "running") {
    state.running = true;
    setWorking(true, "本地识别任务仍在运行…", true);
  }

  if (message.type === "progress") {
    state.running = true;
    setWorking(true, message.message || "正在生成字幕…", true);
  }

  if (message.type === "cachedResult" && !state.result) showResult(message.data, true);

  if (message.type === "result") {
    state.running = false;
    setWorking(false);
    if (showResult(message.data)) {
      setMessage("本地字幕生成完成；临时音频已删除。");
    } else {
      setMessage("本地助手返回了无效或不匹配的字幕结果。", true);
    }
  }

  if (message.type === "error") {
    state.running = false;
    setWorking(false);
    const extra = message.details ? ` ${message.details}` : "";
    setMessage(`${message.error}${extra}`, true);
  }
}

function showResult(result, cached = false) {
  if (!result?.segments?.length || result.videoId !== state.video?.videoId) {
    clearResult();
    return false;
  }
  state.result = result;
  nodes.resultPanel.hidden = false;
  nodes.resultLabel.textContent = result.selectedTrack?.label || "字幕结果";
  nodes.segmentCount.textContent = `${result.segments.length} 段`;
  nodes.preview.textContent = result.segments.slice(0, 80)
    .map((item) => `[${formatClock(item.startSeconds)}] ${item.text}`)
    .join("\n");
  if (cached) setMessage("已恢复上次生成的字幕结果。");
  return true;
}

function clearResult() {
  state.result = null;
  nodes.resultPanel.hidden = true;
  nodes.resultLabel.textContent = "字幕结果";
  nodes.segmentCount.textContent = "";
  nodes.preview.textContent = "";
}

function isMessageForCurrentVideo(message) {
  const videoId = message?.videoId || message?.data?.videoId || "";
  return !videoId || videoId === state.video?.videoId;
}

function setWorking(working, text = "", localAsr = false) {
  nodes.extractButton.disabled = working || !(state.video?.tracks?.length);
  nodes.asrButton.disabled = working;
  nodes.cancelButton.hidden = !(working && localAsr);
  nodes.progress.hidden = !working;
  if (text) setMessage(text);
}

function setStatus(text, variant = "") {
  nodes.statusBadge.textContent = text;
  nodes.statusBadge.className = `badge ${variant}`.trim();
}

function setMessage(text, error = false) {
  nodes.message.textContent = text;
  nodes.message.classList.toggle("error", error);
}

function sendToTab(type, payload = {}) {
  return chrome.tabs.sendMessage(state.tab.id, { type, payload });
}

function downloadResult(format) {
  if (!state.result) return;
  const builders = {
    md: buildMarkdown,
    srt: buildSrt,
    txt: (result) => `${result.text}\n`,
    json: (result) => JSON.stringify(result, null, 2)
  };
  const mime = {
    md: "text/markdown",
    srt: "application/x-subrip",
    txt: "text/plain",
    json: "application/json"
  }[format];
  const content = builders[format](state.result);
  const objectUrl = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  chrome.downloads.download({
    url: objectUrl,
    filename: `${safeFilename(state.result.title)}.${format}`,
    saveAs: true
  }, () => setTimeout(() => URL.revokeObjectURL(objectUrl), 1000));
}

function buildMarkdown(result) {
  const lines = [
    "---",
    `source: ${JSON.stringify(result.url || "")}`,
    `video_id: ${JSON.stringify(result.videoId || "")}`,
    `subtitle_source: ${JSON.stringify(result.selectedTrack?.source || "unknown")}`,
    `subtitle_language: ${JSON.stringify(result.selectedTrack?.language || "unknown")}`,
    "---", "", `# ${result.title || "YouTube Transcript"}`, "", "## Transcript", ""
  ];
  for (const segment of result.segments) {
    lines.push(`[${formatClock(segment.startSeconds)}] ${segment.text}`);
  }
  if (result.warnings?.length) lines.push("", "## Notes", "", ...result.warnings.map((item) => `- ${item}`));
  return `${lines.join("\n")}\n`;
}

function buildSrt(result) {
  return `${result.segments.map((segment, index, all) => {
    const start = Number(segment.startSeconds) || 0;
    const duration = Number(segment.durationSeconds);
    const next = Number(all[index + 1]?.startSeconds);
    const end = duration > 0 ? start + duration : next > start ? next : start + 2;
    return `${index + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${segment.text}`;
  }).join("\n\n")}\n`;
}

function formatClock(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = value % 60;
  return hours ? `${pad(hours)}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
}

function formatSrtTime(seconds) {
  const milliseconds = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor((milliseconds % 3600000) / 60000);
  const rest = Math.floor((milliseconds % 60000) / 1000);
  return `${pad(hours)}:${pad(minutes)}:${pad(rest)},${String(milliseconds % 1000).padStart(3, "0")}`;
}

function formatDuration(seconds) {
  if (!Number(seconds)) return "";
  return formatClock(seconds);
}

function pad(value) { return String(value).padStart(2, "0"); }
function cleanTitle(value) { return String(value).replace(/\s*-\s*YouTube$/, "").trim(); }
function safeFilename(value) {
  return String(value || "youtube-transcript").replace(/[\\/:*?"<>|]/g, "_").slice(0, 90);
}
function isSupportedUrl(value) {
  try {
    const url = new URL(value);
    return ["www.youtube.com", "m.youtube.com"].includes(url.hostname)
      && (url.pathname === "/watch" || url.pathname.startsWith("/shorts/"));
  } catch (_error) {
    return false;
  }
}

function parseVideoId(value) {
  try {
    const url = new URL(value);
    if (url.pathname.startsWith("/shorts/")) return url.pathname.split("/")[2] || "";
    return url.searchParams.get("v") || "";
  } catch (_error) {
    return "";
  }
}
