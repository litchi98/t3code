import * as Schema from "effect/Schema";

import { PortSchema } from "./baseSchemas.ts";

export const DesktopBackendBootstrap = Schema.Struct({
  mode: Schema.Literal("desktop"),
  noBrowser: Schema.Boolean,
  // Optional (unlike `noBrowser`) so existing desktop bootstrap envelopes — which
  // never set it — still decode. Absent means "defer to the server default"
  // (managed=true). Kept here to mirror `noBrowser`'s precedence chain.
  feishuBotManaged: Schema.optional(Schema.Boolean),
  port: PortSchema,
  t3Home: Schema.String,
  host: Schema.String,
  desktopBootstrapToken: Schema.String,
  tailscaleServeEnabled: Schema.Boolean,
  tailscaleServePort: PortSchema,
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
});

export type DesktopBackendBootstrap = typeof DesktopBackendBootstrap.Type;
