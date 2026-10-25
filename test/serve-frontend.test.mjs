import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const APP_JS = path.join(ROOT, "frontend", "serve", "app.js");

/**
 * The dashboard frontend, loaded into Node.
 *
 * `frontend/serve/app.js` is a browser IIFE served inline by `src/store/serve.ts`
 * — there is no build step and no import boundary, which is why it carried zero
 * test coverage while accumulating bugs that only a browser could surface. It
 * ends with a `module.exports` guard that browsers skip; this shim satisfies the
 * handful of DOM globals the IIFE touches AT LOAD so that hook can be reached.
 *
 * The shim is deliberately dumb: `querySelectorAll` returns nothing and every
 * element is inert. Only the pure model — event derivation, the filter predicate,
 * markup generation — is exercised here. Anything that needs a live DOM belongs
 * in a browser check, not in a fake one that would pass against a shim while
 * failing in Chrome.
 */
function loadApp() {
  const src = fs.readFileSync(APP_JS, "utf8");

  const el = () => ({
    innerHTML: "",
    textContent: "",
    hidden: false,
    style: {},
    className: "",
    value: "",
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    appendChild() {},
    remove() {},
    scrollIntoView() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
  });

  const document = {
    getElementById: () => el(),
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
    // `route()` runs at load and reads the hash. Pinned to the session LIST,
    // which needs no session payload — an empty hash fell through to the
    // analytics view and pulled in half the charting stack.
    location: { hash: "#sessions", replace() {} },
    // Web platform globals the IIFE uses that are NOT ECMAScript built-ins, so
    // a bare vm context does not have them.
    URLSearchParams,
    URL,
    TextEncoder,
    TextDecoder,
    history: { replaceState() {} },
    // Never resolves: load-time `loadMeta()` must not race the assertions.
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
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.addEventListener = () => {};

  vm.createContext(sandbox);
  new vm.Script(src, { filename: "app.js" }).runInContext(sandbox);
  return sandbox.module.exports;
}

const app = loadApp();

/**
 * Arrays built inside the vm context have that context's `Array.prototype`, so
 * `deepStrictEqual` rejects them against a host literal even when every element
 * matches ("same structure but not reference-equal"). Copy into a host array.
 */
const host = (x) => Array.from(x);

/** A step as the store hands it to the frontend. */
function step(over = {}) {
  return {
    stepIndex: 0,
    role: "agent",
    message: "",
    reasoning: "",
    toolName: "",
    toolInput: "",
    observation: "",
    errored: false,
    ...over,
  };
}

/** A request row as the store hands it to the frontend. */
function req(over = {}) {
  return {
    seq: 1,
    ts: 1_700_000_000,
    model: "claude-opus-5",
    promptTokens: 10,
    completionTokens: 20,
    cacheRead: 100,
    cacheCreation: 5,
    durationMs: 1000,
    promptHash: "abc",
    agentStepIndex: 1,
    errored: false,
    isSubagent: false,
    ...over,
  };
}

test("the app exposes its trace model to Node at all", () => {
  assert.ok(typeof app.buildTurns === "function", "buildTurns not exported");
  assert.ok(Array.isArray(app.TRACE_KINDS));
});

test("buildTurns derives message-grade events, not just tools and hooks", () => {
  const steps = [
    step({ stepIndex: 0, role: "user", message: "please rebase the branch" }),
    step({
      stepIndex: 1,
      role: "agent",
      message: "Rebasing now.",
      reasoning: "the branch is behind main",
      toolName: "Bash",
      toolInput: JSON.stringify({ command: "git rebase main" }),
      observation: "Successfully rebased",
    }),
  ];
  const turns = app.buildTurns([req()], [], steps, {});
  assert.equal(turns.length, 1);
  const kinds = host(turns[0].events.map((e) => e.kind));

  // The whole point of the consolidation: a turn now carries the three
  // message kinds the Flow pane used to be the only home for.
  assert.deepEqual(kinds, [
    "prompt",
    "thinking",
    "reply",
    "tool_call",
    "tool_result",
  ]);

  const prompt = turns[0].events.find((e) => e.kind === "prompt");
  assert.match(prompt.label, /rebase the branch/);
  const think = turns[0].events.find((e) => e.kind === "thinking");
  assert.match(think.label, /behind main/);
  const call = turns[0].events.find((e) => e.kind === "tool_call");
  assert.match(call.label, /^Bash/);
  const result = turns[0].events.find((e) => e.kind === "tool_result");
  assert.equal(result.detail, "Successfully rebased");
});

test("a prompt is emitted once per run, not once per turn that inherits it", () => {
  // Three API calls driven by ONE user message. Emitting `prompt` on each would
  // report three prompts for a session where the user typed once.
  const steps = [
    step({ stepIndex: 0, role: "user", message: "do the thing" }),
    step({ stepIndex: 1, role: "agent", message: "step one", toolName: "Bash" }),
    step({ stepIndex: 2, role: "agent", message: "step two", toolName: "Bash" }),
    step({ stepIndex: 3, role: "agent", message: "step three" }),
  ];
  const reqs = [
    req({ seq: 1, agentStepIndex: 1 }),
    req({ seq: 2, agentStepIndex: 2 }),
    req({ seq: 3, agentStepIndex: 3 }),
  ];
  const turns = app.buildTurns(reqs, [], steps, {});
  const promptCount = turns
    .flatMap((t) => t.events)
    .filter((e) => e.kind === "prompt").length;
  assert.equal(promptCount, 1, "the shared prompt was counted more than once");
});

test("an empty-step placeholder is not reported as a reply", () => {
  // The indexer stores a `<block>no…` placeholder for a step with no text. An
  // equality test let every placeholder through as a contentless "reply".
  const steps = [step({ stepIndex: 1, role: "agent", message: "<block>none" })];
  const turns = app.buildTurns([req()], [], steps, {});
  assert.equal(
    turns[0].events.filter((e) => e.kind === "reply").length,
    0,
    "placeholder step leaked through as a reply",
  );
});

test("multiple tool calls on one step each become their own event", () => {
  const steps = [
    step({
      stepIndex: 1,
      toolName: "Read Grep Bash",
      toolInput: ['{"file_path":"a.ts"}', '{"pattern":"foo"}', '{"command":"ls"}'].join("\n"),
    }),
  ];
  const turns = app.buildTurns([req()], [], steps, {});
  const calls = turns[0].events.filter((e) => e.kind === "tool_call");
  assert.equal(calls.length, 3);
  assert.deepEqual(host(calls.map((c) => c.tool)), ["Read", "Grep", "Bash"]);
  // Argument pairing must not drift: each call carries its OWN input.
  assert.match(calls[0].label, /a\.ts/);
  assert.match(calls[2].label, /ls/);
});

test("the filter predicate: kinds, query, and their AND", () => {
  const ev = { kind: "tool_call", label: "Bash git rebase main", detail: "", tool: "Bash" };
  const text = app.traceTextFor(ev);

  app.setFilter([], "");
  assert.equal(app.tracePasses("tool_call", text), true, "no filter must show everything");

  app.setFilter(["tool_call"], "");
  assert.equal(app.tracePasses("tool_call", text), true);
  assert.equal(app.tracePasses("prompt", text), false);

  app.setFilter([], "rebase");
  assert.equal(app.tracePasses("prompt", text), true, "query alone ignores kind");
  assert.equal(app.tracePasses("tool_call", app.traceTextFor({ label: "Read a.ts" })), false);

  // ANDed, not ORed: the wrong kind loses even when the text matches.
  app.setFilter(["prompt"], "rebase");
  assert.equal(app.tracePasses("tool_call", text), false);
  assert.equal(app.tracePasses("prompt", text), true);

  app.setFilter([], "");
});

test("the query searches detail, not only the visible label", () => {
  // A label is a 96-char preview; the term the user types is usually in the body.
  const ev = {
    kind: "tool_result",
    label: "Bash → 4.0K chars",
    detail: "fatal: needle in the haystack",
  };
  app.setFilter([], "needle");
  assert.equal(app.tracePasses("tool_result", app.traceTextFor(ev)), true);
  app.setFilter([], "");
});

test("'messages only' resolves to the three message kinds", () => {
  assert.deepEqual([...app.MESSAGE_KINDS].sort(), ["prompt", "reply", "thinking"]);
  const kindKeys = app.TRACE_KINDS.map((k) => k.key);
  for (const m of app.MESSAGE_KINDS) {
    assert.ok(kindKeys.includes(m), `${m} is not a real filter chip`);
  }
});

test("flow node kinds all map into the shared vocabulary", () => {
  // Every kind src/flow/derive.ts can emit must have a mapping, or the Stream
  // grain renders rows that no chip can ever match.
  const derived = [
    "user",
    "thinking",
    "assistant",
    "tool_call",
    "tool_result",
    "hook",
    "api_call",
    "branch",
  ];
  for (const k of derived) {
    assert.ok(app.FLOW_KIND_MAP[k], `flow kind '${k}' has no shared-vocabulary mapping`);
  }
  assert.equal(app.FLOW_KIND_MAP.user, "prompt");
  assert.equal(app.FLOW_KIND_MAP.assistant, "reply");
  assert.equal(app.FLOW_KIND_MAP.branch, "tool_call");
});

test("context buckets map only to kinds that are really events", () => {
  assert.equal(app.BUCKET_KIND.tools, "tool_call");
  assert.equal(app.BUCKET_KIND.user, "prompt");
  assert.equal(app.BUCKET_KIND.assistant, "reply");
  // `system` and `skills` are injected context, not emitted events. A mapping
  // here would render a control that filters to nothing.
  assert.equal(app.BUCKET_KIND.system, undefined);
  assert.equal(app.BUCKET_KIND.skills, undefined);
});

/** The haystack a rendered row would hand the filter pass, looked up by its key. */
function hayFor(html, keyPrefix) {
  const m = html.match(new RegExp('data-trace-key="(' + keyPrefix + '[^"]*)"'));
  assert.ok(m, `no row keyed ${keyPrefix}…`);
  return app.traceTextOf({ getAttribute: (n) => (n === "data-trace-key" ? m[1] : null) });
}

test("spine rows carry the attributes the filter pass reads", () => {
  const steps = [
    step({ stepIndex: 0, role: "user", message: "find the bug" }),
    step({ stepIndex: 1, toolName: "Bash", toolInput: '{"command":"npm test"}' }),
  ];
  const turns = app.buildTurns([req()], [], steps, {});
  const html = app.turnSpineHtml(turns);
  assert.match(html, /data-ev-kind="prompt"/);
  assert.match(html, /data-ev-kind="tool_call"/);
  assert.match(hayFor(html, "ev:1:1"), /npm test/, "events must carry a search haystack");
  // The turn's short summary may stay inline; the event detail must not.
  assert.ok(!/data-ev-kind="[^"]*"[^>]*data-trace-text=/.test(html), "event haystacks must not ride in the markup");
  assert.match(html, /data-inspect="ev:1:0"/);
});

test("stream nodes carry a mapped kind and a haystack", () => {
  const flow = {
    nodes: [
      { id: "n1", kind: "user", label: "hello", detail: { message: "hello there" } },
      { id: "n2", kind: "assistant", label: "hi", detailPreview: "hi back" },
    ],
  };
  const html = app.renderFlowPane(flow);
  assert.match(html, /data-trace-node="1"/);
  assert.match(html, /data-trace-kind="prompt"/, "user node must map to prompt");
  assert.match(html, /data-trace-kind="reply"/, "assistant node must map to reply");
  assert.match(hayFor(html, "node:n1"), /hello there/);
});

test("step cards advertise every kind they bundle", () => {
  const html = app.stepCard(
    step({
      stepIndex: 4,
      role: "agent",
      message: "done",
      reasoning: "thought about it",
      toolName: "Bash",
      observation: "ok",
    }),
  );
  const m = html.match(/data-trace-kinds="([^"]*)"/);
  assert.ok(m, "step card has no kind list");
  const kinds = m[1].split(" ").sort();
  assert.deepEqual(kinds, ["reply", "thinking", "tool_call", "tool_result"]);
  // The id is what a `#…/step-N` deep link flashes.
  assert.match(html, /id="step-4"/);
  assert.match(hayFor(html, "step:4"), /thought about it/);
});

