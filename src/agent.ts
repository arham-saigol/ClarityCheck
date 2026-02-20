import { generateObject, generateText } from "ai";
import { z } from "zod";
import {
  getIntakeProgress,
  getMissingIntakeFields,
  mergeIntakeState,
  missingFieldsToQuestions,
  normalizeRuntimeState,
  rankSearchResults,
} from "./decision-workflow";
import { SYSTEM_PROMPT } from "./constants";
import type { ClarityDb } from "./db";
import { getProviderCandidates, resolveModel } from "./provider";
import { getDateTime } from "./tools/datetime";
import { memorySearch } from "./tools/memory-search";
import { webFetch } from "./tools/web-fetch";
import { webSearch } from "./tools/web-search";
import type {
  AppConfig,
  AppSecrets,
  DecisionIntakeState,
  DecisionRecord,
  DecisionRuntimeState,
  ProviderName,
  WebSearchResultItem,
} from "./types";

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

const IntakeExtractionSchema = z.object({
  goal: z.string().min(2).optional(),
  optionsScope: z.string().min(2).optional(),
  constraints: z.array(z.string().min(1)).max(14).optional(),
  timeline: z.string().min(2).optional(),
  riskTolerance: z.string().min(2).optional(),
  successCriteria: z.string().min(2).optional(),
  mustAvoid: z.string().min(2).optional(),
});

const IntakeAnalysisSchema = z.object({
  acknowledgement: z.string().min(1),
  extracted: IntakeExtractionSchema.default({}),
  questions: z.array(z.string().min(4)).max(4).default([]),
});

const QueryPlanSchema = z.object({
  queries: z.array(z.string().min(3)).min(3).max(6),
});

const RecommendationSchema = z.object({
  recommendation: z.string().min(1),
  confidence: z.enum(["low", "medium", "high"]),
  rationale: z.string().min(1),
  tradeoffs: z.array(z.string().min(1)).min(1).max(6),
  rejectedAlternatives: z.array(z.string().min(1)).max(6).default([]),
  whatCouldChange: z.array(z.string().min(1)).max(6).default([]),
  responseText: z.string().min(1),
});

const FollowupActionSchema = z.object({
  action: z.enum(["clarify_existing", "reresearch"]),
  reason: z.string().min(1),
});

type DecisionSummary = z.infer<typeof SummarySchema>;

function toModelMessages(rows: Array<{ role: string; content: string }>): Array<{ role: string; content: string }> {
  return rows
    .filter((row) => row.role === "user" || row.role === "assistant")
    .map((row) => ({
      role: row.role,
      content: row.content,
    }));
}

function latestUserMessage(history: Array<{ role: string; content: string }>): string {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role === "user") {
      return history[i].content;
    }
  }
  return "";
}

