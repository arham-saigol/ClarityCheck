import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ClarityDb } from "../src/db";

test("decision lifecycle and memory search", () => {
  const dbPath = join(tmpdir(), `claritycheck-test-${randomUUID()}.sqlite`);
  const db = new ClarityDb(dbPath);

  const decisionId = db.createDecision("Laptop purchase", "Need a lightweight coding laptop");
  db.addMessage(decisionId, "user", "I need long battery life and Linux compatibility.");
  db.addMessage(decisionId, "assistant", "Let's compare options.");
  db.completeDecision(decisionId, {
    id: decisionId,
    title: "Laptop purchase",
    userGoal: "Pick a laptop",
    constraints: ["battery life", "linux support"],
    optionsConsidered: [
      { option: "Model A", pros: ["battery"], cons: ["price"] },
      { option: "Model B", pros: ["price"], cons: ["weight"] },
    ],
    recommendedOption: "Model A",
    rationale: "Best balance for portability and Linux support.",
    confidence: "high",
    sources: [],
  });

  const matches = db.searchMemories("linux battery", 3);
  expect(matches.length).toBeGreaterThan(0);
  expect(matches[0]?.title).toContain("Laptop");

  db.close();
  rmSync(dbPath, { force: true });
});

