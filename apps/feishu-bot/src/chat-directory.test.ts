import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  type ChatDirectorySource,
  collectFeishuChatDirectory,
  reportFeishuChatDirectory,
} from "./chat-directory.ts";
import { LarkGatewayError } from "./lark/index.ts";

const larkError = (message: string) => new LarkGatewayError({ message, cause: null });

/** A registry stub that only counts report attempts (the RPC is never executed). */
const makeRecordingRegistry = () => {
  let runCalls = 0;
  const registry: Pick<EnvironmentRegistry["Service"], "run"> = {
    run: (() => {
      runCalls += 1;
      return Effect.succeed({});
    }) as EnvironmentRegistry["Service"]["run"],
  };
  return { registry, calls: () => runCalls };
};

describe("collectFeishuChatDirectory", () => {
  it.effect("assembles one entry per chat with mode/owner/members", () =>
    Effect.gen(function* () {
      const source: ChatDirectorySource = {
        listChats: Effect.succeed([
          { chatId: "oc_1", name: "Group One" },
          { chatId: "oc_2", name: "Topic Two" },
        ]),
        getChatInfo: (chatId) =>
          Effect.succeed({
            chatMode: chatId === "oc_2" ? "topic" : "group",
            ownerOpenId: "ou_owner",
            memberCount: 5,
          }),
        listChatMembers: (chatId) =>
          Effect.succeed(chatId === "oc_1" ? ["ou_a", "ou_b"] : ["ou_c"]),
      };

      const entries = yield* collectFeishuChatDirectory(source);

      assert.deepEqual(entries, [
        {
          chatId: "oc_1",
          name: "Group One",
          chatMode: "group",
          memberOpenIds: ["ou_a", "ou_b"],
          ownerOpenId: "ou_owner",
          memberCount: 5,
        },
        {
          chatId: "oc_2",
          name: "Topic Two",
          chatMode: "topic",
          memberOpenIds: ["ou_c"],
          ownerOpenId: "ou_owner",
          memberCount: 5,
        },
      ]);
    }),
  );

  it.effect("keeps a minimal entry for a chat whose info read fails (not dropped)", () =>
    Effect.gen(function* () {
      const source: ChatDirectorySource = {
        listChats: Effect.succeed([
          { chatId: "oc_ok", name: "OK" },
          { chatId: "oc_bad", name: "Bad" },
        ]),
        getChatInfo: (chatId) =>
          chatId === "oc_bad"
            ? Effect.fail(larkError("chat.get failed"))
            : Effect.succeed({ chatMode: "group", memberCount: 1 }),
        listChatMembers: () => Effect.succeed(["ou_x"]),
      };

      const entries = yield* collectFeishuChatDirectory(source);

      // Full-replace means a dropped chat = deleted from the directory, so the
      // failed chat is preserved with a sentinel "unknown" mode instead.
      assert.deepEqual(entries, [
        { chatId: "oc_ok", name: "OK", chatMode: "group", memberOpenIds: ["ou_x"], memberCount: 1 },
        { chatId: "oc_bad", name: "Bad", chatMode: "unknown", memberOpenIds: ["ou_x"] },
      ]);
    }),
  );

  it.effect("keeps a chat entry with empty membership when the member read fails", () =>
    Effect.gen(function* () {
      const source: ChatDirectorySource = {
        listChats: Effect.succeed([{ chatId: "oc_1", name: "One" }]),
        getChatInfo: () =>
          Effect.succeed({ chatMode: "group", ownerOpenId: "ou_o", memberCount: 3 }),
        listChatMembers: () => Effect.fail(larkError("members failed")),
      };

      const entries = yield* collectFeishuChatDirectory(source);

      assert.deepEqual(entries, [
        {
          chatId: "oc_1",
          name: "One",
          chatMode: "group",
          memberOpenIds: [],
          ownerOpenId: "ou_o",
          memberCount: 3,
        },
      ]);
    }),
  );

  it.effect("fails (does not fall back to empty) when listChats fails", () =>
    Effect.gen(function* () {
      const source: ChatDirectorySource = {
        listChats: Effect.fail(larkError("chat.list failed")),
        getChatInfo: () => Effect.die("unreachable"),
        listChatMembers: () => Effect.die("unreachable"),
      };

      const exit = yield* Effect.exit(collectFeishuChatDirectory(source));

      assert.isTrue(Exit.isFailure(exit));
    }),
  );
});

describe("reportFeishuChatDirectory", () => {
  it.effect("does NOT report when the roster can't be enumerated (listChats fails)", () =>
    Effect.gen(function* () {
      const { registry, calls } = makeRecordingRegistry();
      yield* reportFeishuChatDirectory({
        source: {
          listChats: Effect.fail(larkError("down")),
          getChatInfo: () => Effect.die("unreachable"),
          listChatMembers: () => Effect.die("unreachable"),
        },
        registry,
        environmentId: EnvironmentId.make("environment-test"),
      });
      // No full-replace wipe: a failed enumeration must not send an empty roster.
      assert.equal(calls(), 0);
    }),
  );

  it.effect("reports once when the roster is enumerated", () =>
    Effect.gen(function* () {
      const { registry, calls } = makeRecordingRegistry();
      yield* reportFeishuChatDirectory({
        source: {
          listChats: Effect.succeed([{ chatId: "oc_1", name: "One" }]),
          getChatInfo: () => Effect.succeed({ chatMode: "group" }),
          listChatMembers: () => Effect.succeed([]),
        },
        registry,
        environmentId: EnvironmentId.make("environment-test"),
      });
      assert.equal(calls(), 1);
    }),
  );
});
