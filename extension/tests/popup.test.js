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

test("clears a previous result when the next result is empty or mismatched", async () => {
  const nodes = new Map();
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
    postMessage() {}
  };
  const chrome = {
    runtime: { connect() { return background; } },
    tabs: {
      async query() { return [{ id: 1, url: "https://example.com", title: "Example" }]; },
      async sendMessage() { return { ok: false, error: "not used" }; }
    },
    downloads: { download() {} }
  };
  const context = vm.createContext({ Blob, URL, chrome, console, document, setTimeout });
  vm.runInContext(SOURCE, context, { filename: "popup.js" });
  await new Promise((resolve) => setImmediate(resolve));
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
