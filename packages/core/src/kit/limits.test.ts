import { describe, expect, it } from "vitest";
import { formatAgo, formatCountdown, limitLevel, limitsTitle, windowAt } from "./limits";

describe("limits", () => {
  it("rates utilization", () => {
    expect([0.2, 0.6, 0.8].map(limitLevel)).toEqual(["ok", "warning", "critical"]);
  });

  it("formats countdowns and ages", () => {
    expect(formatCountdown(1000 + 90 * 60, 1000 * 1000)).toBe("1 h 30 min");
    expect(formatCountdown(1000 + 3 * 86400, 1000 * 1000)).toBe("3 d 0 h");
    expect(formatAgo(30000)).toBe("just now");
    expect(formatAgo(5 * 60000)).toBe("5m ago");
  });

  it("zeroes a window after its reset", () => {
    const window = { id: "five_hour", utilization: 0.5, resetsAt: 2000 };
    expect(windowAt(window, 1999 * 1000)).toBe(window);
    expect(windowAt(window, 2000 * 1000).utilization).toBe(0);
  });

  it("builds one tooltip for all windows", () => {
    const now = 1000 * 1000;
    const title = limitsTitle(
      {
        status: "allowed",
        updatedAt: now - 5 * 60000,
        windows: [
          { id: "five_hour", utilization: 0.25, resetsAt: 1000 + 90 * 60 },
          { id: "seven_day", utilization: 0.9, resetsAt: 500 },
        ],
      },
      now,
    );
    expect(title.split("\n")).toEqual([
      "Session: 25% used, resets in 1 h 30 min",
      "Weekly: 0% used, limit was reset",
      "Limit status: allowed",
      "From the last run, 5m ago. Send a message to refresh.",
    ]);
  });
});
