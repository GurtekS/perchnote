import { render, screen } from "@testing-library/react";
import { MeetingStatusBadge } from "../components/shared/MeetingStatusBadge";

describe("MeetingStatusBadge", () => {
  it("renders nothing for none status", () => {
    const { container } = render(<MeetingStatusBadge status="none" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders dot for draft status", () => {
    render(<MeetingStatusBadge status="draft" />);
    expect(screen.getByTitle("Has notes")).toBeInTheDocument();
  });

  it("renders sparkle for enhanced status", () => {
    render(<MeetingStatusBadge status="enhanced" />);
    expect(screen.getByTitle("AI enhanced")).toBeInTheDocument();
  });
});