function normalizeIntakePatch(patch: z.infer<typeof IntakeExtractionSchema>): Partial<DecisionIntakeState> {
  return {
    goal: patch.goal,
    optionsScope: patch.optionsScope,
    constraints: patch.constraints ?? [],
    timeline: patch.timeline,
    riskTolerance: patch.riskTolerance,
    successCriteria: patch.successCriteria,
    mustAvoid: patch.mustAvoid,
  };
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
Return ONLY valid json. Do not use markdown or extra text.
Required json keys:
- title (string)
- userGoal (string)
- constraints (string[])
- optionsConsidered ({option, pros, cons}[])
- recommendedOption (string)
- rationale (string)
- confidence ("low" | "medium" | "high")
${outcomeLine}

Transcript:
${transcript}
`;
}

function getFallbackGoal(messages: Array<{ role: string; content: string }>): string {
  const firstUser = messages.find((item) => item.role === "user")?.content?.trim();
  if (firstUser && firstUser.length > 1) {
    return firstUser.slice(0, 180);
  }
  return "Decision support";
}

function toStringArray(value: unknown, max = 12): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const output: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }
    output.push(trimmed);
    if (output.length >= max) {
      break;
    }
  }
  return output;
}

function toOptions(value: unknown): Array<{ option: string; pros: string[]; cons: string[] }> {
  if (!Array.isArray(value)) {
    return [];
  }
  const output: Array<{ option: string; pros: string[]; cons: string[] }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const row = item as Record<string, unknown>;
    const option = typeof row.option === "string" ? row.option.trim() : "";
    if (!option) {
      continue;
    }
    output.push({
      option,
      pros: toStringArray(row.pros, 8),
      cons: toStringArray(row.cons, 8),
    });
    if (output.length >= 8) {
      break;
    }
  }
  return output;
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // continue
    }
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // continue
    }
  }

  return undefined;
}

function coerceSummaryObject(
  input: unknown,
  messages: Array<{ role: string; content: string }>,
  outcomeNote?: string,
): DecisionSummary {
  const row = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const fallbackGoal = getFallbackGoal(messages);
  const fallbackTitle = fallbackGoal.slice(0, 80);
  const rawConfidence = typeof row.confidence === "string" ? row.confidence.toLowerCase() : "medium";
  const confidence: "low" | "medium" | "high" =
    rawConfidence === "low" || rawConfidence === "high" || rawConfidence === "medium"
      ? rawConfidence
      : "medium";

  return SummarySchema.parse({
    title:
      (typeof row.title === "string" && row.title.trim().length > 0 ? row.title.trim() : undefined) ??
      fallbackTitle,
    userGoal:
      (typeof row.userGoal === "string" && row.userGoal.trim().length > 0
        ? row.userGoal.trim()
        : undefined) ??
      (typeof row.goal === "string" && row.goal.trim().length > 0 ? row.goal.trim() : undefined) ??
      fallbackGoal,
    constraints: toStringArray(row.constraints, 12),
    optionsConsidered: toOptions(row.optionsConsidered ?? row.options),
    recommendedOption:
      (typeof row.recommendedOption === "string" && row.recommendedOption.trim().length > 0
        ? row.recommendedOption.trim()
        : undefined) ??
      (typeof row.recommendation === "string" && row.recommendation.trim().length > 0
        ? row.recommendation.trim()
        : undefined) ??
      "No single recommendation selected",
    rationale:
      (typeof row.rationale === "string" && row.rationale.trim().length > 0
        ? row.rationale.trim()
        : undefined) ??
      (typeof row.reasoning === "string" && row.reasoning.trim().length > 0
        ? row.reasoning.trim()
        : undefined) ??
      outcomeNote?.trim() ??
      "Summary generated from the available conversation context.",
    confidence,
  });
}

export async function completeDecision(
  ctx: AgentContext,
  decisionId: string,
  outcomeNote?: string,
): Promise<{ providerUsed: ProviderName; record: DecisionRecord }> {
  const messages = toModelMessages(ctx.db.getMessages(decisionId, 120));
  const sources = ctx.db.getSources(decisionId);
  const prompt = completionPrompt(messages, outcomeNote);

  let summaryResult: RunWithFallbackResult<DecisionSummary>;
  try {
    summaryResult = await runWithProviderFallback(ctx.config, ctx.secrets, async ({ model }) => {
      const response = await generateObject({
        model: model as never,
        schema: SummarySchema,
        prompt,
        temperature: 0.1,
      });
      return response.object;
    });
  } catch {
    try {
      summaryResult = await runWithProviderFallback(ctx.config, ctx.secrets, async ({ model }) => {
        const response = await generateText({
          model: model as never,
          temperature: 0.1,
          prompt: `${prompt}\nReturn only json.`,
        });
        const parsed = extractJsonObject(response.text);
        return coerceSummaryObject(parsed, messages, outcomeNote);
      });
    } catch {
      summaryResult = {
        providerUsed: ctx.config.activeProvider,
        result: coerceSummaryObject(undefined, messages, outcomeNote),
      };
    }
  }

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

async function runIntakeStage(
  ctx: AgentContext,
  decisionId: string,
  history: Array<{ role: string; content: string }>,
  runtime: DecisionRuntimeState,
): Promise<{ providerUsed: ProviderName; text: string; runtime: DecisionRuntimeState }> {
  const analysis = await runWithProviderFallback(ctx.config, ctx.secrets, async ({ model }) => {
    return generateObject({
      model: model as never,
      schema: IntakeAnalysisSchema,
      temperature: 0.1,
      prompt: `
${SYSTEM_PROMPT}

You are in INTAKE stage.
Your job is to gather complete context before any recommendation.
Never provide a recommendation now.
Return only json.

Current intake state (may be incomplete):
${JSON.stringify(runtime.intake, null, 2)}

Conversation:
${history.map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`).join("\n\n").slice(0, 16_000)}
`,
    });
  });

  const mergedIntake = mergeIntakeState(runtime.intake, normalizeIntakePatch(analysis.result.object.extracted));
  const missing = getMissingIntakeFields(mergedIntake);
  const progress = Math.round(getIntakeProgress(mergedIntake) * 100);

  const nextRuntime = normalizeRuntimeState({
    ...runtime,
    stage: missing.length > 0 ? "intake" : "research",
    intake: mergedIntake,
  });
  ctx.db.setDecisionRuntime(decisionId, nextRuntime);

  if (missing.length === 0) {
    return {
      providerUsed: analysis.providerUsed,
      runtime: nextRuntime,
      text: "Thanks. I have enough context now. I will research current data and return a recommendation.",
    };
  }

  const modelQuestions = analysis.result.object.questions
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const fallbackQuestions = missingFieldsToQuestions(missing);
  const allQuestions = [...modelQuestions, ...fallbackQuestions];
  const uniqueQuestions: string[] = [];
  const seen = new Set<string>();
  for (const question of allQuestions) {
    const normalized = question.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    uniqueQuestions.push(question);
  }

  const finalQuestions = uniqueQuestions.slice(0, 4);
  const questionsText =
    finalQuestions.length > 0
      ? finalQuestions.map((question, index) => `${String(index + 1)}. ${question}`).join("\n")
      : "1. Share a bit more detail on your goal, constraints, timeline, risk tolerance, and success criteria.";

  const intakeText = [
    analysis.result.object.acknowledgement.trim(),
    "",
    "Before I research and recommend, I need a few specifics:",
    questionsText,
    "",
    `Intake progress: ${String(progress)}% complete.`,
  ].join("\n");

  return {
    providerUsed: analysis.providerUsed,
    text: intakeText,
    runtime: nextRuntime,
  };
}

