const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "page.js"), "utf8");

function playerResponse(videoId, baseUrl = "") {
  const captionTracks = baseUrl ? [{
    baseUrl,
    languageCode: "en",
    kind: "asr",
    name: { simpleText: "English" }
  }] : [];
  return {
    videoDetails: { videoId, title: `Video ${videoId}`, author: "Tester", lengthSeconds: "60" },
    captions: { playerCaptionsTracklistRenderer: { captionTracks } }
  };
}

function createBridge({ href, liveResponse, initialResponse, fetchImpl }) {
  let currentHref = href;
  const watch = { playerResponse: liveResponse, playerData: null };
  const listeners = new Map();
  const responses = [];
  const location = {
    get href() { return currentHref; },
    set href(value) { currentHref = value; },
    get origin() { return new URL(currentHref).origin; }
  };
  const window = {
    location,
    ytInitialPlayerResponse: initialResponse,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    postMessage(message) {
      responses.push(message);
    }
  };
  const document = {
    title: "Test - YouTube",
    scripts: [],
    querySelector(selector) {
      if (selector === "ytd-watch-flexy") return watch;
      return null;
    }
  };
  const context = vm.createContext({
    URL,
    console,
    document,
    fetch: fetchImpl || (() => { throw new Error("Unexpected fetch"); }),
    location,
    queueMicrotask,
    setTimeout(callback) {
      queueMicrotask(callback);
      return 1;
    },
    window
  });
  vm.runInContext(SOURCE, context, { filename: "page.js" });

  async function request(action, payload = {}) {
    const requestId = `${action}-${responses.length}`;
    for (const listener of listeners.get("message") || []) {
      listener({
        source: window,
        origin: location.origin,
        data: { source: "tubecaption-extension", requestId, action, payload }
      });
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = responses.find((item) => item.requestId === requestId);
      if (response) return response;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error(`No response for ${action}`);
  }

  function navigate(url, response) {
    location.href = url;
    watch.playerResponse = response;
    for (const listener of listeners.get("yt-navigate-finish") || []) listener();
  }

  return { navigate, request };
}

test("re-resolves the selected track from the current player response", async () => {
  const requestedUrls = [];
  const freshUrl = "https://www.youtube.com/api/timedtext?token=fresh";
  const bridge = createBridge({
    href: "https://www.youtube.com/watch?v=video-a",
    liveResponse: playerResponse("video-a", freshUrl),
    initialResponse: playerResponse("video-a", "https://www.youtube.com/api/timedtext?token=old"),
    fetchImpl: async (url) => {
      requestedUrls.push(String(url));
      return {
        ok: true,
        text: async () => JSON.stringify({
          events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: "fresh caption" }] }]
        })
      };
    }
  });

  const response = await bridge.request("fetchCaption", {
    videoId: "video-a",
    track: {
      id: "en-asr-0",
      language: "en",
      kind: "asr",
      source: "youtube-auto",
      baseUrl: "https://www.youtube.com/api/timedtext?token=stale-payload"
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.data.videoId, "video-a");
  assert.equal(response.data.text, "fresh caption");
  assert.match(requestedUrls[0], /token=fresh/);
  assert.doesNotMatch(requestedUrls[0], /stale-payload/);
});

test("does not fall back to the initial response after SPA navigation", async () => {
  const initial = playerResponse("video-a", "https://www.youtube.com/api/timedtext?token=old");
  const bridge = createBridge({
    href: "https://www.youtube.com/watch?v=video-a",
    liveResponse: initial,
    initialResponse: initial
  });

  assert.equal((await bridge.request("getVideo")).ok, true);
  bridge.navigate("https://www.youtube.com/watch?v=video-b", playerResponse("video-b"));
  assert.equal((await bridge.request("getVideo")).data.videoId, "video-b");
  bridge.navigate("https://www.youtube.com/watch?v=video-a", playerResponse("video-b"));

  const response = await bridge.request("getVideo");
  assert.equal(response.ok, false);
  assert.match(response.error, /页面数据正在更新/);
});

test("rejects a caption request after the page changes videos", async () => {
  let fetched = false;
  const bridge = createBridge({
    href: "https://www.youtube.com/watch?v=video-a",
    liveResponse: playerResponse("video-a"),
    initialResponse: playerResponse("video-a"),
    fetchImpl: async () => {
      fetched = true;
      throw new Error("should not fetch");
    }
  });

  const response = await bridge.request("fetchCaption", {
    videoId: "video-b",
    track: { id: "en-asr-0", language: "en", kind: "asr" }
  });
  assert.equal(response.ok, false);
  assert.match(response.error, /页面已经切换/);
  assert.equal(fetched, false);
});
