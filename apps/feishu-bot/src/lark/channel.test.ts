import { describe, expect, it } from "@effect/vitest";

import { coerceChatMemberCount } from "./channel.ts";

describe("coerceChatMemberCount", () => {
  it("coerces the SDK's JSON string user_count to a number", () => {
    // The real bug: Feishu returns user_count as a string at runtime despite the
    // channel's `number` type. A raw string would blow up Schema.Int encoding of
    // the whole reportChats payload.
    expect(coerceChatMemberCount("5")).toBe(5);
    expect(coerceChatMemberCount("0")).toBe(0);
  });

  it("passes a real number through", () => {
    expect(coerceChatMemberCount(5)).toBe(5);
  });

  it("drops missing / empty / non-integral values", () => {
    expect(coerceChatMemberCount(undefined)).toBeUndefined();
    expect(coerceChatMemberCount(null)).toBeUndefined();
    expect(coerceChatMemberCount("")).toBeUndefined();
    expect(coerceChatMemberCount("abc")).toBeUndefined();
    expect(coerceChatMemberCount("5.5")).toBeUndefined();
    expect(coerceChatMemberCount(Number.NaN)).toBeUndefined();
  });
});