test("the haystack is not capped: a word deep in a long result is findable", () => {
  const long = "x".repeat(9000) + " needle";
  const html = app.stepCard(step({ stepIndex: 7, role: "agent", toolName: "Bash", observation: long }));
  assert.match(hayFor(html, "step:7"), /needle$/);
  const ev = { kind: "tool_result", label: "out", detail: long };
  assert.match(app.traceTextFor(ev), /needle$/);
});

test("a user step is a prompt, not a reply", () => {
  const html = app.stepCard(step({ stepIndex: 2, role: "user", message: "hello" }));
  const kinds = html.match(/data-trace-kinds="([^"]*)"/)[1].split(" ");
  assert.ok(kinds.includes("prompt"));
  assert.ok(!kinds.includes("reply"));
});

test("the filter bar only offers chips for kinds present in the session", () => {
  const steps = [step({ stepIndex: 1, toolName: "Bash", observation: "out" })];
  const turns = app.buildTurns([req()], [], steps, {});
  const bar = app.traceFilterBarHtml(turns);
  assert.match(bar, /data-turn-filter="tool_call"/);
  assert.match(bar, /data-turn-filter="tool_result"/);
  // No hooks fired and nothing compacted, so those chips must not appear.
  assert.ok(!/data-turn-filter="hook"/.test(bar), "offered a hook chip with no hooks");
  assert.ok(!/data-turn-filter="compaction"/.test(bar));
  assert.match(bar, /id="trace-q"/, "query box missing");
  assert.match(bar, /data-turn-preset="all"/);
});

