import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { execCommand } from "@getpaseo/plugin/server";

export function createDeepSeekHarnessProvider(): ProviderRegistration {
  const base = runAcpProvider({
    id: "deepseek-harness",
    label: "DeepSeek Harness",
    description:
      "DeepSeek Harness coding agent over ACP (dsh --profile acp) supporting modern V3/V4 models",
    icon: "icon.svg",
    command: ["dsh", "--profile", "acp"],
  });

  return {
    ...base,
    async status({ launch }) {
      if (!launch) {
        return {
          available: false,
          diagnostic:
            "dsh not found on PATH. Install DeepSeek Harness CLI: `npm i -g @deepseek-ai/dsh`",
        };
      }
      try {
        const { stdout } = await execCommand(launch.command, [...launch.args, "-V"], {
          env: launch.env,
          timeout: 4000,
          maxBuffer: 4096,
        });
        if (stdout.trim().length > 0) {
          return { available: true };
        }
        return { available: false, diagnostic: "DeepSeek Harness CLI did not report a version." };
      } catch (error) {
        return {
          available: false,
          diagnostic:
            error instanceof Error
              ? error.message
              : "Failed to probe DeepSeek Harness CLI (dsh). Ensure `dsh` is executable.",
        };
      }
    },
  };
}
