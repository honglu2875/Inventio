import { describe, expect, it } from "vitest";
import {
  clamp01,
  formatAgo,
  formatClock,
  formatDuration,
  formatExact,
  formatTokens,
  truncate,
} from "../src/lib/format.js";

describe("formatTokens", () => {
  it("prints small counts exactly", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("switches to k at a thousand and keeps one decimal below 10k", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(9999)).toBe("10.0k");
    expect(formatTokens(12_400)).toBe("12k");
    expect(formatTokens(999_000)).toBe("999k");
  });

  it("switches to M at a million", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(1_240_000)).toBe("1.2M");
    expect(formatTokens(40_000_000)).toBe("40M");
  });

  it("renders unknown counts as an em dash and never goes negative", () => {
    expect(formatTokens(null)).toBe("—");
    expect(formatTokens(undefined)).toBe("—");
    expect(formatTokens(Number.NaN)).toBe("—");
    expect(formatTokens(-5)).toBe("0");
  });
});

describe("formatExact", () => {
  it("groups thousands", () => {
    expect(formatExact(1_234_567)).toBe("1,234,567");
    expect(formatExact(0)).toBe("0");
    expect(formatExact(null)).toBe("—");
  });
});

describe("formatDuration", () => {
  it("covers every band", () => {
    expect(formatDuration(820)).toBe("820ms");
    expect(formatDuration(4200)).toBe("4.2s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(184_000)).toBe("3m 04s");
    expect(formatDuration(3_720_000)).toBe("1h 02m");
    expect(formatDuration(-1)).toBe("—");
  });
});

describe("truncate", () => {
  it("never exceeds max and collapses whitespace", () => {
    expect(truncate("hello world", 20)).toBe("hello world");
    expect(truncate("hello   world", 20)).toBe("hello world");
    const cut = truncate("abcdefghij", 5);
    expect(cut).toBe("abcd…");
    expect(cut.length).toBe(5);
  });

  it("handles degenerate widths", () => {
    expect(truncate("abc", 0)).toBe("");
    expect(truncate("abc", 1)).toBe("…");
  });
});

describe("formatClock / formatAgo", () => {
  it("falls back on unparseable input", () => {
    expect(formatClock("nonsense")).toBe("--:--:--");
    expect(formatAgo("nonsense")).toBe("—");
  });

  it("bands relative times", () => {
    const now = Date.parse("2024-05-05T12:00:00.000Z");
    const at = (ms: number): string => formatAgo(new Date(now - ms).toISOString(), now);
    expect(at(1000)).toBe("just now");
    expect(at(5 * 60_000)).toBe("5m ago");
    expect(at(3 * 3_600_000)).toBe("3h ago");
    expect(at(2 * 86_400_000)).toBe("2d ago");
  });

  it("renders a clock in local time", () => {
    const iso = new Date(2024, 4, 5, 13, 7, 9).toISOString();
    expect(formatClock(iso)).toBe("13:07:09");
  });
});

describe("clamp01", () => {
  it("clamps and rejects non-finite input", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
  });
});
