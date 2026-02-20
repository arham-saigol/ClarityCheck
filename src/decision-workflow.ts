import type {
  DecisionIntakeState,
  DecisionRuntimeState,
  DecisionStage,
  WebSearchResultItem,
} from "./types";

export const INTAKE_FIELD_LABELS = {
  goal: "decision goal",
  optionsScope: "options under consideration",
  constraints: "hard constraints",
  timeline: "timeline",
  riskTolerance: "risk tolerance",
  successCriteria: "success criteria",
} as const;

export type IntakeFieldKey = keyof typeof INTAKE_FIELD_LABELS;

const REQUIRED_INTAKE_FIELDS: IntakeFieldKey[] = [
  "goal",
  "optionsScope",
  "constraints",
  "timeline",
  "riskTolerance",
  "successCriteria",
];

const TRUSTED_DOMAIN_BONUS: Record<string, number> = {
  gov: 8,
  edu: 6,
  org: 4,
};

export function createEmptyRuntimeState(userGoal?: string): DecisionRuntimeState {
  const goal = userGoal?.trim();
  return {
    stage: "intake",
    intake: {
      goal: goal && goal.length > 4 ? goal : undefined,
      constraints: [],
    },
    research: {
      queries: [],
    },
  };
}

export function normalizeRuntimeState(
  input: Partial<DecisionRuntimeState> | undefined,
  fallbackGoal?: string,
): DecisionRuntimeState {
  if (!input) {
    return createEmptyRuntimeState(fallbackGoal);
  }

  const stage = normalizeStage(input.stage);
  return {
    stage,
    intake: normalizeIntake(input.intake, fallbackGoal),
    research: {
      lastResearchAt: trimOrUndefined(input.research?.lastResearchAt),
      queries: normalizeStringList(input.research?.queries ?? []),
    },
    recommendation: input.recommendation
      ? {
          recommendedOption: trimOrUndefined(input.recommendation.recommendedOption) ?? "Unknown",
          confidence: input.recommendation.confidence ?? "medium",
          rationale: trimOrUndefined(input.recommendation.rationale) ?? "No rationale provided.",
          updatedAt: trimOrUndefined(input.recommendation.updatedAt) ?? new Date().toISOString(),
        }
      : undefined,
  };
}

function normalizeStage(stage: DecisionStage | undefined): DecisionStage {
  if (stage === "intake" || stage === "research" || stage === "recommendation") {
    return stage;
  }
  return "intake";
}

function normalizeIntake(
  intake: Partial<DecisionIntakeState> | undefined,
  fallbackGoal?: string,
): DecisionIntakeState {
  const goal = trimOrUndefined(intake?.goal) ?? trimOrUndefined(fallbackGoal);
  return {
    goal,
    optionsScope: trimOrUndefined(intake?.optionsScope),
    constraints: normalizeStringList(intake?.constraints ?? []),
    timeline: trimOrUndefined(intake?.timeline),
    riskTolerance: trimOrUndefined(intake?.riskTolerance),
    successCriteria: trimOrUndefined(intake?.successCriteria),
    mustAvoid: trimOrUndefined(intake?.mustAvoid),
  };
}

function normalizeStringList(values: string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(trimmed);
  }
  return output.slice(0, 14);
}

function trimOrUndefined(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function mergeIntakeState(
  current: DecisionIntakeState,
  patch: Partial<DecisionIntakeState>,
): DecisionIntakeState {
  return normalizeIntake({
    ...current,
    ...patch,
    constraints: [...(current.constraints ?? []), ...(patch.constraints ?? [])],
  });
}

export function getMissingIntakeFields(intake: DecisionIntakeState): IntakeFieldKey[] {
  const missing: IntakeFieldKey[] = [];
  for (const field of REQUIRED_INTAKE_FIELDS) {
    if (field === "constraints") {
      if (!intake.constraints || intake.constraints.length === 0) {
        missing.push(field);
      }
      continue;
    }
    const value = intake[field];
    if (typeof value !== "string" || value.trim().length < 2) {
      missing.push(field);
    }
  }
  return missing;
}

export function getIntakeProgress(intake: DecisionIntakeState): number {
  const missing = getMissingIntakeFields(intake).length;
  const total = REQUIRED_INTAKE_FIELDS.length;
  return Math.max(0, Math.min(1, (total - missing) / total));
}

export function shouldTransitionToResearch(intake: DecisionIntakeState): boolean {
  return getMissingIntakeFields(intake).length === 0;
}

export function missingFieldsToQuestions(missing: IntakeFieldKey[]): string[] {
  const questions: string[] = [];
  for (const field of missing) {
    if (field === "goal") {
      questions.push("What exact decision do you want to make?");
      continue;
    }
    if (field === "optionsScope") {
      questions.push("Which options are currently on the table?");
      continue;
    }
    if (field === "constraints") {
      questions.push("What are your hard constraints (budget, non-negotiables, limits)?");
      continue;
    }
    if (field === "timeline") {
      questions.push("What is your deadline or decision timeline?");
      continue;
    }
    if (field === "riskTolerance") {
      questions.push("How much risk are you willing to accept: low, medium, or high?");
      continue;
    }
    if (field === "successCriteria") {
      questions.push("How will we define a successful outcome?");
    }
  }
  return questions.slice(0, 4);
}

export interface RankedSearchResult extends WebSearchResultItem {
  score: number;
  rank: number;
}

function recencyBonus(publishedDate: string | undefined, now: Date): number {
  if (!publishedDate) {
    return 0;
  }
  const parsed = Date.parse(publishedDate);
  if (Number.isNaN(parsed)) {
    return 0;
  }
  const diffDays = Math.floor((now.getTime() - parsed) / 86_400_000);
  if (diffDays <= 7) return 10;
  if (diffDays <= 30) return 6;
  if (diffDays <= 120) return 3;
  return 0;
}

function domainBonus(url: string): number {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const parts = hostname.split(".");
    const tld = parts[parts.length - 1];
    return TRUSTED_DOMAIN_BONUS[tld] ?? 0;
  } catch {
    return 0;
  }
}

export function rankSearchResults(results: WebSearchResultItem[], nowIso: string): RankedSearchResult[] {
  const now = new Date(nowIso);
  const deduped: WebSearchResultItem[] = [];
  const seenUrls = new Set<string>();
  for (const item of results) {
    const normalizedUrl = item.url.trim();
    if (!normalizedUrl || seenUrls.has(normalizedUrl)) {
      continue;
    }
    seenUrls.add(normalizedUrl);
    deduped.push({ ...item, url: normalizedUrl });
  }

  const scored = deduped.map((item, index) => {
    const positionScore = Math.max(0, 14 - index);
    const freshness = recencyBonus(item.publishedDate, now);
    const reliability = domainBonus(item.url);
    const snippetSignal = Math.min(5, Math.floor(item.snippet.length / 120));
    const score = positionScore + freshness + reliability + snippetSignal;
    return { ...item, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((item, index) => ({ ...item, rank: index + 1 }));
}

