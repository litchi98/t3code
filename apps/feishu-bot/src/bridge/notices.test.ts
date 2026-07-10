import { describe, expect, it } from "vite-plus/test";

import { topicSendOpts, turnReplySendOpts } from "./notices.ts";

// Feishu message / thread ids are opaque strings; concrete-looking values keep
// the intent readable.
const TRIGGER = "om_trigger_msg";
const TOPIC = "omt_topic_thread";

describe("topicSendOpts (unchanged red line)", () => {
  it("emits an in-thread reply only when BOTH anchor and replyTo are present", () => {
    // group / topic turn: anchored inside the thread.
    expect(topicSendOpts(TOPIC, TRIGGER)).toEqual({ replyTo: TRIGGER, replyInThread: true });
  });

  it("returns undefined for p2p (no larkThreadId) — bare send, no reply", () => {
    expect(topicSendOpts(undefined, TRIGGER)).toBeUndefined();
  });

  it("returns undefined when there is no reply anchor (flush/replay)", () => {
    expect(topicSendOpts(TOPIC, undefined)).toBeUndefined();
    expect(topicSendOpts(undefined, undefined)).toBeUndefined();
  });
});

describe("turnReplySendOpts (new-turn card: p2p quotes the trigger)", () => {
  it("keeps the group/topic in-thread reply byte-identical to topicSendOpts", () => {
    expect(turnReplySendOpts(TOPIC, TRIGGER)).toEqual(topicSendOpts(TOPIC, TRIGGER));
    expect(turnReplySendOpts(TOPIC, TRIGGER)).toEqual({ replyTo: TRIGGER, replyInThread: true });
  });

  it("p2p (no larkThreadId) posts a PLAIN reply that quotes the trigger — no replyInThread", () => {
    const opts = turnReplySendOpts(undefined, TRIGGER);
    expect(opts).toEqual({ replyTo: TRIGGER });
    // `reply_in_thread` must never be set in p2p (threads are group-only).
    expect(opts && "replyInThread" in opts).toBe(false);
  });

  it("no reply anchor → undefined (posts at the chat root), for both key shapes", () => {
    expect(turnReplySendOpts(TOPIC, undefined)).toBeUndefined();
    expect(turnReplySendOpts(undefined, undefined)).toBeUndefined();
  });
});
