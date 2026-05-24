import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialog } from "../../components/shared/ConfirmDialog";

describe("ConfirmDialog", () => {
  const defaultProps = {
    open: true,
    title: "Delete Meeting",
    message: "This action cannot be undone.",
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };

  it("renders nothing when open=false", () => {
    const { container } = render(<ConfirmDialog {...defaultProps} open={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders title and message when open=true", () => {
    render(<ConfirmDialog {...defaultProps} />);
    expect(screen.getByText("Delete Meeting")).toBeInTheDocument();
    expect(screen.getByText("This action cannot be undone.")).toBeInTheDocument();
  });

  it("shows default button labels", () => {
    render(<ConfirmDialog {...defaultProps} />);
    expect(screen.getByText("Confirm")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("shows custom button labels when provided", () => {
    render(<ConfirmDialog {...defaultProps} confirmLabel="Delete" cancelLabel="Keep" />);
    expect(screen.getByText("Delete")).toBeInTheDocument();
    expect(screen.getByText("Keep")).toBeInTheDocument();
  });

  it("calls onConfirm when confirm button is clicked", async () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog {...defaultProps} onConfirm={onConfirm} />);
    await userEvent.click(screen.getByText("Confirm"));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("calls onCancel when cancel button is clicked", async () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog {...defaultProps} onCancel={onCancel} />);
    await userEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("calls onCancel when backdrop is clicked", async () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog {...defaultProps} onCancel={onCancel} />);
    // The backdrop is the first absolute div
    const backdrop = document.querySelector(".absolute.inset-0") as HTMLElement;
    await userEvent.click(backdrop);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("calls onCancel when Escape key is pressed", async () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog {...defaultProps} onCancel={onCancel} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("shows danger icon when variant=danger", () => {
    render(<ConfirmDialog {...defaultProps} variant="danger" />);
    // AlertTriangle icon renders as an SVG inside the danger indicator
    const dangerIcon = document.querySelector(".text-recording");
    expect(dangerIcon).toBeInTheDocument();
  });

  it("does not show danger icon when variant=default", () => {
    render(<ConfirmDialog {...defaultProps} variant="default" />);
    const dangerIcon = document.querySelector(".text-recording");
    expect(dangerIcon).not.toBeInTheDocument();
  });

  it("cancel button receives focus when dialog opens", () => {
    render(<ConfirmDialog {...defaultProps} />);
    const cancelBtn = screen.getByText("Cancel");
    expect(document.activeElement).toBe(cancelBtn);
  });
});
