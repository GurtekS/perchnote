import { describe, it, expect, beforeEach } from "vitest";
import { useUIStore } from "../stores/uiStore";

beforeEach(() => {
  useUIStore.setState({
    pendingAutoStart: false,
    sidebarCollapsed: false,
  });
});

describe("pendingAutoStart", () => {
  it("defaults to false", () => {
    expect(useUIStore.getState().pendingAutoStart).toBe(false);
  });
  it("setPendingAutoStart sets value", () => {
    useUIStore.getState().setPendingAutoStart(true);
    expect(useUIStore.getState().pendingAutoStart).toBe(true);
  });
  it("setPendingAutoStart back to false", () => {
    useUIStore.getState().setPendingAutoStart(true);
    useUIStore.getState().setPendingAutoStart(false);
    expect(useUIStore.getState().pendingAutoStart).toBe(false);
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
