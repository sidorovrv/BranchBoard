import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LimitsMeter } from "./LimitsMeter";

const now = 1000 * 1000;

describe("LimitsMeter", () => {
  it("shows only percentages separated by a slash", () => {
    const html = renderToStaticMarkup(
      <LimitsMeter
        now={now}
        limits={{
          status: "allowed",
          updatedAt: now,
          windows: [
            { id: "five_hour", utilization: 0.25, resetsAt: 5000 },
            { id: "seven_day", utilization: 0.9, resetsAt: 5000 },
          ],
        }}
      />,
    );
    expect(html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|")).toBe("|25%|/|90%|");
    expect(html).toContain("limit-value ok");
    expect(html).toContain("limit-value critical");
    expect(html).toContain("Session: 25% used, resets in");
  });

  it("renders nothing without windows", () => {
    expect(renderToStaticMarkup(<LimitsMeter now={now} limits={{ status: "allowed", updatedAt: now, windows: [] }} />)).toBe("");
  });
});