test("the messages preset is offered only when there are messages", () => {
  const toolOnly = app.buildTurns(
    [req()],
    [],
    [step({ stepIndex: 1, toolName: "Bash" })],
    {},
  );
  assert.ok(
    !/data-turn-preset="messages"/.test(app.traceFilterBarHtml(toolOnly)),
    "offered a messages preset for a session with no messages",
  );

  const withMsg = app.buildTurns(
    [req()],
    [],
    [step({ stepIndex: 1, message: "hi" })],
    {},
  );
  assert.match(app.traceFilterBarHtml(withMsg), /data-turn-preset="messages"/);
});

test("the anatomy panel renders every kind and honours the filter", () => {
  const steps = [
    step({ stepIndex: 0, role: "user", message: "ship it" }),
    step({
      stepIndex: 1,
      message: "shipping",
      reasoning: "looks safe",
      toolName: "Bash",
      toolInput: '{"command":"git push"}',
      observation: "pushed",
    }),
  ];
  const t = app.buildTurns([req()], [], steps, {})[0];

  app.setFilter([], "");
  const all = app.journeyStepsHtml(t);
  for (const k of ["prompt", "thinking", "reply", "tool_call", "tool_result"]) {
    assert.match(all, new RegExp(`jr-badge ${k}"`), `anatomy is missing ${k}`);
  }

  app.setFilter(["prompt", "reply", "thinking"], "");
  const msgs = app.journeyStepsHtml(t);
  assert.match(msgs, /jr-badge prompt"/);
  assert.ok(!/jr-badge tool_call"/.test(msgs), "tool call survived a messages-only filter");
  assert.match(msgs, /3 of 5 events/, "the panel must say what it is hiding");

  app.setFilter([], "");
});

test("retired pane names still resolve, and each names a grain", () => {
  assert.deepEqual(host(app.SESSION_PANES), ["trace", "hooks", "xray", "tools", "related"]);
  for (const old of ["journey", "flow", "wire"]) {
    const alias = app.PANE_ALIASES[old];
    assert.ok(alias, `#…/${old} would no longer route anywhere`);
    assert.equal(alias.pane, "trace");
    assert.ok(
      ["turns", "stream", "steps"].includes(alias.density),
      `${old} aliases to an unknown grain`,
    );
  }
  // Each retired tab lands on the grain that replaced it: Wire was the turn
  // spine over the time ribbon, not the transcript.
  assert.equal(app.PANE_ALIASES.journey.density, "turns");
  assert.equal(app.PANE_ALIASES.flow.density, "stream");
  assert.equal(app.PANE_ALIASES.wire.density, "turns");
});

test("hooks are attributed to the turn they fired during", () => {
  const steps = [
    step({ stepIndex: 1, toolName: "Bash" }),
    step({ stepIndex: 2, toolName: "Read" }),
  ];
  const reqs = [
    req({ seq: 1, ts: 1000, agentStepIndex: 1 }),
    req({ seq: 2, ts: 2000, agentStepIndex: 2 }),
  ];
  const hooks = [
    { id: 1, ts: 1500, event: "PreToolUse", hookName: "guard", outcome: "ok" },
    { id: 2, ts: 2500, event: "PostToolUse", hookName: "log", outcome: "ok" },
  ];
  const turns = app.buildTurns(reqs, hooks, steps, {});
  const first = turns[0].events.filter((e) => e.kind === "hook");
  assert.equal(first.length, 1);
  assert.match(first[0].label, /PreToolUse/);
});

test("filter summary reads back what is restricted", () => {
  app.setFilter(["prompt", "reply"], "rebase");
  const s = app.traceFilterSummary();
  assert.match(s, /prompt/);
  assert.match(s, /reply/);
  assert.match(s, /rebase/);
  app.setFilter([], "");
  assert.equal(app.traceFilterSummary(), "all");
});

test("a turn's prompt renders as text, never as [object Object]", () => {
  // The inspector used to build its PROMPT block with `String(t.prompt)`. But
  // `t.prompt` is the user STEP object, so every turn that had a prompt printed
  // "[object Object]" where the ask should be. `stepText` is the accessor.
  const promptStep = step({ stepIndex: 0, role: "user", message: "why is CI red?" });
  const turns = app.buildTurns(
    [req()],
    [],
    [promptStep, step({ stepIndex: 1, message: "looking" })],
    {},
  );
  const t = turns[0];

  assert.equal(typeof t.prompt, "object", "t.prompt is a step, not a string");
  assert.notEqual(
    String(t.prompt),
    "why is CI red?",
    "if a step ever stringifies to its text this test is no longer meaningful",
  );
  assert.equal(app.stepText(t.prompt), "why is CI red?");

  // And the derived prompt EVENT carries text, so the spine cannot regress the
  // same way the inspector did.
  const ev = t.events.find((e) => e.kind === "prompt");
  assert.equal(typeof ev.detail, "string");
  assert.match(ev.detail, /why is CI red\?/);
  assert.ok(!/\[object Object\]/.test(ev.label));
});

test("stepText yields nothing for a placeholder step", () => {
  // Guarding on the STEP rather than on its text printed a bare "PROMPT"
  // heading with no body for placeholder-only turns.
  assert.equal(app.stepText(step({ role: "user", message: "<block>none" })), "");
  assert.equal(app.stepText(null), "");
});

test("no rendered markup stringifies an object", () => {
  // A blanket check across every generated surface: the bug class is a `String()`
  // or a `+` on a non-string, and it always leaves this exact fingerprint.
  const steps = [
    step({ stepIndex: 0, role: "user", message: "ship it" }),
    step({
      stepIndex: 1,
      message: "shipping",
      reasoning: "safe",
      toolName: "Bash",
      toolInput: '{"command":"git push"}',
      observation: "pushed",
    }),
  ];
  const turns = app.buildTurns([req()], [], steps, {});
  const surfaces = {
    spine: app.turnSpineHtml(turns),
    anatomy: app.journeyStepsHtml(turns[0]),
    filterBar: app.traceFilterBarHtml(turns),
    stepCard: steps.map(app.stepCard).join(""),
    stream: app.renderFlowPane({
      nodes: [{ id: "n", kind: "user", label: "hi", detail: { message: "hi" } }],
    }),
  };
  for (const [name, html] of Object.entries(surfaces)) {
    assert.ok(!/\[object Object\]/.test(html), `${name} stringified an object`);
  }
});

test("harness machinery on the user side is not mistaken for a prompt", () => {
  // "User role" is a wire fact, not an authorship fact. These are the frames
  // src/store/title.ts rejects when titling a session; the frontend must agree,
  // or the inspector labels hook stdout as THE PROMPT (it did).
  const notAsks = [
    "UserPromptSubmit hook additional context: cwd is /tmp",
    "SessionStart hook success: loaded 3 skills",
    "PreToolUse hook failed: exit 1",
    "Called the Read tool with the following input: {\"file_path\":\"/a.ts\"}",
    "Result of calling the Bash tool: ok",
    "contents of /etc/hosts: 127.0.0.1 localhost",
    "<transcript>",
    "</transcript>",
  ];
  for (const msg of notAsks) {
    assert.equal(
      app.isUserAsk(step({ role: "user", message: msg })),
      false,
      `treated as a user ask: ${msg.slice(0, 50)}`,
    );
  }

  // A tool-keyed envelope is the previous turn's OUTPUT fed back.
  assert.equal(app.isUserAsk(step({ role: "user", message: '{"Bash":"total 40\\n"}' })), false);
  // Several envelopes concatenated is a transcript dump to an auxiliary call.
  assert.equal(
    app.isUserAsk(step({ role: "user", message: '{"Bash":"x"} {"user":"y"}' })),
    false,
  );
});

test("real asks survive the machinery filter, including near-miss wording", () => {
  const asks = [
    "why is CI red?",
    // Case matters: a person writing about hooks is not hook output.
    "the hook additional context is wrong, please fix",
    // A person can legitimately open with these words.
    "called the shots on this one — revert it",
    "contents of the readme need updating",
    "{\"user\":\"deploy to staging\"}",
  ];
  for (const msg of asks) {
    assert.equal(
      app.isUserAsk(step({ role: "user", message: msg })),
      true,
      `real ask rejected: ${msg.slice(0, 50)}`,
    );
  }
  // Only user-role steps can be asks at all.
  assert.equal(app.isUserAsk(step({ role: "agent", message: "why is CI red?" })), false);
});

test("a turn separates what a person asked from what merely came in", () => {
  const steps = [
    step({ stepIndex: 0, role: "user", message: "fix the flaky test" }),
    step({ stepIndex: 1, role: "agent", message: "on it", toolName: "Bash" }),
    // Hook output spliced in as a user message between turns.
    step({
      stepIndex: 2,
      role: "user",
      message: "PostToolUse hook success: logged",
    }),
    step({ stepIndex: 3, role: "agent", message: "done" }),
  ];
  const turns = app.buildTurns(
    [req({ seq: 1, agentStepIndex: 1 }), req({ seq: 2, agentStepIndex: 3 })],
    [],
    steps,
    {},
  );

  // Turn 2's nearest user-role step is the hook output; its nearest real ask is
  // still the original request.
  assert.match(app.stepText(turns[1].prompt), /PostToolUse hook success/);
  assert.match(app.stepText(turns[1].ask), /fix the flaky test/);

  // And the prompt EVENT fires once, on the ask — not again for the hook line.
  const prompts = turns.flatMap((t) => t.events).filter((e) => e.kind === "prompt");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].detail, /fix the flaky test/);
});