function fallbackQueriesFromIntake(intake: DecisionIntakeState): string[] {
  const raw = [
    intake.goal ? `${intake.goal} latest analysis` : "",
    intake.optionsScope ? `${intake.optionsScope} comparison` : "",
    intake.constraints.length > 0 ? `${intake.constraints.join(" ")} best options` : "",
    intake.timeline ? `${intake.timeline} market outlook` : "",
  ]
    .map((item) => item.trim())
    .filter((item) => item.length > 4);

  if (raw.length >= 3) {
    return raw.slice(0, 4);
  }
  const joined = [intake.goal, intake.optionsScope, intake.timeline].filter(Boolean).join(" ").trim();
  if (joined.length > 4) {
    return [joined, `${joined} latest updates`, `${joined} risks and tradeoffs`];
  }
  return ["latest evidence for this decision", "decision tradeoff analysis", "current market conditions"];
}

async function buildResearchQueries(
  ctx: AgentContext,
  intake: DecisionIntakeState,
  latestUserText: string,
): Promise<RunWithFallbackResult<string[]>> {
  try {
    const planned = await runWithProviderFallback(ctx.config, ctx.secrets, async ({ model }) => {
      return generateObject({
        model: model as never,
        schema: QueryPlanSchema,
        temperature: 0.1,
      prompt: `
Generate focused web research queries for a decision.
Return 3-6 concise, non-overlapping search queries.
Return only json.

Intake:
${JSON.stringify(intake, null, 2)}

Latest user message:
${latestUserText}
`,
      });
    });
    return {
      providerUsed: planned.providerUsed,
      result: planned.result.object.queries,
    };
  } catch {
    return {
      providerUsed: ctx.config.activeProvider,
      result: fallbackQueriesFromIntake(intake),
    };
  }
}

function compactSourceTitle(item: WebSearchResultItem): string {
  const title = item.title?.trim();
  if (title && title.length > 0) {
    return title.slice(0, 120);
  }
  return item.url.slice(0, 120);
}

function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>()]+/gi) ?? [];
  const output: string[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const normalized = match.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output.slice(0, 4);
}

