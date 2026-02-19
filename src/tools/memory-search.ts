import type { ClarityDb } from "../db";

export function memorySearch(db: ClarityDb, query: string): {
  query: string;
  matches: Array<{
    decisionId: string;
    title: string;
    completedAt: string;
    snippet: string;
  }>;
} {
  return {
    query,
    matches: db.searchMemories(query, 3),
  };
}