test("placeholder steps are not counted as messages", () => {
  const html = app.stepCard(
    step({ stepIndex: 9, role: "agent", message: "<block>no content", toolName: "Bash" }),
  );
  const kinds = html.match(/data-trace-kinds="([^"]*)"/)[1].split(" ");
  assert.ok(!kinds.includes("reply"), "a placeholder must not survive messages-only as a reply");
  assert.ok(kinds.includes("tool_call"));
});

test("stepBody keeps the whole ask; stepText is the one-line label", () => {
  const long = "line one\n" + "x".repeat(500);
  const st = step({ stepIndex: 1, role: "user", message: JSON.stringify({ user: long }) });
  assert.equal(app.stepBody(st), long, "the inspector needs the full prompt, line breaks intact");
  assert.ok(app.stepText(st).length <= 200);
  assert.equal(app.stepBody(step({ stepIndex: 2, role: "agent", message: "<block>no" })), "");
});

test("the server's noise verdict outranks the local skip list", () => {
  // The output-style banner is not on the page's own list; the server's is
  // authoritative, which is what stops it being reported as a prompt each turn.
  const banner = "Explanatory output style is active. Remember to follow the specific guidelines for this style.";
  assert.equal(app.isUserAsk(step({ role: "user", message: banner, noise: true })), false);
  assert.equal(app.isUserAsk(step({ role: "user", message: "fix the bug", noise: false })), true);

  const steps = [
    step({ stepIndex: 0, role: "user", message: "fix the bug", noise: false }),
    step({ stepIndex: 1, toolName: "Bash", toolInput: "{}" }),
    step({ stepIndex: 2, role: "user", message: banner, noise: true }),
    step({ stepIndex: 3, message: "done" }),
  ];
  const turns = app.buildTurns([req({ seq: 0, agentStepIndex: 1 }), req({ seq: 1, agentStepIndex: 3 })], [], steps, {});
  const prompts = turns.flatMap((t) => t.events).filter((e) => e.kind === "prompt");
  assert.equal(prompts.length, 1, "a harness banner must not become a second prompt");
  assert.match(prompts[0].detail, /fix the bug/);
});

