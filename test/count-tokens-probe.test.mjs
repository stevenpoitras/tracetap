import assert from "node:assert/strict";
import { test } from "node:test";

import { AnthropicAdapter } from "../dist/trajectory/anthropic.js";
import { buildTrajectories } from "../dist/trajectory/index.js";

/**
 * `/v1/messages/count_tokens` is a sizing probe, not a model call.
 *
 * It posts the same `messages[]` shape a real call does, and the proxy's
 * default matcher is `/v1/messages`, which prefix-matches it — so it lands in
 * the log and reaches the adapter. Accepted as a turn it manufactures a
 * session with 0 turns, 0 tokens and $0.
 */
const probe = {
  request: {
    timestamp: 1,
    method: "POST",
    url: "https://api.anthropic.com/v1/messages/count_tokens?beta=true",
    headers: {},
    body: { model: "claude-opus-5", messages: [{ role: "user", content: "hi" }] },
  },
  response: { timestamp: 2, status_code: 200, headers: {}, body: { input_tokens: 6062 } },
};

const real = {
  request: {
    timestamp: 1,
    method: "POST",
    url: "https://api.anthropic.com/v1/messages",
    headers: {},
    body: { model: "claude-opus-5", messages: [{ role: "user", content: "hi" }] },
  },
  response: { timestamp: 2, status_code: 200, headers: {}, body: {} },
};

test("count_tokens probes are rejected by the Anthropic adapter", () => {
  assert.equal(new AnthropicAdapter().matches(probe), false, "sizing probe must not become a turn");
});

test("real /v1/messages calls still match", () => {
  assert.equal(new AnthropicAdapter().matches(real), true);
});

test("a log of nothing but probes produces no session at all", () => {
  // The end-to-end consequence: rejecting the probe must not simply hand it to
  // another adapter. Before this, a trace of 15 probes became a session with
  // 0 turns, 0 tokens and $0, plus a matching hole in usage_events.
  assert.deepEqual(buildTrajectories([probe, probe, probe]), []);
  assert.equal(buildTrajectories([real]).length, 1, "real calls still build a trajectory");
});

test("the URL match is anchored to the count_tokens path", () => {
  // Guard against over-rejection: a normal call must not be excluded just
  // because the string appears somewhere unrelated in the query.
  const lookalike = {
    ...real,
    request: { ...real.request, url: "https://api.anthropic.com/v1/messages?note=count_tokens" },
  };
  assert.equal(new AnthropicAdapter().matches(lookalike), true);
});
