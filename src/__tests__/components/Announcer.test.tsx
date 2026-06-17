import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Announcer } from "../../components/shared/Announcer";
import { announce } from "../../lib/announce";
import { toast } from "../../stores/toastStore";

const settle = () => new Promise((r) => setTimeout(r, 60));

describe("Announcer", () => {
  it("routes polite announcements into the status region", async () => {
    const { container, unmount } = render(<Announcer />);
    announce("Enhancing notes…");
    await settle();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Enhancing notes…");
    unmount();
  });

  it("success toasts announce politely, error toasts assertively", async () => {
    const { container, unmount } = render(<Announcer />);
    toast.success("Notes enhanced");
    await settle();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Notes enhanced");

    toast.error("Something broke", "Enhancement failed");
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Enhancement failed. Something broke",
    );
    unmount();
  });

  it("announce is a no-op without a mounted Announcer", () => {
    expect(() => announce("nobody listening")).not.toThrow();
  });
});
