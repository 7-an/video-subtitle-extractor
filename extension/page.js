(() => {
  if (window.__TUBECAPTION_PAGE__) return;
  window.__TUBECAPTION_PAGE__ = true;

  const REQUEST_SOURCE = "tubecaption-extension";
  const RESPONSE_SOURCE = "tubecaption-page";
  let observedVideoId = parseVideoId(location.href);
  let navigatedBetweenVideos = false;

  window.addEventListener("yt-navigate-finish", noteCurrentVideo);

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (!message || message.source !== REQUEST_SOURCE || !message.requestId) return;

    try {
      let data;
      if (message.action === "getVideo") data = await getVideo();
      else if (message.action === "fetchCaption") data = await fetchCaption(message.payload);
      else throw new Error(`不支持的页面操作：${message.action}`);

      respond(message.requestId, true, data);
    } catch (error) {
      respond(message.requestId, false, null, error.message);
    }
  });

  function respond(requestId, ok, data, error = "") {
    window.postMessage(
      { source: RESPONSE_SOURCE, requestId, ok, data, error },
      window.location.origin
    );
  }

  async function getVideo() {
    const videoId = parseVideoId(location.href);
    if (!videoId) throw new Error("当前页面没有有效的 YouTube 视频 ID。");
    const response = await waitForPlayerResponse(videoId);
    const details = response?.videoDetails || {};
    const rawTracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const tracks = rawTracks.filter((item) => item.baseUrl).map(normalizeTrack);

    return {
      platform: "youtube",
      videoId,
      url: location.href,
      title: details.title || document.title.replace(/\s*-\s*YouTube$/, ""),
      author: details.author || "",
      durationSeconds: Number(details.lengthSeconds) || null,
      tracks
    };
  }

  function findPlayerResponse(videoId) {
    noteCurrentVideo();
    const watch = document.querySelector("ytd-watch-flexy");
    const player = document.querySelector("ytd-player");
    const liveCandidates = [
      watch?.playerResponse,
      watch?.playerData,
      player?.playerResponse
    ].map(parsePlayerResponse).filter(Boolean);
    const initialCandidates = navigatedBetweenVideos ? [] : [
      window.ytInitialPlayerResponse,
      parseLegacyPlayerResponse(),
      ...parseResponsesFromScripts()
    ].map(parsePlayerResponse).filter(Boolean);

    return [...liveCandidates, ...initialCandidates]
      .find((item) => item?.videoDetails?.videoId === videoId) || null;
  }

  async function waitForPlayerResponse(videoId) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = findPlayerResponse(videoId);
      if (response) return response;
      await delay(250);
    }
    throw new Error("YouTube 页面数据正在更新，请稍后重新打开插件。");
  }

  function noteCurrentVideo() {
    const currentVideoId = parseVideoId(location.href);
    if (observedVideoId && currentVideoId && observedVideoId !== currentVideoId) {
      navigatedBetweenVideos = true;
    }
    if (currentVideoId) observedVideoId = currentVideoId;
  }

  function parsePlayerResponse(value) {
    if (!value) return null;
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch (_error) {
      return null;
    }
  }

  function parseLegacyPlayerResponse() {
    const value = window.ytplayer?.config?.args?.player_response;
    if (!value) return null;
    try {
      return typeof value === "string" ? JSON.parse(value) : value;
    } catch (_error) {
      return null;
    }
  }

  function parseResponsesFromScripts() {
    const responses = [];
    for (const script of document.scripts) {
      const text = script.textContent || "";
      for (const marker of ["ytInitialPlayerResponse = ", "ytInitialPlayerResponse="]) {
        const markerIndex = text.indexOf(marker);
        if (markerIndex < 0) continue;
        const start = text.indexOf("{", markerIndex + marker.length);
        const end = findJsonEnd(text, start);
        if (start < 0 || end < 0) continue;
        try {
          responses.push(JSON.parse(text.slice(start, end)));
        } catch (_error) {
          // A later candidate may still contain valid player data.
        }
      }
    }
    return responses;
  }

  function findJsonEnd(text, start) {
    if (start < 0) return -1;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") depth += 1;
      else if (char === "}" && --depth === 0) return index + 1;
    }
    return -1;
  }

  function normalizeTrack(track, index) {
    const label = readText(track.name) || track.languageCode || "未知语言";
    const automatic = track.kind === "asr";
    return {
      id: `${track.languageCode || "und"}-${track.kind || "manual"}-${index}`,
      language: track.languageCode || "und",
      label: automatic ? `${label}（YouTube 自动字幕）` : label,
      source: automatic ? "youtube-auto" : "youtube-manual",
      kind: track.kind || "",
      baseUrl: track.baseUrl
    };
  }

  function readText(node) {
    if (!node) return "";
    if (node.simpleText) return node.simpleText;
    if (Array.isArray(node.runs)) return node.runs.map((run) => run.text || "").join("");
    return "";
  }

  async function fetchCaption(payload) {
    const requestedVideoId = payload?.videoId || "";
    const currentVideoId = parseVideoId(location.href);
    if (!requestedVideoId || requestedVideoId !== currentVideoId) {
      throw new Error("视频页面已经切换，请重新打开插件后再提取。");
    }

    const metadata = await getVideo();
    if (metadata.videoId !== requestedVideoId) {
      throw new Error("播放器数据与当前视频不匹配，请稍后重试。");
    }
    const track = resolveCurrentTrack(payload?.track, metadata.tracks);

    const jsonUrl = new URL(track.baseUrl);
    jsonUrl.searchParams.set("fmt", "json3");
    const jsonResponse = await fetch(jsonUrl, { credentials: "include" });
    if (!jsonResponse.ok) throw new Error(`字幕请求失败：HTTP ${jsonResponse.status}`);

    const body = await jsonResponse.text();
    let segments = parseJson3(body);

    if (!segments.length) {
      const vttUrl = new URL(track.baseUrl);
      vttUrl.searchParams.set("fmt", "vtt");
      const vttResponse = await fetch(vttUrl, { credentials: "include" });
      if (vttResponse.ok) segments = parseVtt(await vttResponse.text());
    }

    if (!segments.length) throw new Error("字幕轨存在，但返回内容为空。");
    return buildResult(metadata, track, segments);
  }

  function resolveCurrentTrack(requested, tracks) {
    if (!requested) throw new Error("没有选择字幕轨。");
    const current = tracks.find((item) => item.id === requested.id)
      || tracks.find((item) => item.language === requested.language && item.kind === requested.kind)
      || tracks.find((item) => item.language === requested.language && item.source === requested.source);
    if (!current?.baseUrl) {
      throw new Error("所选字幕轨已经失效，请重新打开插件后选择。");
    }
    return current;
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function parseJson3(text) {
    try {
      const data = JSON.parse(String(text || "").replace(/^\)\]\}'\s*/, ""));
      return (data.events || []).map((event) => {
        const textValue = (event.segs || []).map((part) => part.utf8 || "").join("")
          .replace(/\n+/g, " ").trim();
        return {
          startSeconds: Number(event.tStartMs || 0) / 1000,
          durationSeconds: Number(event.dDurationMs || 0) / 1000,
          text: textValue
        };
      }).filter((item) => item.text);
    } catch (_error) {
      return [];
    }
  }

  function parseVtt(text) {
    const lines = String(text || "").replace(/\r/g, "").split("\n");
    const segments = [];
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(/(\d{2}:)?(\d{2}):(\d{2})[.,](\d{3})\s+-->\s+(\d{2}:)?(\d{2}):(\d{2})[.,](\d{3})/);
      if (!match) continue;
      const start = parseVttTime(match[1], match[2], match[3], match[4]);
      const end = parseVttTime(match[5], match[6], match[7], match[8]);
      const content = [];
      while (++index < lines.length && lines[index].trim()) content.push(lines[index]);
      const plain = content.join(" ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (plain) segments.push({ startSeconds: start, durationSeconds: end - start, text: plain });
    }
    return segments;
  }

  function parseVttTime(hours, minutes, seconds, milliseconds) {
    return Number(hours?.replace(":", "") || 0) * 3600
      + Number(minutes) * 60 + Number(seconds) + Number(milliseconds) / 1000;
  }

  function buildResult(metadata, track, segments) {
    return {
      platform: "youtube",
      videoId: metadata.videoId,
      url: metadata.url,
      title: metadata.title,
      author: metadata.author,
      selectedTrack: {
        id: track.id,
        language: track.language,
        label: track.label,
        source: track.source
      },
      segments,
      text: segments.map((item) => item.text).join("\n"),
      warnings: []
    };
  }

  function parseVideoId(input) {
    const url = new URL(input, location.href);
    if (url.pathname.startsWith("/shorts/")) return url.pathname.split("/")[2] || "";
    return url.searchParams.get("v") || "";
  }
})();
