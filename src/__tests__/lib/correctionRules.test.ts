import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addCorrectionRule,
  loadCorrectionRules,
  removeCorrectionRule,
} from "../../lib/correctionRules";
import { ipc } from "../../lib/ipc";

vi.mock("../../lib/ipc", () => ({
  ipc: { getSetting: vi.fn(), setSetting: vi.fn() },
}));

describe("correction rules store (plan v10 #5)", () => {
  let stored: string | null = null;
  beforeEach(() => {
    stored = null;
    vi.clearAllMocks();
    vi.mocked(ipc.getSetting).mockImplementation(async () => stored);
    vi.mocked(ipc.setSetting).mockImplementation(async (_k, v) => {
      stored = v;
    });
  });

  it("loads leniently: absent, malformed, and wrong-shape all yield []", async () => {
    expect(await loadCorrectionRules()).toEqual([]);
    stored = "not json";
    expect(await loadCorrectionRules()).toEqual([]);
    stored = '{"find":"x"}';
    expect(await loadCorrectionRules()).toEqual([]);
    stored = '[{"find":"  ","replace":"x"},{"find":"jon","replace":"John"}]';
    expect(await loadCorrectionRules()).toEqual([{ find: "jon", replace: "John" }]);
  });

  it("add appends, re-add with different casing updates instead of duplicating", async () => {
    await addCorrectionRule("jon", "John");
    await addCorrectionRule("perk note", "Perchnote");
    expect(await loadCorrectionRules()).toHaveLength(2);

    await addCorrectionRule("JON", "Jonathan");
    const rules = await loadCorrectionRules();
    expect(rules).toHaveLength(2);
    expect(rules.find((r) => r.find.toLowerCase() === "jon")?.replace).toBe("Jonathan");
  });

  it("remove is case-insensitive and blank adds are no-ops", async () => {
    await addCorrectionRule("jon", "John");
    await addCorrectionRule("  ", "x");
    await addCorrectionRule("y", "  ");
    expect(await loadCorrectionRules()).toHaveLength(1);

    await removeCorrectionRule("JON");
    expect(await loadCorrectionRules()).toEqual([]);
  });
});