// ---------------------------------------------------------------------------
// Harness noise, prompt counts, header cards, ditto, layout, idle gaps.
// ---------------------------------------------------------------------------

/**
 * The shape of a real session opening (claude:aaec3dbe): a /clear, an ask, a
 * /model whose stdout carries ANSI bold, a second ask — all before the first
 * API call — then a third ask later on.
 */
function harnessSession() {
  const caveat =
    "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>";
  const steps = [
    step({ stepIndex: 1, role: "user", message: caveat, noise: true }),
    step({ stepIndex: 2, role: "user", message: "<command-name>/clear</command-name>", noise: true }),
    step({ stepIndex: 3, role: "user", message: "what are your goals?", noise: false }),
    step({ stepIndex: 4, role: "user", message: caveat, noise: true }),
    step({
      stepIndex: 5,
      role: "user",
      message: "<local-command-stdout>Set model to \u001b[1mOpus 5\u001b[22m</local-command-stdout>",
      noise: true,
    }),
    step({ stepIndex: 6, role: "user", message: "who are you really?", noise: false }),
    step({ stepIndex: 7, role: "agent", message: "I am the curator." }),
    step({ stepIndex: 8, role: "user", message: "push harder", noise: false }),
    step({ stepIndex: 9, role: "agent", message: "Understood." }),
  ];
  const reqs = [req({ seq: 0, agentStepIndex: 7 }), req({ seq: 1, agentStepIndex: 9 })];
  // A flow graph as an OLD server sends it: user nodes without `noise`, so the
  // page has to fall back on the steps to tell harness from person.
  const flow = {
    nodes: steps.map((s) => ({
      id: "step-" + s.stepIndex,
      kind: s.role === "user" ? "user" : "assistant",
      label: s.message,
      stepIndex: s.stepIndex,
    })),
    edges: [],
  };
  return { steps, reqs, flow };
}

