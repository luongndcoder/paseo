import { describe, expect, it, vi } from "vitest";
import { createDeepSeekHarnessProvider } from "./provider.js";
import * as serverModule from "@getpaseo/plugin/server";

describe("createDeepSeekHarnessProvider", () => {
  it("registers with id deepseek-harness and correct command", () => {
    const provider = createDeepSeekHarnessProvider();
    expect(provider.id).toBe("deepseek-harness");
    expect(provider.label).toBe("DeepSeek Harness");
    expect(provider.icon).toBe("icon.svg");
    expect(provider.command).toEqual(["dsh", "--profile", "acp"]);
    expect(typeof provider.connect).toBe("function");
    expect(typeof provider.status).toBe("function");
  });

  it("reports unavailable if launch is not provided", async () => {
    const provider = createDeepSeekHarnessProvider();
    const result = await provider.status?.({ launch: undefined });
    expect(result).toEqual({
      available: false,
      diagnostic:
        "dsh not found on PATH. Install DeepSeek Harness CLI: `npm i -g @deepseek-ai/dsh`",
    });
  });

  it("reports available when dsh -V returns version", async () => {
    const spy = vi.spyOn(serverModule, "execCommand").mockResolvedValue({
      stdout: "0.2.0-rc.2\n",
      stderr: "",
    } as Awaited<ReturnType<typeof serverModule.execCommand>>);

    const provider = createDeepSeekHarnessProvider();
    const result = await provider.status?.({
      launch: {
        command: "dsh",
        args: ["--profile", "acp"],
        env: {},
      },
    });

    expect(result).toEqual({ available: true });
    expect(spy).toHaveBeenCalledWith(
      "dsh",
      ["--profile", "acp", "-V"],
      expect.objectContaining({ timeout: 4000 }),
    );
    spy.mockRestore();
  });

  it("reports unavailable when probe fails", async () => {
    const spy = vi.spyOn(serverModule, "execCommand").mockRejectedValue(new Error("ENOENT"));

    const provider = createDeepSeekHarnessProvider();
    const result = await provider.status?.({
      launch: {
        command: "dsh",
        args: ["--profile", "acp"],
        env: {},
      },
    });

    expect(result).toEqual({
      available: false,
      diagnostic: "ENOENT",
    });
    spy.mockRestore();
  });
});
