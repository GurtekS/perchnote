import { describe, expect, it } from "vitest";
import { invoke, resetTauriCoreMock } from "../../__mocks__/@tauri-apps/api/core";

describe("Tauri core mock", () => {
  it("resets settings state and invoke history deterministically", async () => {
    resetTauriCoreMock();

    await invoke("set_setting", { key: "onboarding_completed", value: "true" });
    await expect(invoke("get_setting", { key: "onboarding_completed" })).resolves.toBe("true");
    expect(invoke).toHaveBeenCalledTimes(2);

    resetTauriCoreMock();

    await expect(invoke("get_setting", { key: "onboarding_completed" })).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("supports local command overrides without leaking them across resets", async () => {
    resetTauriCoreMock({
      commandHandlers: {
        list_meetings: () => [{ id: "fixture-meeting", title: "Fixture meeting" }],
      },
    });

    await expect(invoke("list_meetings")).resolves.toEqual([
      { id: "fixture-meeting", title: "Fixture meeting" },
    ]);

    resetTauriCoreMock();

    await expect(invoke("list_meetings")).resolves.toEqual([]);
  });
});
