import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = path.join(__dirname, "..", "frontend", "serve", "app.js");

/**
 * The trace filter PASS, driven against a constructed element graph.
 *
 * `test/serve-frontend.test.mjs` covers the model and the markup. This covers the
 * thing neither can: `applyTurnFilters` walks a live DOM by selector and writes
 * `hidden`, so its correctness depends on selectors matching markup that is
 * generated somewhere else entirely. A renamed attribute breaks it silently — the
 * view simply stops filtering, which looks like "the filter does nothing" rather
 * than like an error.
 *
 * The DOM here is small and honest about it: enough selector support for the
 * queries this function actually issues (`.turn`, `[data-ev-kind]`,
 * `[data-trace-node]`, `[data-trace-kinds]`, `#trace-count`, `.ribbon-bar`), and
 * nothing else. It is a stand-in for a browser, never a claim to be one.
 */
class El {
  constructor(spec = {}) {
    this.attrs = { ...(spec.attrs || {}) };
    this.classes = new Set(spec.classes || []);
    this.id = spec.id || "";
    this.children = [];
    this.hidden = false;
    this.textContent = "";
    this.parent = null;
    const self = this;
    this.classList = {
      add: (c) => self.classes.add(c),
      remove: (c) => self.classes.delete(c),
      contains: (c) => self.classes.has(c),
      toggle: (c, on) => (on ? self.classes.add(c) : self.classes.delete(c)),
    };
    this.style = {};
    // The IIFE binds listeners to whatever it finds at load; inert is enough,
    // since the tests call the exported pass directly rather than dispatching.
    this.addEventListener = () => {};
    this.removeEventListener = () => {};
    this.scrollIntoView = () => {};
    this.remove = () => {};
    this.getBoundingClientRect = () => ({ top: 0, left: 0, width: 0, height: 0 });
  }
  append(...kids) {
    for (const k of kids) {
      k.parent = this;
      this.children.push(k);
    }
    return this;
  }
  get parentNode() {
    return this.parent;
  }
  getAttribute(n) {
    return n in this.attrs ? String(this.attrs[n]) : null;
  }
  hasAttribute(n) {
    return n in this.attrs;
  }
  setAttribute(n, v) {
    this.attrs[n] = String(v);
  }
  descendants() {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  /**
   * Compound simple selectors only: `.turn`, `#id`, `[a]`, `[a="v"]`, and any
   * concatenation of them (`.turn[data-turn="2"]` — which `setTurnExpanded`
   * issues, and which a class-only matcher silently never matched).
   * Descendant/child combinators are deliberately unsupported: nothing in the
   * filter pass uses one, and pretending to support it would hide the day
   * something starts to.
   */
  matches(sel) {
    const parts = sel.match(/\.[-\w]+|#[-\w]+|\[[^\]]+\]/g);
    if (!parts || parts.join("") !== sel) {
      throw new Error("test DOM does not implement selector: " + sel);
    }
    return parts.every((p) => {
      if (p[0] === ".") return this.classes.has(p.slice(1));
      if (p[0] === "#") return this.id === p.slice(1);
      const eq = p.match(/^\[([^=\]]+)="([^"]*)"\]$/);
      if (eq) return this.getAttribute(eq[1]) === eq[2];
      const has = p.match(/^\[([^=\]]+)\]$/);
      if (has) return this.getAttribute(has[1]) !== null;
      throw new Error("test DOM cannot parse selector part: " + p);
    });
  }
  querySelectorAll(sel) {
    return this.descendants().filter((n) => n.matches(sel));
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  closest(sel) {
    let n = this;
    while (n) {
      if (n.matches(sel)) return n;
      n = n.parent;
    }
    return null;
  }
}

function loadApp() {
  const root = new El({ id: "root" });
  const document = {
    _root: root,
    /**
     * Real element if the test built one, otherwise a throwaway.
     *
     * Returning null instead would break the IIFE at load — `var view =
     * getElementById("view")` is line 6 and `route()` writes to it immediately.
     * The throwaway also absorbs the ribbon lookups this pass makes, which have
     * nothing to do with what is being asserted here.
     */
    getElementById(id) {
      return root.descendants().find((n) => n.id === id) || new El({ id });
    },
    querySelector: (s) => root.querySelector(s),
    querySelectorAll: (s) => root.querySelectorAll(s),
    createElement: () => new El(),
    addEventListener() {},
    body: root,
    documentElement: root,
  };
  const sandbox = {
    document,
    location: { hash: "#sessions", replace() {} },
    history: { replaceState() {} },
    URLSearchParams,
    URL,
    fetch: () => new Promise(() => {}),
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
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.addEventListener = () => {};
  vm.createContext(sandbox);
  new vm.Script(fs.readFileSync(APP_JS, "utf8"), { filename: "app.js" }).runInContext(sandbox);
  return { app: sandbox.module.exports, root };
}

/** An event row as `turnSpineHtml` emits it. */
function ev(kind, text, extra = {}) {
  return new El({
    classes: ["turn-ev", "ev-" + kind],
    attrs: { "data-ev-kind": kind, "data-trace-text": text.toLowerCase(), ...extra },
  });
}

/** A turn row with nested events, as the Turns grain emits it. */
function turn(seq, events, opts = {}) {
  const t = new El({
    classes: ["turn"],
    attrs: {
      "data-turn": String(seq),
      "data-from": String(opts.from ?? 0),
      "data-to": String(opts.to ?? 100),
      "data-trace-text": String(opts.summary || "").toLowerCase(),
    },
  });
  // The caret and the events box are what `setTurnExpanded` reaches for.
  t.append(new El({ classes: ["turn-caret"] }));
  const box = new El({ classes: ["turn-events"] });
  box.hidden = true;
  box.append(...events);
  t.append(box);
  return t;
}

function build() {
  const { app, root } = loadApp();
  const count = new El({ id: "trace-count" });
  const t1 = turn(1, [
    ev("prompt", "please rebase the branch"),
    ev("tool_call", "Bash git rebase main"),
    ev("tool_result", "Successfully rebased"),
  ], { summary: "rebase the branch", from: 0, to: 100 });
  const t2 = turn(2, [
    ev("reply", "all done"),
    ev("hook", "PreToolUse guard"),
  ], { summary: "all done", from: 200, to: 300 });
  // Stream grain rows and Steps grain cards, present at the same time — the pane
  // renders all three grains and hides two with CSS, so the pass must handle
  // every one of them being in the document at once.
  const nodeA = new El({
    classes: ["flow-node"],
    attrs: {
      "data-trace-node": "1",
      "data-trace-kind": "prompt",
      "data-trace-text": "please rebase the branch",
    },
  });
  const nodeB = new El({
    classes: ["flow-node"],
    attrs: {
      "data-trace-node": "1",
      "data-trace-kind": "tool_call",
      "data-trace-text": "bash git rebase main",
    },
  });
  const stepCard = new El({
    classes: ["step"],
    attrs: {
      "data-trace-kinds": "reply tool_call tool_result",
      "data-trace-text": "all done bash rebase",
    },
  });
  const promptStep = new El({
    classes: ["step"],
    attrs: { "data-trace-kinds": "prompt", "data-trace-text": "please rebase the branch" },
  });
  root.append(count, t1, t2, nodeA, nodeB, stepCard, promptStep);
  return { app, root, count, t1, t2, nodeA, nodeB, stepCard, promptStep };
}

const visible = (el) => el.hidden === false;

test("no filter shows every turn, every event, every grain", () => {
  const d = build();
  d.app.setFilter([], "");
  d.app.applyTurnFilters();
  assert.ok(visible(d.t1) && visible(d.t2));
  assert.ok(d.t1.querySelectorAll("[data-ev-kind]").every(visible));
  assert.ok(visible(d.nodeA) && visible(d.nodeB));
  assert.ok(visible(d.stepCard) && visible(d.promptStep));
  assert.match(d.count.textContent, /2 turns · 5 events/);
});

test("messages only hides tool calls and results in every grain at once", () => {
  const d = build();
  d.app.setFilter(["prompt", "reply", "thinking"], "");
  d.app.applyTurnFilters();

  // Turns grain: the message events survive, the tool events do not.
  const kindOf = (e) => e.getAttribute("data-ev-kind");
  const shown = d.t1
    .querySelectorAll("[data-ev-kind]")
    .filter(visible)
    .map(kindOf);
  assert.deepEqual(Array.from(shown), ["prompt"]);

  // Stream grain: same predicate, different markup.
  assert.ok(visible(d.nodeA), "prompt node hidden by a messages filter");
  assert.ok(!visible(d.nodeB), "tool_call node survived a messages filter");

  // Steps grain: a step is a bundle, so it survives if ANY of its kinds shows.
  assert.ok(visible(d.stepCard), "a step containing a reply was hidden");
  assert.ok(visible(d.promptStep));

  assert.match(d.count.textContent, /2 of 5 events/);
  assert.ok(d.count.classes.has("on"), "the count must mark itself as filtered");
});

test("a turn with no surviving event is hidden entirely", () => {
  const d = build();
  // Only turn 2 has a hook; turn 1 has none, and its summary does not match.
  d.app.setFilter(["hook"], "");
  d.app.applyTurnFilters();
  assert.ok(!visible(d.t1), "a turn with nothing left to show stayed visible");
  assert.ok(visible(d.t2));
});

test("filtering to a kind auto-expands the turns that still have rows", () => {
  const d = build();
  const box = d.t2.querySelector(".turn-events");
  assert.equal(box.hidden, true, "turns start collapsed");
  d.app.setFilter(["hook"], "");
  d.app.applyTurnFilters();
  assert.equal(box.hidden, false, "a filtered turn must open to show the match");
});

test("the query box matches event detail across grains", () => {
  const d = build();
  d.app.setFilter([], "rebase");
  d.app.applyTurnFilters();
  const shown = d.t1
    .querySelectorAll("[data-ev-kind]")
    .filter(visible)
    .map((e) => e.getAttribute("data-ev-kind"));
  assert.deepEqual(Array.from(shown).sort(), ["prompt", "tool_call", "tool_result"]);
  // "all done" does not contain "rebase", so turn 2 drops out.
  assert.ok(!visible(d.t2));
  assert.ok(visible(d.nodeA) && visible(d.nodeB));
});

test("kind and query are ANDed, not ORed", () => {
  const d = build();
  d.app.setFilter(["tool_call"], "rebase");
  d.app.applyTurnFilters();
  const shown = d.t1
    .querySelectorAll("[data-ev-kind]")
    .filter(visible)
    .map((e) => e.getAttribute("data-ev-kind"));
  assert.deepEqual(Array.from(shown), ["tool_call"], "the AND leaked into an OR");
});

test("clearing the filter restores everything, including turns it had hidden", () => {
  const d = build();
  d.app.setFilter(["hook"], "");
  d.app.applyTurnFilters();
  assert.ok(!visible(d.t1));
  d.app.setFilter([], "");
  d.app.applyTurnFilters();
  assert.ok(visible(d.t1) && visible(d.t2));
  assert.ok(d.t1.querySelectorAll("[data-ev-kind]").every(visible));
  assert.ok(!d.count.classes.has("on"));
});

test("the time window and the kind filter are ANDed in one pass", () => {
  const d = build();
  // Turn 1 spans 0..100, turn 2 spans 200..300. A window over turn 1 only.
  d.app.setTurnRange({ from: 0, to: 150 });
  d.app.applyTurnFilters();
  assert.ok(visible(d.t1));
  assert.ok(!visible(d.t2), "a turn outside the window stayed visible");

  // Now add a kind that only turn 2 has: the window must still exclude it, and
  // turn 1 must drop for having no matching event. Neither filter may win alone.
  d.app.setFilter(["hook"], "");
  d.app.applyTurnFilters();
  assert.ok(!visible(d.t1) && !visible(d.t2));

  d.app.setTurnRange(null);
  d.app.setFilter([], "");
});

test("stream edges bridge hidden nodes instead of leaving stubs", () => {
  const { app, root } = loadApp();
  const chain = new El({ classes: ["flow-chain"] });
  const node = (kind, text) =>
    new El({
      classes: ["flow-node"],
      attrs: { "data-trace-node": "1", "data-trace-kind": kind, "data-trace-text": text },
    });
  const edge = () => new El({ classes: ["flow-edge"] });
  const a = node("prompt", "ask");
  const b = node("tool_call", "bash");
  const c = node("reply", "done");
  const e1 = edge();
  const e2 = edge();
  chain.append(a, e1, b, e2, c);
  root.append(chain);

  app.setFilter([], "");
  app.applyTurnFilters();
  assert.ok(visible(e1) && visible(e2), "unfiltered chain lost a connector");

  // Hiding the middle node: one connector joins prompt→reply, no stub either side.
  app.setFilter(["prompt", "reply"], "");
  app.applyTurnFilters();
  assert.ok(!visible(b));
  assert.equal([e1, e2].filter(visible).length, 1, "expected exactly one bridging edge");

  // Hiding the tail: nothing dangles off the last visible node.
  app.setFilter(["prompt", "tool_call"], "");
  app.applyTurnFilters();
  assert.ok(visible(e1) && !visible(e2), "edge into a hidden tail must go");
  app.setFilter([], "");
});

const isOpen = (t) => !t.children.find((c) => c.classes.has("turn-events")).hidden;

test("clearing the filter closes only the turns the filter opened", () => {
  const d = build();
  // The user had t2 open before searching; t1 was closed.
  d.app.userSetTurnExpanded("2", true, d.t2);
  d.app.setFilter([], ""); // a pass with no filter drops the user mark, like a fresh view
  d.app.applyTurnFilters();
  assert.ok(isOpen(d.t2) && !isOpen(d.t1));

  d.app.setFilter(["prompt", "reply"], "");
  d.app.applyTurnFilters();
  assert.ok(isOpen(d.t1), "the filter opens the matching turn it found closed");

  d.app.setFilter([], "");
  d.app.applyTurnFilters();
  assert.ok(!isOpen(d.t1), "the turn the filter opened closes again");
  assert.ok(isOpen(d.t2), "a turn open before the search must stay open after it");
});

test("a turn the user closes mid-search stays closed on the next pass", () => {
  const d = build();
  d.app.setFilter(["prompt"], "");
  d.app.applyTurnFilters();
  assert.ok(isOpen(d.t1));
  d.app.userSetTurnExpanded("1", false, d.t1); // click or ← on the row
  d.app.setFilter(["prompt"], "rebase"); // the user keeps typing
  d.app.applyTurnFilters();
  assert.ok(!isOpen(d.t1), "the next pass re-opened a turn the user just closed");

  // And one they open by hand mid-search is not closed when the filter clears.
  d.app.userSetTurnExpanded("2", true, d.t2);
  d.app.setFilter([], "");
  d.app.applyTurnFilters();
  assert.ok(isOpen(d.t2), "clearing the filter collapsed a turn the user opened");
});
