import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import { loadConfig } from "./config.ts";
import { program } from "./bot.ts";

/**
 * Headless feishu-bot M0 entrypoint.
 *
 * Loads configuration from the environment/CLI, then runs the end-to-end flow:
 * auth -> connect -> discover/create project -> create thread -> start turn ->
 * print the event stream until the turn completes.
 */
const main = Effect.gen(function* () {
  const config = yield* loadConfig;
  yield* program(config);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

NodeRuntime.runMain(main);