test("Stream labels harness user steps as injected, not prompt — even without a server flag", () => {
  const { steps, flow } = harnessSession();
  const html = app.renderFlowPane(flow, steps);
  assert.equal((html.match(/data-trace-kind="prompt"/g) || []).length, 3);
  assert.equal((html.match(/data-trace-kind="injected"/g) || []).length, 4);
  assert.match(html, /flow-node kind-user is-noise/);
  assert.match(html, /<span class="flow-kind">injected<\/span>/);
  assert.ok(!html.includes("\u001b"), "ANSI escapes reached the markup");
  assert.match(html, /Set model to Opus 5/);
});

test("Stream honours the server's node-level noise flag on its own", () => {
  const html = app.renderFlowPane({
    nodes: [
      { id: "step-1", kind: "user", label: "/clear", stepIndex: 1, noise: true },
      { id: "step-2", kind: "user", label: "real ask", stepIndex: 2 },
    ],
    edges: [],
  });
  assert.equal((html.match(/data-trace-kind="injected"/g) || []).length, 1);
  assert.equal((html.match(/data-trace-kind="prompt"/g) || []).length, 1);
});

test("Steps grain renders harness user steps as injected harness, not USER/prompt", () => {
  const { steps } = harnessSession();
  const caveat = app.stepCard(steps[0]);
  assert.match(caveat, /class="step system is-noise/);
  assert.match(caveat, /injected · harness/);
  assert.match(caveat, /data-trace-kinds="injected"/);
  const ask = app.stepCard(steps[2]);
  assert.match(ask, /class="step user/);
  assert.match(ask, /data-trace-kinds="prompt"/);
  assert.ok(!app.stepCard(steps[4]).includes("\u001b"), "ANSI escapes reached the step body");
});

test("the prompt chip, Stream rows and Steps all count the same prompts", () => {
  const { steps, reqs, flow } = harnessSession();
  const turns = app.buildTurns(reqs, [], steps, {});
  const prompts = turns.flatMap((t) => t.events).filter((e) => e.kind === "prompt");
  // Two asks typed before the first call are BOTH prompts, not just the nearest.
  assert.deepEqual(host(prompts.map((p) => p.stepIndex)), [3, 6, 8]);
  const chip = app.traceFilterBarHtml(turns).match(/data-turn-filter="prompt"[^>]*>prompt <small>(\d+)/);
  const stream = (app.renderFlowPane(flow, steps).match(/data-trace-kind="prompt"/g) || []).length;
  const stepRows = steps.map(app.stepCard).join("").match(/data-trace-kinds="prompt/g).length;
  assert.equal(+chip[1], 3);
  assert.equal(stream, 3);
  assert.equal(stepRows, 3);
});

test("stripAnsi removes terminal colour codes and leaves text alone", () => {
  assert.equal(app.stripAnsi("Set \u001b[1mOpus 5\u001b[22m now"), "Set Opus 5 now");
  assert.equal(app.stripAnsi("plain [1m text"), "plain [1m text");
  assert.equal(app.stepText(step({ role: "user", message: "\u001b[31mred\u001b[0m" })), "red");
});

test("the busiest-turn insight names its mix instead of 'fired N events'", () => {
  const steps = [
    step({ stepIndex: 0, role: "user", message: "go" }),
    step({
      stepIndex: 1,
      message: "on it",
      toolName: "Read Grep Bash",
      toolInput: ["{}", "{}", "{}"].join("\n"),
    }),
  ];
  const turns = app.buildTurns([req({ seq: 4, agentStepIndex: 1 })], [], steps, {});
  const busy = app.sessionInsights(turns).find((n) => n.kind === "busy");
  assert.ok(busy, "a 5-block turn should be flagged as busiest");
  assert.doesNotMatch(busy.label, /fired|events/);
  assert.match(busy.label, /Turn 4 is the busiest · 5 blocks/);
  assert.match(busy.detail, /3 tool calls/);
  assert.match(busy.detail, /1 prompt/);
});

test("header cards: Prompts counts asks, not API calls; missing TTFT says n/a", () => {
  const { steps, reqs } = harnessSession();
  const s = { costUsd: 0, durationMs: 0, turns: reqs.length, totalInTokens: 0, totalOutTokens: 0, cacheRead: 0 };
  const html = app.sessionCardsHtml(s, reqs.map((r) => ({ ...r, ttftMs: null })), steps, [], [], null);
  assert.doesNotMatch(html, /<div class="k">Turns<\/div>/, "Turns duplicated API calls");
  assert.match(html, /<div class="k">Prompts<\/div><div class="v">3<\/div>/);
  assert.match(html, /TTFT p50<\/div><div class="v"><span class="dim">n\/a<\/span>/);
  assert.match(html, /title="No call in this session recorded a first-byte timestamp/);
  const timed = app.sessionCardsHtml(s, reqs.map((r) => ({ ...r, ttftMs: 1200 })), steps, [], [], null);
  assert.doesNotMatch(timed, /n\/a/);
});

test("a repeated summary reads 'same as above', not a 〃 glyph, and keeps its title", () => {
  const steps = [
    step({ stepIndex: 0, role: "user", message: "go" }),
    step({ stepIndex: 1, toolName: "Bash", toolInput: '{"command":"ls"}' }),
    step({ stepIndex: 2, toolName: "Bash", toolInput: '{"command":"ls"}' }),
    step({ stepIndex: 3, toolName: "Read", toolInput: '{"file_path":"a"}' }),
  ];
  const reqs = [1, 2, 3].map((i) => req({ seq: i, agentStepIndex: i }));
  const html = app.turnSpineHtml(app.buildTurns(reqs, [], steps, {}));
  assert.ok(!html.includes("〃"), "the ditto glyph rendered as // in the mono face");
  assert.match(html, /class="turn-sum ditto" title="Bash ls">↑ same as above</);
});

test("grain switch and filter bar share one control row above the grain content", () => {
  const steps = [step({ stepIndex: 0, role: "user", message: "go" }), step({ stepIndex: 1, message: "ok" })];
  const turns = app.buildTurns([req({ agentStepIndex: 1 })], [], steps, {});
  const html = app.tracePaneHtml(turns, { nodes: [], edges: [] }, steps);
  const controls = html.indexOf('id="trace-controls"');
  const sw = html.indexOf('class="trace-switch"');
  const filters = html.indexOf('id="trace-filters"');
  const detail = html.indexOf('id="jr-detail"');
  const grain = html.indexOf('class="trace-grain');
  assert.ok(controls > detail, "controls must sit below the focused turn, next to the grain");
  assert.ok(controls < sw && sw < filters && filters < grain, "switch + filters must be one row before the grains");
  assert.ok(html.indexOf('id="trace-anchor"') < controls, "scroll anchor precedes the sticky row");
});

test("the context strip breaks its series across long idle gaps", () => {
  const p = (fromS, durS) => ({ from: fromS * 1000, to: (fromS + durS) * 1000 });
  // Calls every ~10s, then a 6-hour idle stretch, then more calls.
  const pts = [p(0, 5), p(15, 5), p(30, 5), p(45, 5), p(6 * 3600, 5), p(6 * 3600 + 15, 5)];
  const segs = app.ctxStripSegments(pts);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].length, 4);
  // Normal spacing never breaks, even when it is slow.
  assert.equal(app.ctxStripSegments([p(0, 1), p(300, 1), p(600, 1)]).length, 1);

  const turns = pts.map((x, i) => ({
    seq: i,
    req: req({ seq: i, ts: x.from / 1000, durationMs: 5000, cacheRead: 100 + i }),
    events: [],
  }));
  const svg = app.contextStripHtml(turns, 0, 6 * 3600 * 1000 + 20000, 600);
  // Three bands x two segments: no polygon bridges the gap.
  assert.equal((svg.match(/<polygon/g) || []).length, 6);
  assert.match(svg, /1 idle gap left blank/);
});

test("the user-prompt head control is styled as a link, not a default button", () => {
  const css = fs.readFileSync(path.join(ROOT, "frontend", "serve", "app.css"), "utf8");
  const rule = css.match(/button\.head-link\s*\{([^}]*)\}/);
  assert.ok(rule, "button.head-link needs its own rule");
  assert.match(rule[1], /background:\s*none/);
  assert.match(rule[1], /border:\s*0/);
});

test("stripAnsi covers the full CSI parameter range, charset escapes and truncation", () => {
  // Truecolour uses ':' sub-parameters; private modes use '>' / '='.
  assert.equal(app.stripAnsi("\u001b[38:2::255:0:0mred\u001b[m"), "red");
  assert.equal(app.stripAnsi("\u001b[>4;2mX\u001b[4:3mY\u001b[=1hZ"), "XYZ");
  // `tput sgr0` emits a charset designation before the SGR reset.
  assert.equal(app.stripAnsi("bold\u001b(B\u001b[m done"), "bold done");
  // OSC, terminated by BEL, by ST, or cut off by the end of the string.
  assert.equal(app.stripAnsi("a\u001b]0;title\u0007b\u001b]8;;http://x\u001b\\c"), "abc");
  assert.equal(app.stripAnsi("tail\u001b]0;never closed"), "tail");
  // A CSI clipped mid-sequence by a preview cut, and a lone ESC.
  assert.equal(app.stripAnsi("cut\u001b[38;5"), "cut");
  assert.equal(app.stripAnsi("x\u001by"), "xy");
});

test("idle gaps over an hour always split, even when the median is itself huge", () => {
  const p = (fromS) => ({ from: fromS * 1000, to: fromS * 1000 + 1000 });
  const H = 3600;
  // Two calls 8h apart: the one gap IS the median, so a relative rule alone
  // never fires.
  assert.equal(app.ctxStripSegments([p(0), p(8 * H)]).length, 2);
  // Gaps [8h, 8h, 1s]: median 8h, still must split twice.
  assert.equal(app.ctxStripSegments([p(0), p(8 * H), p(16 * H), p(16 * H + 2)]).length, 3);
  // Under the ceiling and the floor, nothing splits.
  assert.equal(app.ctxStripSegments([p(0), p(300), p(600)]).length, 1);
});

test("an ask typed after the last call is counted by the chip, matching the Prompts card", () => {
  const steps = [
    step({ stepIndex: 0, role: "user", message: "first ask" }),
    step({ stepIndex: 1, role: "agent", message: "answer" }),
    step({ stepIndex: 2, role: "user", message: "follow-up nobody answered" }),
  ];
  const reqs = [req({ seq: 0, agentStepIndex: 1 })];
  const turns = app.buildTurns(reqs, [], steps, {});
  const prompts = turns.flatMap((t) => t.events).filter((e) => e.kind === "prompt");
  assert.deepEqual(host(prompts.map((p) => p.stepIndex)), [0, 2]);
  const trailing = prompts.find((p) => p.stepIndex === 2);
  assert.equal(trailing.trailing, true);
  assert.equal(turns[0].events[turns[0].events.length - 1], trailing, "trailing ask goes last, after the call");
  const chip = +app.traceFilterBarHtml(turns).match(/data-turn-filter="prompt"[^>]*>prompt <small>(\d+)/)[1];
  const s = { costUsd: 0, durationMs: 0, totalInTokens: 0, totalOutTokens: 0, cacheRead: 0 };
  const card = +app.sessionCardsHtml(s, reqs, steps, [], [], null).match(/Prompts<\/div><div class="v">(\d+)/)[1];
  assert.equal(chip, 2);
  assert.equal(card, chip);
});

test("empty and placeholder user steps are injected in every grain, never a prompt", () => {
  const steps = [
    step({ stepIndex: 1, role: "user", message: "" }),
    step({ stepIndex: 2, role: "user", message: "<block>no content" }),
    step({ stepIndex: 3, role: "user", message: "real ask" }),
    step({ stepIndex: 4, role: "agent", message: "ok" }),
  ];
  // What the CURRENT server sends: derive.ts flags both as noise.
  const flow = {
    nodes: [
      { id: "step-1", kind: "user", label: "user", stepIndex: 1, noise: true },
      { id: "step-2", kind: "user", label: "<block>no content", stepIndex: 2, noise: true },
      { id: "step-3", kind: "user", label: "real ask", stepIndex: 3 },
    ],
    edges: [],
  };
  const turns = app.buildTurns([req({ seq: 0, agentStepIndex: 4 })], [], steps, {});
  const chip = turns.flatMap((t) => t.events).filter((e) => e.kind === "prompt").length;
  for (const html of [app.renderFlowPane(flow, steps), app.renderFlowPane(flow)]) {
    assert.equal((html.match(/data-trace-kind="prompt"/g) || []).length, chip);
    assert.equal((html.match(/data-trace-kind="injected"/g) || []).length, 2);
  }
  assert.match(app.renderFlowPane(flow, steps), /\(empty user step\)/);
  assert.doesNotMatch(app.renderFlowPane(flow, steps), /flow-label[^>]*>&lt;block&gt;no/);
  const cards = steps.slice(0, 3).map(app.stepCard);
  assert.match(cards[0], /is-noise[^"]*" id="step-1" data-trace-kinds="injected"/);
  assert.match(cards[1], /is-noise[^"]*" id="step-2" data-trace-kinds="injected"/);
  assert.match(cards[2], /data-trace-kinds="prompt"/);
  assert.equal(chip, 1);
});