async function gatherEvidence(
  ctx: AgentContext,
  decisionId: string,
  runtime: DecisionRuntimeState,
  history: Array<{ role: string; content: string }>,
): Promise<{
  queryProvider: ProviderName;
  queries: string[];
  evidenceText: string;
  sourceList: Array<{ title: string; url: string }>;
  sufficientEvidence: boolean;
}> {
  const now = getDateTime();
  const latestUserText = latestUserMessage(history);
  const queryPlan = await buildResearchQueries(ctx, runtime.intake, latestUserText);
  const queries = queryPlan.result.slice(0, 6);

  const searchItems: WebSearchResultItem[] = [];
  const searchErrors: string[] = [];

  for (const query of queries) {
    try {
      const result = await webSearch(query, ctx.config, ctx.secrets);
      searchItems.push(...result.results.slice(0, 6));
    } catch (error) {
      searchErrors.push((error as Error).message);
    }
  }

  const ranked = rankSearchResults(searchItems, now.iso);
  const topRanked = ranked.slice(0, 8);
  const userLinkedUrls = extractUrls(latestUserText);
  for (const item of topRanked) {
    if (item.url) {
      ctx.db.addSource(decisionId, compactSourceTitle(item), item.url);
    }
  }
  for (const url of userLinkedUrls) {
    ctx.db.addSource(decisionId, "User provided link", url);
  }

  const fetchTargetUrls = [
    ...topRanked.slice(0, 4).map((target) => target.url),
    ...userLinkedUrls,
  ].slice(0, 6);
  const fetchResults = await Promise.allSettled(fetchTargetUrls.map((url) => webFetch(url)));
  const fetchedDocs: Array<{ url: string; content: string; source: string }> = [];
  for (let i = 0; i < fetchResults.length; i += 1) {
    const result = fetchResults[i];
    if (result.status !== "fulfilled") {
      continue;
    }
    fetchedDocs.push({
      url: fetchTargetUrls[i],
      content: result.value.content.slice(0, 2200),
      source: result.value.source,
    });
  }

  const memoryQuery = [runtime.intake.goal, runtime.intake.optionsScope].filter(Boolean).join(" ");
  const memory = memoryQuery ? memorySearch(ctx.db, memoryQuery) : { query: "", matches: [] };

  const evidenceLines: string[] = [];
  evidenceLines.push(`Current datetime: ${now.iso} (${now.timezone})`);
  evidenceLines.push(`Intake context: ${JSON.stringify(runtime.intake)}`);
  if (queries.length > 0) {
    evidenceLines.push(`Search queries: ${queries.join(" | ")}`);
  }
  if (topRanked.length > 0) {
    evidenceLines.push("Top web search hits:");
    for (let i = 0; i < topRanked.length; i += 1) {
      const item = topRanked[i];
      const pub = item.publishedDate ? ` | published: ${item.publishedDate}` : "";
      evidenceLines.push(
        `[S${String(i + 1)}] ${item.title} | ${item.url}${pub} | ${item.snippet.slice(0, 220)}`,
      );
    }
  }
  if (fetchedDocs.length > 0) {
    evidenceLines.push("Fetched extracts:");
    for (let i = 0; i < fetchedDocs.length; i += 1) {
      const doc = fetchedDocs[i];
      evidenceLines.push(`[F${String(i + 1)}] ${doc.url} (${doc.source})`);
      evidenceLines.push(doc.content.slice(0, 900));
    }
  }
  if (memory.matches.length > 0) {
    evidenceLines.push("Relevant prior decisions:");
    for (const match of memory.matches) {
      evidenceLines.push(`- ${match.title} (${match.completedAt}): ${match.snippet}`);
    }
  }
  if (searchErrors.length > 0) {
    evidenceLines.push(`Search warnings: ${searchErrors.slice(0, 2).join(" | ")}`);
  }

  const uniqueSources = new Set(topRanked.map((item) => item.url)).size;
  const sufficientEvidence = uniqueSources >= 3 || fetchedDocs.length >= 2;

  return {
    queryProvider: queryPlan.providerUsed,
    queries,
    evidenceText: evidenceLines.join("\n").slice(0, 30_000),
    sourceList: topRanked.map((item) => ({ title: item.title, url: item.url })),
    sufficientEvidence,
  };
}

