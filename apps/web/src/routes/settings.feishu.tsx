import { createFileRoute } from "@tanstack/react-router";

import { FeishuSettingsPanel } from "../components/settings/FeishuSettings";

function SettingsFeishuRoute() {
  return <FeishuSettingsPanel />;
}

export const Route = createFileRoute("/settings/feishu")({
  component: SettingsFeishuRoute,
});
