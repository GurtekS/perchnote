import { describe, it, expect, beforeEach } from "vitest";
import { useUIStore } from "../stores/uiStore";

beforeEach(() => {
  useUIStore.setState({
    pendingAutoStart: null,
    sidebarCollapsed: false,
  });
});

describe("pendingAutoStart", () => {
  it("defaults to false", () => {
    expect(useUIStore.getState().pendingAutoStart).toBeNull();
  });
  it("setPendingAutoStart sets value", () => {
    useUIStore.getState().setPendingAutoStart("m-1");
    expect(useUIStore.getState().pendingAutoStart).toBe("m-1");
  });
  it("setPendingAutoStart back to false", () => {
    useUIStore.getState().setPendingAutoStart("m-1");
    useUIStore.getState().setPendingAutoStart(null);
    expect(useUIStore.getState().pendingAutoStart).toBeNull();
  });
});

describe("setSidebarCollapsed", () => {
  it("sets sidebarCollapsed to true", () => {
    useUIStore.getState().setSidebarCollapsed(true);
    expect(useUIStore.getState().sidebarCollapsed).toBe(true);
  });
  it("sets sidebarCollapsed to false", () => {
    useUIStore.getState().setSidebarCollapsed(true);
    useUIStore.getState().setSidebarCollapsed(false);
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
  });
});
