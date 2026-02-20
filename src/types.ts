export type ProviderName = "cerebras" | "groq" | "openrouter";

export type SearchProviderName = "tavily" | "brave";

export type Role = "system" | "user" | "assistant" | "tool";

export type VoiceReplyMode = "off" | "on" | "auto";
export type DecisionStage = "intake" | "research" | "recommendation";

export interface ProviderModels {
  cerebras: string;
  groq: string;
  openrouter: string;
}

export interface SearchConfig {
  primary?: SearchProviderName;
  fallback?: SearchProviderName;
}

export interface GatewayConfig {
  controlHost: string;
  controlPort: number;
  pollingIntervalMs: number;
}

export interface TelegramConfig {
  authorizedChatId?: number;
}

export interface MemoryConfig {
  retentionPolicy: "keep_until_deleted";
}

export interface VoiceConfig {
  replyMode: VoiceReplyMode;
  sttModel: string;
  ttsModel: string;
  ttsEncoding: "linear16";
  ttsContainer: "wav";
}

export interface AppConfig {
  version: number;
  onboardingCompleted: boolean;
  activeProvider: ProviderName;
  providerOrder: ProviderName[];
  models: ProviderModels;
  search: SearchConfig;
  gateway: GatewayConfig;
  telegram: TelegramConfig;
  memory: MemoryConfig;
  voice: VoiceConfig;
}

export interface AppSecrets {
  telegramBotToken: string;
  deepgramApiKey?: string;
  providers: Partial<Record<ProviderName, string>>;
  search: {
    tavilyApiKey?: string;
    braveApiKey?: string;
  };
}

export interface DecisionRecord {
  id: string;
  title: string;
  userGoal: string;
  constraints: string[];
  optionsConsidered: Array<{ option: string; pros: string[]; cons: string[] }>;
  recommendedOption: string;
  rationale: string;
  confidence: "low" | "medium" | "high";
  sources: Array<{ title: string; url: string; fetchedAt: string }>;
  outcomeNote?: string;
}

export interface DecisionIntakeState {
  goal?: string;
  optionsScope?: string;
  constraints: string[];
  timeline?: string;
  riskTolerance?: string;
  successCriteria?: string;
  mustAvoid?: string;
}

export interface DecisionResearchState {
  lastResearchAt?: string;
  queries: string[];
}

export interface DecisionRecommendationState {
  recommendedOption: string;
  confidence: "low" | "medium" | "high";
  rationale: string;
  updatedAt: string;
}

export interface DecisionRuntimeState {
  stage: DecisionStage;
  intake: DecisionIntakeState;
  research: DecisionResearchState;
  recommendation?: DecisionRecommendationState;
}

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
  source: SearchProviderName;
}

export interface WebSearchResult {
  query: string;
  providerUsed: SearchProviderName;
  results: WebSearchResultItem[];
}

export interface GatewayStatus {
  ok: boolean;
  pid: number;
  activeProvider: ProviderName;
  authorizedChatId?: number;
  startupPairCodeActive: boolean;
  startupPairCodeExpiresAt?: string;
}
