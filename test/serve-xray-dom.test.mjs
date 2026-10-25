import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = path.join(__dirname, "..", "frontend", "serve", "app.js");

/**
 * The Context X-Ray pane's load path, end to end: `loadXray` fetches
 * `/api/session/<id>/context/<seq>` and must put the rendered table into
 * `#xray-view`.
 *
 * `test/serve-frontend.test.mjs` only covers pure markup generators, and the
 * X-Ray table has one: `drawXray`. That is exactly how this pane broke without a
 * test noticing — `drawXray` kept working, `loadXray` simply stopped calling it,
 * and the view sat on its "loading…" skeleton forever while the status line
 * above it reported a successful fetch. Only driving the fetch→render path can
 * catch a renderer that is correct but orphaned.
 *
 * The DOM here is the same deliberately dumb shim as the sibling test, plus a
 * registry so that the two elements `loadXray` writes to (`#xray-view`,
 * `#xray-status`) are real objects whose state survives the call.
 */
function loadApp({ fetchImpl }) {
  const src = fs.readFileSync(APP_JS, "utf8");

  const el = () => ({
    innerHTML: "",
    textContent: "",
    hidden: false,
    style: {},
    className: "",
    value: "",
    attrs: {},
    classList: {
      toggle() {},
      add() {},
      remove() {},
      contains: () => false,
    },
    addEventListener() {},
    removeEventListener() {},
    setAttribute(n, v) {
      this.attrs[n] = String(v);
    },
    getAttribute(n) {
      return n in this.attrs ? this.attrs[n] : null;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    appendChild() {},
    remove() {},
    scrollIntoView() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
  });

  const byId = new Map();
  const document = {
    getElementById: (id) => {
      if (!byId.has(id)) byId.set(id, el());
      return byId.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: el,
    addEventListener() {},
    removeEventListener() {},
    body: el(),
    documentElement: el(),
  };

  const sandbox = {
    document,
    location: { hash: "#sessions", replace() {} },
    URLSearchParams,
    URL,
    TextEncoder,
    TextDecoder,
    history: { replaceState() {} },
    fetch: fetchImpl,
    EventSource: function () {
      return { addEventListener() {}, close() {} };
    },
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    console,
    Date,
    JSON,
    Math,
    module: { exports: {} },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.addEventListener = () => {};

  vm.createContext(sandbox);
  new vm.Script(src, { filename: "app.js" }).runInContext(sandbox);
  return { app: sandbox.module.exports, byId };
}

/**
 * The shape `/api/session/<id>/context/<seq>` returns (see `ContextXray` in
 * src/context/xray.ts), trimmed to one segment per bucket. Field names are the
 * ones `drawXray` reads; a renamed field there should fail here.
 */
const XRAY = {
  seq: 3,
  model: "claude-opus-5",
  promptHash: "abc",
  totalChars: 4000,
  totalApproxTokens: 1000,
  wirePromptTokens: 950,
  buckets: [
    { bucket: "system", label: "system", chars: 400, approxTokens: 100, segments: 1 },
    { bucket: "tools", label: "tools", chars: 2400, approxTokens: 600, segments: 1 },
    { bucket: "user", label: "user", chars: 1200, approxTokens: 300, segments: 1 },
  ],
  segments: [
    { bucket: "system", id: "s1", chars: 400, approxTokens: 100, preview: "You are…" },
    { bucket: "tools", id: "t1", chars: 2400, approxTokens: 600, preview: '{"name":"Bash"' },
    { bucket: "user", id: "u1", chars: 1200, approxTokens: 300, preview: "fix the bug" },
  ],
  delta: {
    prevSeq: 2,
    newCount: 1,
    carriedCount: 2,
    droppedCount: 0,
    prevBuckets: [
      { bucket: "system", label: "system", chars: 400, approxTokens: 100, segments: 1 },
      { bucket: "tools", label: "tools", chars: 2400, approxTokens: 600, segments: 1 },
    ],
    items: [],
  },
};

/** A fetch that answers the context route with XRAY and never resolves otherwise. */
function fetchFor(payload) {
  const calls = [];
  const impl = (url) => {
    calls.push(String(url));
    if (/\/context\/\d+$/.test(String(url))) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(payload),
      });
    }
    return new Promise(() => {});
  };
  return { impl, calls };
}

/** Let the fetch→then chain drain. */
const settle = () => new Promise((r) => setTimeout(r, 0));

test("the app exposes loadXray and drawXray to Node", () => {
  const { app } = loadApp({ fetchImpl: () => new Promise(() => {}) });
  assert.equal(typeof app.loadXray, "function");
  assert.equal(typeof app.drawXray, "function");
});

test("drawXray on its own renders a stack with one row per bucket", () => {
  const { app } = loadApp({ fetchImpl: () => new Promise(() => {}) });
  const html = app.drawXray(XRAY);
  assert.match(html, /class="xray-stack/);
  for (const b of XRAY.buckets) assert.match(html, new RegExp("bucket-" + b.bucket));
});

test("loadXray puts the rendered table into #xray-view when the fetch succeeds", async () => {
  const { impl, calls } = fetchFor(XRAY);
  const { app, byId } = loadApp({ fetchImpl: impl });

  app.loadXray("claude:test", 3);
  const view = byId.get("xray-view");
  const status = byId.get("xray-status");
  assert.ok(view, "loadXray must look up #xray-view");
  // Synchronously: the skeleton is up, the pane records what it is showing.
  assert.match(view.innerHTML, /loading…/);
  assert.equal(view.getAttribute("data-showing"), "3");

  await settle();
  await settle();

  assert.ok(
    calls.some((u) => u.endsWith("/api/session/claude%3Atest/context/3")),
    "fetches the context route for that seq: " + JSON.stringify(calls),
  );
  // The status line reports the totals…
  assert.match(status.textContent, /tokens/);
  // …and the view holds the table, not the skeleton it started with.
  assert.doesNotMatch(view.innerHTML, /skel-row/, "skeleton must be replaced");
  assert.match(view.innerHTML, /class="xray-stack/, "drawXray output must land in the view");
  assert.match(view.innerHTML, /API #3/, "the head names the call");
  // Segment rows carry the inspector hook the click handler dispatches on.
  assert.match(view.innerHTML, /data-inspect="seg:0"/);
});

test("a failed fetch replaces the skeleton with the error, not a blank", async () => {
  const impl = () =>
    Promise.resolve({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: "No request body for seq 9." }),
    });
  const { app, byId } = loadApp({ fetchImpl: impl });
  app.loadXray("claude:test", 9);
  await settle();
  await settle();
  const view = byId.get("xray-view");
  assert.match(view.innerHTML, /context unavailable/);
  assert.match(view.innerHTML, /No request body for seq 9\./);
  assert.equal(byId.get("xray-status").textContent, "error");
});
