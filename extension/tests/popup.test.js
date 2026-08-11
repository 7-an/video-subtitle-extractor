const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");

function node() {
  return {
    className: "",
    classList: { toggle() {} },
    disabled: false,
    hidden: false,
    innerHTML: "",
    textContent: "",
    value: "",
    addEventListener() {},
    appendChild() {}
  };
}

async function createPopup(stored = {}) {
  const nodes = new Map();
  const backgroundMessages = [];
  const storageWrites = [];
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, node());
      return nodes.get(id);
    },
    querySelectorAll() { return []; },
    createElement() { return node(); }
  };
  const background = {
    onMessage: { addListener() {} },
    postMessage(message) { backgroundMessages.push(message); }
  };
  const chrome = {
    runtime: { connect() { return background; } },
    tabs: {
      async query() { return [{ id: 1, url: "https://example.com", title: "Example" }]; },
      async sendMessage() { return { ok: false, error: "not used" }; }
    },
    downloads: { download() {} },
    storage: {
      local: {
        async get() { return stored; },
        async set(value) { storageWrites.push(value); }
      }
    }
  };
  const context = vm.createContext({ Blob, URL, chrome, console, document, setTimeout });
  vm.runInContext(SOURCE, context, { filename: "popup.js" });
  await new Promise((resolve) => setImmediate(resolve));
  return { backgroundMessages, context, nodes, storageWrites };
}

test("clears a previous result when the next result is empty or mismatched", async () => {
  const { context, nodes } = await createPopup();
  vm.runInContext('state.video = { videoId: "video-a", tracks: [] };', context);

  const valid = {
    videoId: "video-a",
    selectedTrack: { label: "English" },
    segments: [{ startSeconds: 0, text: "old caption" }]
  };
  assert.equal(context.showResult(valid), true);
  assert.equal(nodes.get("resultPanel").hidden, false);
  assert.match(nodes.get("preview").textContent, /old caption/);

  assert.equal(context.showResult({ videoId: "video-a", segments: [] }), false);
  assert.equal(nodes.get("resultPanel").hidden, true);
  assert.equal(nodes.get("preview").textContent, "");

  assert.equal(context.showResult({ ...valid, videoId: "video-b" }), false);
  assert.equal(nodes.get("resultPanel").hidden, true);
});

test("restores and sends the selected ASR model and language", async () => {
  const { backgroundMessages, context, nodes } = await createPopup({
    tubeCaptionAsrModel: "medium",
    tubeCaptionAsrLanguage: "zh"
  });
  vm.runInContext(`
    state.tab = { id: 1, url: "https://www.youtube.com/watch?v=video-a" };
    state.video = { videoId: "video-a", tracks: [] };
  `, context);

  assert.equal(nodes.get("modelSelect").value, "medium");
  assert.equal(nodes.get("languageSelect").value, "zh");
  assert.match(nodes.get("modelHint").textContent, /准确度优先/);

  context.startAsr();
  const request = backgroundMessages.find((item) => item.type === "startAsr");
  assert.equal(request.model, "medium");
  assert.equal(request.language, "zh");
  assert.equal(request.videoId, "video-a");
});