function formatRecommendationText(input: z.infer<typeof RecommendationSchema>): string {
  const lines: string[] = [];
  lines.push(`Recommendation: ${input.recommendation}`);
  lines.push(`Confidence: ${input.confidence}`);
  lines.push("");
  lines.push(`Why: ${input.rationale}`);
  if (input.tradeoffs.length > 0) {
    lines.push("");
    lines.push("Tradeoffs:");
    for (const item of input.tradeoffs) {
      lines.push(`- ${item}`);
    }
  }
  if (input.rejectedAlternatives.length > 0) {
    lines.push("");
    lines.push("Alternatives rejected:");
    for (const item of input.rejectedAlternatives) {
      lines.push(`- ${item}`);
    }
  }
  if (input.whatCouldChange.length > 0) {
    lines.push("");
    lines.push("What could change this decision:");
    for (const item of input.whatCouldChange) {
      lines.push(`- ${item}`);
    }
  }
  return lines.join("\n");
}

async function runResearchAndRecommendation(
  ctx: AgentContext,
  decisionId: string,
  history: Array<{ role: string; content: string }>,
  runtime: DecisionRuntimeState,
): Promise<{ providerUsed: ProviderName; text: string; runtime: DecisionRuntimeState }> {
  const gathered = await gatherEvidence(ctx, decisionId, runtime, history);
  const now = getDateTime();

  const runtimeWithResearch = normalizeRuntimeState({
    ...runtime,
    stage: "research",
    research: {
      ...runtime.research,
      queries: gathered.queries,
      lastResearchAt: now.iso,
    },
  });
  ctx.db.setDecisionRuntime(decisionId, runtimeWithResearch);

  if (!gathered.sufficientEvidence) {
    const text = [
      "I am still researching and not ready to give a recommendation yet.",
      "",
      "I could not gather enough high-quality sources for this turn.",
      "Please share any known links, candidate options, or more specific constraints so I can tighten the search.",
      "",
      "I will automatically continue to recommendation mode once evidence quality is strong enough.",
    ].join("\n");
    return {
      providerUsed: gathered.queryProvider,
      text,
      runtime: runtimeWithResearch,
    };
  }

  const synthesis = await runWithProviderFallback(ctx.config, ctx.secrets, async ({ model }) => {
    return generateObject({
      model: model as never,
      schema: RecommendationSchema,
      temperature: 0.2,
      prompt: `
${SYSTEM_PROMPT}

You are in RECOMMENDATION stage.
Use the evidence below to produce a stable decision recommendation.

Rules:
- Use fresh evidence and cite source tags like [S1], [S2] in responseText.
- If recommendation changes versus prior recommendation, include a line that starts with "What changed:".
- Keep the recommendation actionable and specific.
Return only json.

Prior recommendation:
${runtime.recommendation ? JSON.stringify(runtime.recommendation, null, 2) : "none"}

Evidence bundle:
${gathered.evidenceText}
`,
    });
  });

  const recommendation = synthesis.result.object;
  let recommendationText = formatRecommendationText(recommendation);
  if (runtime.recommendation && runtime.recommendation.recommendedOption !== recommendation.recommendation) {
    if (!recommendation.responseText.toLowerCase().includes("what changed:")) {
      recommendationText += "\n\nWhat changed: new evidence from this turn shifted the recommendation.";
    }
  }
  if (recommendation.responseText.trim().length > 0) {
    recommendationText = `${recommendation.responseText.trim()}\n\n${recommendationText}`;
  }
  if (gathered.sourceList.length > 0) {
    recommendationText += "\n\nSources checked:";
    for (let i = 0; i < Math.min(6, gathered.sourceList.length); i += 1) {
      const source = gathered.sourceList[i];
      recommendationText += `\n${String(i + 1)}. ${source.title} - ${source.url}`;
    }
  }

  const runtimeWithRecommendation = normalizeRuntimeState({
    ...runtimeWithResearch,
    stage: "recommendation",
    recommendation: {
      recommendedOption: recommendation.recommendation,
      confidence: recommendation.confidence,
      rationale: recommendation.rationale,
      updatedAt: now.iso,
    },
  });
  ctx.db.setDecisionRuntime(decisionId, runtimeWithRecommendation);

  return {
    providerUsed: synthesis.providerUsed,
    text: recommendationText,
    runtime: runtimeWithRecommendation,
  };
}

