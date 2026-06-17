import { render, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import * as matchers from "vitest-axe/matchers";
import { ConfirmDialog } from "../../components/shared/ConfirmDialog";
import { KeyboardShortcutsHelp } from "../../components/shared/KeyboardShortcutsHelp";
import { ToastContainer } from "../../components/shared/ToastContainer";
import { Announcer } from "../../components/shared/Announcer";
import { SystemAudioPermissionDialog } from "../../components/shared/SystemAudioPermissionDialog";
import { useToastStore } from "../../stores/toastStore";
import { useRecordingStore } from "../../stores/recordingStore";

expect.extend(matchers);

vi.mock("../../lib/ipc", () => ({
  ipc: {
    requestSystemAudioPermission: vi.fn().mockResolvedValue(true),
    openUrl: vi.fn().mockResolvedValue(undefined),
  },
}));

// jsdom does no real layout/painting, so color-contrast can't be computed
// here (it's covered by the design-token themes themselves). The "region"
// landmark rule is page-level and meaningless for component fragments.
const check = (el: Element) =>
  axe(el, {
    rules: {
      "color-contrast": { enabled: false },
      region: { enabled: false },
    },
  });

describe("axe: overlay components", () => {
  it("ConfirmDialog has no violations", async () => {
    const { baseElement } = render(
      <ConfirmDialog
        open
        title="Delete meeting?"
        message="This removes the recording and notes."
        variant="danger"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(await check(baseElement)).toHaveNoViolations();
  });

  it("KeyboardShortcutsHelp has no violations", async () => {
    const { baseElement } = render(<KeyboardShortcutsHelp />);
    act(() => {
      document.dispatchEvent(new CustomEvent("open-shortcuts-help"));
    });
    expect(await check(baseElement)).toHaveNoViolations();
  });

  it("SystemAudioPermissionDialog has no violations", async () => {
    act(() => {
      useRecordingStore.setState({ systemAudioPermissionRequired: true });
    });
    const { baseElement } = render(<SystemAudioPermissionDialog />);
    expect(await check(baseElement)).toHaveNoViolations();
    act(() => {
      useRecordingStore.setState({ systemAudioPermissionRequired: false });
    });
  });

  it("toasts and the announcer have no violations", async () => {
    const { baseElement } = render(
      <>
        <ToastContainer />
        <Announcer />
      </>,
    );
    act(() => {
      useToastStore.getState().addToast({ type: "success", message: "Saved" });
      useToastStore.getState().addToast({
        type: "error",
        title: "Enhance failed",
        message: "Provider unreachable",
        duration: 0,
      });
    });
    expect(await check(baseElement)).toHaveNoViolations();
  });
});
