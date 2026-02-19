import { generateObject, generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { SYSTEM_PROMPT } from "./constants";
import type { ClarityDb } from "./db";
import { getProviderCandidates, resolveModel } from "./provider";
import { getDateTime } from "./tools/datetime";
import { memorySearch } from "./tools/memory-search";
import { webFetch } from "./tools/web-fetch";
import { webSearch } from "./tools/web-search";
import type { AppConfig, AppSecrets, DecisionRecord, ProviderName } from "./types";

interface RunWithFallbackResult<T> {
  providerUsed: ProviderName;
  result: T;
}

interface AgentContext {
  db: ClarityDb;
  config: AppConfig;
  secrets: AppSecrets;
}

export interface AgentTurnResult {
  text: string;
  providerUsed: ProviderName;
  decisionCompleted: boolean;
  completionRecord?: DecisionRecord;
}

const SummarySchema = z.object({
  title: z.string().min(1),
  userGoal: z.string().min(1),
  constraints: z.array(z.string()).default([]),
  optionsConsidered: z
    .array(
      z.object({
        option: z.string(),
        pros: z.array(z.string()).default([]),
        cons: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  recommendedOption: z.string().min(1),
  rationale: z.string().min(1),
  confidence: z.enum(["low", "medium", "high"]).default("medium"),
});

function toModelMessages(rows: Array<{ role: string; content: string }>): Array<{ role: string; content: string }> {
  return rows
    .filter((row) => row.role === "user" || row.role === "assistant")
    .map((row) => ({
      role: row.role,
      content: row.content,
    }));
}

async function runWithProviderFallback<T>(
  config: AppConfig,
  secrets: AppSecrets,
  runner: (payload: { provider: ProviderName; model: unknown }) => Promise<T>,
): Promise<RunWithFallbackResult<T>> {
  const candidates = getProviderCandidates(config, secrets);
  if (candidates.length === 0) {
    throw new Error(
      "No LLM provider API keys configured. Run 'claritycheck onboard' and add at least one provider key.",
    );
  }

  const errors: string[] = [];
  for (const candidate of candidates) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const model = resolveModel(candidate.provider, candidate.model, candidate.apiKey);
        const result = await runner({ provider: candidate.provider, model });
        return { providerUsed: candidate.provider, result };
      } catch (error) {
        const message = (error as Error).message;
        errors.push(`${candidate.provider}#${String(attempt)}: ${message}`);
        if (attempt < 2) {
          await Bun.sleep(250 + Math.floor(Math.random() * 350));
        }
      }
    }
  }

  throw new Error(`All providers failed. ${errors.join(" | ")}`);
}

function completionPrompt(messages: Array<{ role: string; content: string }>, outcomeNote?: string): string {
  const transcript = messages
    .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`)
    .join("\n\n")
    .slice(0, 18_000);
  const outcomeLine = outcomeNote ? `\nOutcome note from user: ${outcomeNote}` : "";
  return `
Summarize this completed decision conversation into structured fields.
Focus on concrete constraints, options evaluated, recommendation, and rationale.
${outcomeLine}

Transcript:
${transcript}
`;
}

export async function completeDecision(
  ctx: AgentContext,
  decisionId: string,
  outcomeNote?: string,
): Promise<{ providerUsed: ProviderName; record: DecisionRecord }> {
  const messages = toModelMessages(ctx.db.getMessages(decisionId, 120));
  const sources = ctx.db.getSources(decisionId);

  const summaryResult = await runWithProviderFallback(ctx.config, ctx.secrets, async ({ model }) => {
    const response = await generateObject({
      model: model as never,
      schema: SummarySchema,
      prompt: completionPrompt(messages, outcomeNote),
      temperature: 0.1,
    });
    return response.object;
  });

  const record: DecisionRecord = {
    id: decisionId,
    title: summaryResult.result.title,
    userGoal: summaryResult.result.userGoal,
    constraints: summaryResult.result.constraints,
    optionsConsidered: summaryResult.result.optionsConsidered,
    recommendedOption: summaryResult.result.recommendedOption,
    rationale: summaryResult.result.rationale,
    confidence: summaryResult.result.confidence,
    sources,
    outcomeNote,
  };

  ctx.db.completeDecision(decisionId, record);
  ctx.db.setActiveDecisionId(undefined);
  return {
    providerUsed: summaryResult.providerUsed,
    record,
  };
}

export async function runDecisionTurn(
  ctx: AgentContext,
  decisionId: string,
): Promise<AgentTurnResult> {
  const history = toModelMessages(ctx.db.getMessages(decisionId, 80));
  let completionRequested = false;
  let completionNote: string | undefined;

  const response = await runWithProviderFallback(ctx.config, ctx.secrets, async ({ model }) => {
    return generateText({
      model: model as never,
      system: SYSTEM_PROMPT,
      messages: history as never,
      stopWhen: stepCountIs(6),
      temperature: 0.2,
      tools: {
        web_search: tool({
          description: "Search the web for current information using Tavily/Brave.",
          inputSchema: z.object({
            query: z.string().min(2),
          }),
          execute: async ({ query }) => {
            const result = await webSearch(query, ctx.config, ctx.secrets);
            for (const item of result.results.slice(0, 5)) {
              if (item.url) {
                ctx.db.addSource(decisionId, item.title, item.url);
              }
            }
            return result;
          },
        }),
        web_fetch: tool({
          description: "Fetch and extract web page content from a URL.",
          inputSchema: z.object({
            url: z.string().min(6),
          }),
          execute: async ({ url }) => {
            const result = await webFetch(url);
            ctx.db.addSource(decisionId, result.url, result.url);
            return result;
          },
        }),
        memory_search: tool({
          description: "Retrieve relevant insights from prior completed decisions.",
          inputSchema: z.object({
            query: z.string().min(2),
          }),
          execute: async ({ query }) => memorySearch(ctx.db, query),
        }),
        datetime: tool({
          description: "Get current date and time information.",
          inputSchema: z.object({}),
          execute: async () => getDateTime(),
        }),
        mark_decision_complete: tool({
          description:
            "Mark decision as complete when user confirms they are done; include concise outcome note.",
          inputSchema: z.object({
            outcomeNote: z.string().max(400).optional(),
          }),
          execute: async ({ outcomeNote }) => {
            completionRequested = true;
            completionNote = outcomeNote;
            return {
              accepted: true,
              message: "Decision marked for completion. Final summary is being generated.",
            };
          },
        }),
      },
    });
  });

  let finalText = response.result.text.trim();
  ctx.db.addMessage(decisionId, "assistant", finalText);

  if (!completionRequested) {
    return {
      text: finalText,
      providerUsed: response.providerUsed,
      decisionCompleted: false,
    };
  }

  const completion = await completeDecision(ctx, decisionId, completionNote);
  finalText += `\n\nDecision completed. Recommendation: ${completion.record.recommendedOption}`;
  return {
    text: finalText,
    providerUsed: response.providerUsed,
    decisionCompleted: true,
    completionRecord: completion.record,
  };
}
