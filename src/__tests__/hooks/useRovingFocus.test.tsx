import { useRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useRovingFocus } from "../../hooks/useRovingFocus";

function List({ items = ["one", "two", "three"] }: { items?: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useRovingFocus(ref, "[data-roving-item]");
  return (
    <div ref={ref}>
      {items.map((label) => (
        <button key={label} data-roving-item>
          {label}
        </button>
      ))}
    </div>
  );
}

describe("useRovingFocus", () => {
  it("leaves exactly one tab stop after mount", () => {
    render(<List />);
    expect(screen.getByText("one").tabIndex).toBe(0);
    expect(screen.getByText("two").tabIndex).toBe(-1);
    expect(screen.getByText("three").tabIndex).toBe(-1);
  });

  it("ArrowDown/ArrowUp move focus and the tab stop", () => {
    render(<List />);
    const one = screen.getByText("one");
    const two = screen.getByText("two");
    one.focus();
    fireEvent.keyDown(one, { key: "ArrowDown" });
    expect(document.activeElement).toBe(two);
    expect(two.tabIndex).toBe(0);
    expect(one.tabIndex).toBe(-1);

    fireEvent.keyDown(two, { key: "ArrowUp" });
    expect(document.activeElement).toBe(one);
  });

  it("Home and End jump to the edges; arrows stop there", () => {
    render(<List />);
    const one = screen.getByText("one");
    const three = screen.getByText("three");
    one.focus();
    fireEvent.keyDown(one, { key: "End" });
    expect(document.activeElement).toBe(three);
    fireEvent.keyDown(three, { key: "ArrowDown" }); // already last
    expect(document.activeElement).toBe(three);
    fireEvent.keyDown(three, { key: "Home" });
    expect(document.activeElement).toBe(one);
  });

  it("clicking (focusing) an item moves the tab stop there", () => {
    render(<List />);
    const three = screen.getByText("three");
    fireEvent.focusIn(three, { target: three });
    expect(three.tabIndex).toBe(0);
    expect(screen.getByText("one").tabIndex).toBe(-1);
  });

  it("does not hijack arrows when focus is outside the items", () => {
    render(
      <div>
        <input aria-label="search" />
        <List />
      </div>,
    );
    const input = screen.getByLabelText("search");
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(document.activeElement).toBe(input);
  });
});
