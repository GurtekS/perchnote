import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AiNotesHeader } from "../../components/meeting/AiNotesHeader";

describe("AiNotesHeader", () => {
  it("renders one pill per tag", () => {
    render(<AiNotesHeader tags={["planning", "q3", "roadmap"]} />);
    expect(screen.getByText("planning")).toBeInTheDocument();
    expect(screen.getByText("q3")).toBeInTheDocument();
    expect(screen.getByText("roadmap")).toBeInTheDocument();
  });

  it("renders nothing when tags is empty", () => {
    const { container } = render(<AiNotesHeader tags={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("ignores blank tags", () => {
    render(<AiNotesHeader tags={["", "valid", "  "]} />);
    expect(screen.getByText("valid")).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(1);
  });
});
