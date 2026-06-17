import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KeyboardShortcutsHelp } from "../../components/shared/KeyboardShortcutsHelp";

describe("KeyboardShortcutsHelp", () => {
  it("is hidden until the open event, then closes on Escape", () => {
    render(<KeyboardShortcutsHelp />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent(document, new CustomEvent("open-shortcuts-help"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Keyboard shortcuts")).toBeInTheDocument();
    expect(screen.getByText("⌘1–⌘5")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("toggles closed when the event fires again", () => {
    render(<KeyboardShortcutsHelp />);
    fireEvent(document, new CustomEvent("open-shortcuts-help"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent(document, new CustomEvent("open-shortcuts-help"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes on backdrop click but not on panel click", () => {
    const { container } = render(<KeyboardShortcutsHelp />);
    fireEvent(document, new CustomEvent("open-shortcuts-help"));

    fireEvent.click(screen.getByText("Keyboard shortcuts"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    const backdrop = container.querySelector(".absolute.inset-0");
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
