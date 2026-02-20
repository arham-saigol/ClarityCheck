import { expect, test } from "bun:test";
import {
  createEmptyRuntimeState,
  getMissingIntakeFields,
  mergeIntakeState,
  rankSearchResults,
  shouldTransitionToResearch,
} from "../src/decision-workflow";
import type { DecisionIntakeState } from "../src/types";

test("intake stays in question stage until required fields are complete", () => {
  const runtime = createEmptyRuntimeState("Buy a car");
  expect(runtime.stage).toBe("intake");
  expect(shouldTransitionToResearch(runtime.intake)).toBe(false);
  expect(getMissingIntakeFields(runtime.intake).length).toBeGreaterThan(0);
});

test("mergeIntakeState enables transition after required context is filled", () => {
  const partial: DecisionIntakeState = {
    goal: "Choose a laptop for software work",
    constraints: ["max $1800"],
  };

  const merged = mergeIntakeState(partial, {
    optionsScope: "MacBook Air M3 vs ThinkPad X1 Carbon",
    timeline: "within 2 weeks",
    riskTolerance: "medium",
    successCriteria: "best reliability + battery for travel",
    constraints: ["Linux compatibility if possible"],
  });

  expect(merged.constraints.length).toBe(2);
  expect(getMissingIntakeFields(merged)).toEqual([]);
  expect(shouldTransitionToResearch(merged)).toBe(true);
});

test("rankSearchResults prefers stronger and fresher sources", () => {
  const ranked = rankSearchResults(
    [
      {
        title: "Old blog",
        url: "https://example.com/blog-post",
        snippet: "short snippet",
        source: "brave",
        publishedDate: "2021-01-01",
      },
      {
        title: "Government update",
        url: "https://www.sec.gov/news/press-release-2026",
        snippet: "Detailed and longer snippet about market policy changes and updated filing guidance.",
        source: "tavily",
        publishedDate: "2026-02-10",
      },
    ],
    "2026-02-20T10:00:00.000Z",
  );

  expect(ranked.length).toBe(2);
  expect(ranked[0].url).toContain("sec.gov");
});

