import "vite-plus/test/config";
import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";

// feishu-bot ships as a standalone production bundle (dist/main.mjs), mirroring
// the server's `vp pack` setup in apps/server/vite.config.ts. `vp pack`
// externalizes this package's *declared* dependencies and inlines everything
// else; `alwaysBundle` below force-inlines the declared deps we must ship inline
// anyway. We inline the workspace packages (@t3tools/*): their `exports` resolve
// to raw `./src/*.ts`, so leaving them external would make `node dist/main.mjs`
// import `.ts` and crash. The declared third-party deps with native/dynamic
// bits — @larksuite/channel (the feishu long-connection SDK),
// @effect/platform-node, @noble/curves, effect — stay external and resolve from
// node_modules at runtime, exactly as the server bundle treats its own externals
// (undeclared transitive deps reached through @t3tools/* are inlined by pack's
// default). The bundle is therefore not zero-dependency: it still needs the
// workspace node_modules for those externals, same as apps/server/dist/bin.mjs.
function shouldBundleBotDependency(id: string): boolean {
  return id.startsWith("@t3tools/");
}

export default mergeConfig(
  baseConfig,
  defineConfig({
    pack: {
      entry: ["src/main.ts"],
      outDir: "dist",
      sourcemap: true,
      clean: true,
      deps: {
        alwaysBundle: shouldBundleBotDependency,
        onlyBundle: false,
      },
      banner: {
        js: "#!/usr/bin/env node\n",
      },
    },
  }),
);
