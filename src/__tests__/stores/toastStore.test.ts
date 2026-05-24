import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { useToastStore, toast } from "../../stores/toastStore";

describe("toastStore", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts with empty toasts", () => {
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("addToast adds a toast with generated id", () => {
    useToastStore.getState().addToast({ type: "success", message: "Done!" });
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe("Done!");
    expect(toasts[0].type).toBe("success");
    expect(toasts[0].id).toMatch(/^toast-/);
  });

  it("addToast assigns unique ids to multiple toasts", () => {
    useToastStore.getState().addToast({ type: "info", message: "A" });
    useToastStore.getState().addToast({ type: "info", message: "B" });
    const ids = useToastStore.getState().toasts.map(t => t.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("removeToast removes by id", () => {
    useToastStore.getState().addToast({ type: "success", message: "Saved" });
    const id = useToastStore.getState().toasts[0].id;
    useToastStore.getState().removeToast(id);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("removeToast only removes the specified toast", () => {
    useToastStore.getState().addToast({ type: "info", message: "A" });
    useToastStore.getState().addToast({ type: "info", message: "B" });
    const idA = useToastStore.getState().toasts[0].id;
    useToastStore.getState().removeToast(idA);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0].message).toBe("B");
  });

  it("toast auto-expires after default duration (4000ms)", () => {
    useToastStore.getState().addToast({ type: "success", message: "Temp" });
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(4000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("toast with duration=0 never auto-expires", () => {
    useToastStore.getState().addToast({ type: "info", message: "Permanent", duration: 0 });
    vi.advanceTimersByTime(60000);
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it("toast with custom duration expires after that duration", () => {
    useToastStore.getState().addToast({ type: "warning", message: "Wait", duration: 2000 });
    vi.advanceTimersByTime(1999);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  describe("toast convenience helpers", () => {
    it("toast.success adds a success toast", () => {
      toast.success("Great job");
      const t = useToastStore.getState().toasts[0];
      expect(t.type).toBe("success");
      expect(t.message).toBe("Great job");
    });

    it("toast.error adds an error toast with 6000ms duration", () => {
      toast.error("Something went wrong");
      const t = useToastStore.getState().toasts[0];
      expect(t.type).toBe("error");
      expect(t.duration).toBe(6000);
    });

    it("toast.info adds an info toast", () => {
      toast.info("FYI");
      expect(useToastStore.getState().toasts[0].type).toBe("info");
    });

    it("toast.warning adds a warning toast", () => {
      toast.warning("Be careful");
      expect(useToastStore.getState().toasts[0].type).toBe("warning");
    });
  });
});