async function classifyRecommendationFollowup(
  ctx: AgentContext,
  history: Array<{ role: string; content: string }>,
  runtime: DecisionRuntimeState,
): Promise<"clarify_existing" | "reresearch"> {
  const latestUser = latestUserMessage(history).toLowerCase();
  if (/^(thanks|thank you|got it|ok|okay|cool|done|perfect)[.! ]*$/.test(latestUser)) {
    return "clarify_existing";
  }

  try {
    const decision = await runWithProviderFallback(ctx.config, ctx.secrets, async ({ model }) => {
      return generateObject({
        model: model as never,
        schema: FollowupActionSchema,
        temperature: 0.1,
        prompt: `
Classify the latest user message.
Return "reresearch" if user introduces new constraints, asks for newer data, questions assumptions, or asks to reconsider options.
Return "clarify_existing" only if user is asking for explanation or minor clarification without changing the decision basis.
Return only json.

Latest user message:
${latestUserMessage(history)}

Current intake:
${JSON.stringify(runtime.intake, null, 2)}

Current recommendation:
${runtime.recommendation ? JSON.stringify(runtime.recommendation, null, 2) : "none"}
`,
      });
    });
    return decision.result.object.action;
  } catch {
    return "reresearch";
  }
}

async function runRecommendationClarification(
  ctx: AgentContext,
  decisionId: string,
  history: Array<{ role: string; content: string }>,
  runtime: DecisionRuntimeState,
): Promise<{ providerUsed: ProviderName; text: string }> {
  const sources = ctx.db
    .getSources(decisionId)
    .slice(0, 8)
    .map((source, index) => `[S${String(index + 1)}] ${source.title} - ${source.url}`)
    .join("\n");

  const clarification = await runWithProviderFallback(ctx.config, ctx.secrets, async ({ model }) => {
    return generateText({
      model: model as never,
      temperature: 0.2,
      system: `${SYSTEM_PROMPT}

You are answering a follow-up on an existing recommendation.
Do not change recommendation unless user provided materially new constraints.
Ground the explanation in current recommendation and known sources.
`,
      prompt: `
Recommendation snapshot:
${runtime.recommendation ? JSON.stringify(runtime.recommendation, null, 2) : "none"}

Intake:
${JSON.stringify(runtime.intake, null, 2)}

Sources:
${sources || "none"}

Conversation:
${history.map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`).join("\n\n").slice(0, 12_000)}
`,
    });
  });

  return {
    providerUsed: clarification.providerUsed,
    text: clarification.result.text.trim(),
  };
}

export async function runDecisionTurn(
  ctx: AgentContext,
  decisionId: string,
): Promise<AgentTurnResult> {
  const history = toModelMessages(ctx.db.getMessages(decisionId, 120));
  let runtime = ctx.db.getDecisionRuntime(decisionId);
  runtime = normalizeRuntimeState(runtime);

  if (runtime.stage === "intake") {
    const intakeStep = await runIntakeStage(ctx, decisionId, history, runtime);
    if (intakeStep.runtime.stage === "intake") {
      ctx.db.addMessage(decisionId, "assistant", intakeStep.text);
      return {
        text: intakeStep.text,
        providerUsed: intakeStep.providerUsed,
        decisionCompleted: false,
      };
    }

    const researched = await runResearchAndRecommendation(ctx, decisionId, history, intakeStep.runtime);
    const combined = `${intakeStep.text}\n\n${researched.text}`;
    ctx.db.addMessage(decisionId, "assistant", combined);
    return {
      text: combined,
      providerUsed: researched.providerUsed,
      decisionCompleted: false,
    };
  }

  if (runtime.stage === "research") {
    const researched = await runResearchAndRecommendation(ctx, decisionId, history, runtime);
    ctx.db.addMessage(decisionId, "assistant", researched.text);
    return {
      text: researched.text,
      providerUsed: researched.providerUsed,
      decisionCompleted: false,
    };
  }

  const followupAction = await classifyRecommendationFollowup(ctx, history, runtime);
  if (followupAction === "clarify_existing") {
    const clarification = await runRecommendationClarification(ctx, decisionId, history, runtime);
    ctx.db.addMessage(decisionId, "assistant", clarification.text);
    return {
      text: clarification.text,
      providerUsed: clarification.providerUsed,
      decisionCompleted: false,
    };
  }

  const researched = await runResearchAndRecommendation(ctx, decisionId, history, {
    ...runtime,
    stage: "research",
  });
  ctx.db.addMessage(decisionId, "assistant", researched.text);
  return {
    text: researched.text,
    providerUsed: researched.providerUsed,
    decisionCompleted: false,
  };
}
