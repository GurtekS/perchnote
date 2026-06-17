import { useRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useFocusTrap } from "../../hooks/useFocusTrap";

/** Minimal dialog shaped like the app's overlays: invoker button + two
 *  focusable controls inside the trapped container. */
function Harness({ onEscape }: { onEscape?: () => void }) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(open, dialogRef, onEscape ?? (() => setOpen(false)));
  return (
    <div>
      <button onClick={() => setOpen(true)}>invoker</button>
      {open && (
        <div ref={dialogRef} role="dialog">
          <button>first</button>
          <button>last</button>
        </div>
      )}
    </div>
  );
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("useFocusTrap", () => {
  it("wraps Tab from the last element to the first", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("invoker"));
    screen.getByText("last").focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByText("first"));
  });

  it("wraps Shift+Tab from the first element to the last", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("invoker"));
    screen.getByText("first").focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText("last"));
  });

  it("pulls focus back inside when it escaped the container", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("invoker"));
    screen.getByText("invoker").focus(); // focus outside the dialog
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByText("first"));
  });

  it("invokes onEscape for the Escape key", () => {
    const onEscape = vi.fn();
    render(<Harness onEscape={onEscape} />);
    fireEvent.click(screen.getByText("invoker"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("returns focus to the invoker when the trap deactivates", async () => {
    render(<Harness />);
    const invoker = screen.getByText("invoker");
    invoker.focus();
    fireEvent.click(invoker);
    screen.getByText("first").focus();
    fireEvent.keyDown(window, { key: "Escape" }); // closes via setOpen(false)
    await tick();
    expect(document.activeElement).toBe(invoker);
  });

  it("does not fight a deliberate focus move on close", async () => {
    render(<Harness />);
    const invoker = screen.getByText("invoker");
    invoker.focus();
    fireEvent.click(invoker);
    fireEvent.keyDown(window, { key: "Escape" });
    // Something else (e.g. route change focusing a heading) claims focus
    // before the restore timeout runs.
    const other = document.createElement("button");
    document.body.appendChild(other);
    other.focus();
    await tick();
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it("is inert while inactive", () => {
    const onEscape = vi.fn();
    render(<Harness onEscape={onEscape} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onEscape).not.toHaveBeenCalled();
  });
});
