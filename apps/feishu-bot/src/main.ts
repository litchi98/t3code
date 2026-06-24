import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import { loadConfig } from "./config.ts";
import { program } from "./bot.ts";

/**
 * Headless feishu-bot M1 entrypoint (resident).
 *
 * Loads configuration from the environment/CLI, then runs the long-lived bridge:
 * auth -> connect to the t3code server -> discover/create project -> connect the
 * Feishu long connection -> route every private-chat message into a true shared
 * t3code session, streaming the agent's reply back as a CardKit card. The
 * program never returns on its own (it parks on `Effect.never`); the process
 * stays up until interrupted (Ctrl-C / SIGTERM), at which point the scoped
 * connection and Feishu socket tear down cleanly.
 */
const main = Effect.gen(function* () {
  const config = yield* loadConfig;
  yield* program(config);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

NodeRuntime.runMain(main);
