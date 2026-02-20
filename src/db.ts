import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { createEmptyRuntimeState, normalizeRuntimeState } from "./decision-workflow";
import type { DecisionRecord, DecisionRuntimeState, Role } from "./types";

interface MessageRow {
  role: Role;
  content: string;
}

export interface MemoryMatch {
  decisionId: string;
  title: string;
  snippet: string;
  completedAt: string;
}

export class ClarityDb {
  readonly db: Database;

  constructor(filename: string) {
    this.db = new Database(filename, { create: true });
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        user_goal TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        decision_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS decision_summaries (
        decision_id TEXT PRIMARY KEY,
        summary_json TEXT NOT NULL,
        search_blob TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        decision_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS decision_runtime (
        decision_id TEXT PRIMARY KEY,
        stage TEXT NOT NULL,
        intake_json TEXT NOT NULL,
        research_json TEXT NOT NULL,
        recommendation_json TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_decision_id ON messages(decision_id);
      CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions(status);
      CREATE INDEX IF NOT EXISTS idx_sources_decision_id ON sources(decision_id);
      CREATE INDEX IF NOT EXISTS idx_decision_runtime_stage ON decision_runtime(stage);
    `);
  }

  close(): void {
    this.db.close();
  }

  getRuntimeState(key: string): string | undefined {
    const row = this.db
      .query("SELECT value FROM runtime_state WHERE key = ?1")
      .get(key) as { value?: string } | null;
    return row?.value;
  }

  setRuntimeState(key: string, value: string): void {
    this.db
      .query(
        `
          INSERT INTO runtime_state(key, value)
          VALUES (?1, ?2)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `,
      )
      .run(key, value);
  }

  getActiveDecisionId(): string | undefined {
    return this.getRuntimeState("active_decision_id");
  }

  setActiveDecisionId(decisionId: string | undefined): void {
    if (!decisionId) {
      this.db.query("DELETE FROM runtime_state WHERE key = 'active_decision_id'").run();
      return;
    }
    this.setRuntimeState("active_decision_id", decisionId);
  }

  createDecision(title: string, userGoal: string): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .query(
        `
        INSERT INTO decisions(id, title, status, user_goal, created_at)
        VALUES (?1, ?2, 'active', ?3, ?4)
      `,
      )
      .run(id, title, userGoal, now);
    const runtime = createEmptyRuntimeState(userGoal);
    this.db
      .query(
        `
          INSERT INTO decision_runtime(decision_id, stage, intake_json, research_json, recommendation_json, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        `,
      )
      .run(
        id,
        runtime.stage,
        JSON.stringify(runtime.intake),
        JSON.stringify(runtime.research),
        runtime.recommendation ? JSON.stringify(runtime.recommendation) : null,
        now,
      );
    this.setActiveDecisionId(id);
    return id;
  }

  private ensureDecisionRuntime(decisionId: string): void {
    const existing = this.db
      .query("SELECT decision_id FROM decision_runtime WHERE decision_id = ?1")
      .get(decisionId) as { decision_id?: string } | null;
    if (existing?.decision_id) {
      return;
    }

    const decision = this.db
      .query("SELECT user_goal FROM decisions WHERE id = ?1")
      .get(decisionId) as { user_goal?: string } | null;
    const runtime = createEmptyRuntimeState(decision?.user_goal);
    const now = new Date().toISOString();
    this.db
      .query(
        `
          INSERT INTO decision_runtime(decision_id, stage, intake_json, research_json, recommendation_json, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        `,
      )
      .run(
        decisionId,
        runtime.stage,
        JSON.stringify(runtime.intake),
        JSON.stringify(runtime.research),
        null,
        now,
      );
  }

  getDecisionRuntime(decisionId: string): DecisionRuntimeState {
    this.ensureDecisionRuntime(decisionId);
    const row = this.db
      .query(
        `
          SELECT stage, intake_json, research_json, recommendation_json
          FROM decision_runtime
          WHERE decision_id = ?1
        `,
      )
      .get(decisionId) as
      | {
          stage?: string;
          intake_json?: string;
          research_json?: string;
          recommendation_json?: string | null;
        }
      | null;

    if (!row) {
      return createEmptyRuntimeState();
    }

    const intake = this.parseJson(row.intake_json, {}) as DecisionRuntimeState["intake"];
    const research = this.parseJson(row.research_json, {}) as DecisionRuntimeState["research"];
    const recommendation = row.recommendation_json
      ? (this.parseJson(
          row.recommendation_json,
          undefined,
        ) as DecisionRuntimeState["recommendation"] | undefined)
      : undefined;

    return normalizeRuntimeState({
      stage: row.stage as DecisionRuntimeState["stage"],
      intake,
      research,
      recommendation,
    });
  }

  setDecisionRuntime(decisionId: string, runtime: DecisionRuntimeState): void {
    this.ensureDecisionRuntime(decisionId);
    const now = new Date().toISOString();
    const normalized = normalizeRuntimeState(runtime);
    this.db
      .query(
        `
          UPDATE decision_runtime
          SET stage = ?2,
              intake_json = ?3,
              research_json = ?4,
              recommendation_json = ?5,
              updated_at = ?6
          WHERE decision_id = ?1
        `,
      )
      .run(
        decisionId,
        normalized.stage,
        JSON.stringify(normalized.intake),
        JSON.stringify(normalized.research),
        normalized.recommendation ? JSON.stringify(normalized.recommendation) : null,
        now,
      );
  }

  updateDecisionRuntime(
    decisionId: string,
    updater: (runtime: DecisionRuntimeState) => DecisionRuntimeState,
  ): DecisionRuntimeState {
    const current = this.getDecisionRuntime(decisionId);
    const next = normalizeRuntimeState(updater(current), current.intake.goal);
    this.setDecisionRuntime(decisionId, next);
    return next;
  }

  addMessage(decisionId: string, role: Role, content: string): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `
          INSERT INTO messages(decision_id, role, content, created_at)
          VALUES (?1, ?2, ?3, ?4)
        `,
      )
      .run(decisionId, role, content, now);
  }

  getMessages(decisionId: string, limit = 80): MessageRow[] {
    return this.db
      .query(
        `
          SELECT role, content
          FROM messages
          WHERE decision_id = ?1
          ORDER BY id DESC
          LIMIT ?2
        `,
      )
      .all(decisionId, limit)
      .reverse() as MessageRow[];
  }

  getDecision(decisionId: string): { id: string; title: string; status: string } | undefined {
    const row = this.db
      .query("SELECT id, title, status FROM decisions WHERE id = ?1")
      .get(decisionId) as { id: string; title: string; status: string } | null;
    return row ?? undefined;
  }

  completeDecision(decisionId: string, record: DecisionRecord): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `
          UPDATE decisions
          SET status = 'completed',
              completed_at = ?2
          WHERE id = ?1
        `,
      )
      .run(decisionId, now);

    this.updateDecisionRuntime(decisionId, (runtime) => ({
      ...runtime,
      stage: "recommendation",
    }));

    const searchBlob = [
      record.title,
      record.userGoal,
      ...record.constraints,
      record.recommendedOption,
      record.rationale,
      ...record.optionsConsidered.map((item) => item.option),
    ]
      .join(" ")
      .toLowerCase();

    this.db
      .query(
        `
          INSERT INTO decision_summaries(decision_id, summary_json, search_blob)
          VALUES (?1, ?2, ?3)
          ON CONFLICT(decision_id) DO UPDATE SET
            summary_json = excluded.summary_json,
            search_blob = excluded.search_blob
        `,
      )
      .run(decisionId, JSON.stringify(record), searchBlob);

    this.db.query("DELETE FROM sources WHERE decision_id = ?1").run(decisionId);
    const insertSource = this.db.query(
      `
        INSERT INTO sources(decision_id, title, url, fetched_at)
        VALUES (?1, ?2, ?3, ?4)
      `,
    );
    for (const source of record.sources) {
      insertSource.run(decisionId, source.title, source.url, source.fetchedAt);
    }
  }

  addSource(decisionId: string, title: string, url: string): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `
          INSERT INTO sources(decision_id, title, url, fetched_at)
          VALUES (?1, ?2, ?3, ?4)
        `,
      )
      .run(decisionId, title, url, now);
  }

  getSources(decisionId: string): Array<{ title: string; url: string; fetchedAt: string }> {
    const rows = this.db
      .query(
        `
          SELECT title, url, fetched_at
          FROM sources
          WHERE decision_id = ?1
          ORDER BY id DESC
          LIMIT 30
        `,
      )
      .all(decisionId) as Array<{ title: string; url: string; fetched_at: string }>;

    const seen = new Set<string>();
    const output: Array<{ title: string; url: string; fetchedAt: string }> = [];
    for (const row of rows) {
      if (seen.has(row.url)) {
        continue;
      }
      seen.add(row.url);
      output.push({ title: row.title, url: row.url, fetchedAt: row.fetched_at });
    }
    return output.slice(0, 10);
  }

  searchMemories(query: string, limit = 3): MemoryMatch[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return [];
    }

    const rows = this.db
      .query(
        `
          SELECT
            d.id as decision_id,
            d.title as title,
            d.completed_at as completed_at,
            s.search_blob as search_blob
          FROM decisions d
          JOIN decision_summaries s ON s.decision_id = d.id
          WHERE d.status = 'completed'
          ORDER BY d.completed_at DESC
          LIMIT 50
        `,
      )
      .all() as Array<{
      decision_id: string;
      title: string;
      completed_at: string;
      search_blob: string;
    }>;

    const terms = normalized.split(/\s+/).filter(Boolean);
    const scored = rows
      .map((row) => {
        let score = 0;
        for (const term of terms) {
          if (row.search_blob.includes(term)) {
            score += 1;
          }
        }
        return {
          row,
          score,
        };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored.map(({ row }) => ({
      decisionId: row.decision_id,
      title: row.title,
      completedAt: row.completed_at,
      snippet: row.search_blob.slice(0, 220),
    }));
  }

  getCompletedDecisionRecord(decisionId: string): DecisionRecord | undefined {
    const row = this.db
      .query("SELECT summary_json FROM decision_summaries WHERE decision_id = ?1")
      .get(decisionId) as { summary_json?: string } | null;
    if (!row?.summary_json) {
      return undefined;
    }
    return JSON.parse(row.summary_json) as DecisionRecord;
  }

  private parseJson<T>(raw: string | undefined, fallback: T): T {
    if (!raw) {
      return fallback;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
}
