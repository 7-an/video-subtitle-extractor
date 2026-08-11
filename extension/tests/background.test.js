const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

test("restores cached subtitles only for the current video", async () => {
  let connectListener;
  const cached = { videoId: "video-a", segments: [{ text: "caption" }] };
  const chrome = {
    runtime: {
      onConnect: { addListener(listener) { connectListener = listener; } },
      connectNative() { throw new Error("not used"); }
    },
    storage: {
      local: {
        async get() { return { tubeCaptionLastResult: cached }; },
        async set() {}
      }
    }
  };
  vm.runInNewContext(SOURCE, { URL, chrome, console, crypto }, { filename: "background.js" });

  const posted = [];
  let messageListener;
  const port = {
    name: "tubecaption-popup",
    onDisconnect: { addListener() {} },
    onMessage: { addListener(listener) { messageListener = listener; } },
    postMessage(message) { posted.push(message); }
  };
  connectListener(port);
  assert.deepEqual(posted, []);

  messageListener({ type: "getState", videoId: "video-b" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(posted, []);

  messageListener({ type: "getState", videoId: "video-a" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, "cachedResult");
  assert.equal(posted[0].data.videoId, "video-a");
});
