import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActionSection } from "./ActionSection";

describe("ActionSection", () => {
  it("labels the section by its heading and applies the extra class", () => {
    render(<ActionSection id="tools-label" label="Tools" className="tool-actions"><button type="button">Pan</button></ActionSection>);
    const section = screen.getByRole("region", { name: "Tools" });
    expect(section).toHaveClass("action-section", "tool-actions");
    expect(section).toContainElement(screen.getByRole("button", { name: "Pan" }));
  });
});
