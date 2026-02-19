import type { AppConfig } from "./types";

export const APP_NAME = "claritycheck";
export const CONFIG_VERSION = 1;
export const CONTROL_DEFAULT_HOST = "127.0.0.1";
export const CONTROL_DEFAULT_PORT = 47811;
export const DEFAULT_POLL_MS = 1300;
export const STARTUP_PAIR_TTL_MS = 15 * 60_000;
export const CLI_PAIR_TTL_MS = 10 * 60_000;
export const DEFAULT_PROVIDER_ORDER: Array<"cerebras" | "groq" | "openrouter"> = [
  "cerebras",
  "groq",
  "openrouter",
];

export const DEFAULT_MODELS = {
  cerebras: "zai-glm-4.7",
  groq: "moonshotai/kimi-k2-instruct-0905",
  openrouter: "arcee-ai/trinity-large-preview:free",
} as const;

export const DEFAULT_CONFIG: AppConfig = {
  version: CONFIG_VERSION,
  onboardingCompleted: false,
  activeProvider: "cerebras",
  providerOrder: [...DEFAULT_PROVIDER_ORDER],
  models: { ...DEFAULT_MODELS },
  search: {
    primary: undefined,
    fallback: undefined,
  },
  gateway: {
    controlHost: CONTROL_DEFAULT_HOST,
    controlPort: CONTROL_DEFAULT_PORT,
    pollingIntervalMs: DEFAULT_POLL_MS,
  },
  telegram: {},
  memory: {
    retentionPolicy: "keep_until_deleted",
  },
  voice: {
    replyMode: "auto",
    sttModel: "nova-3",
    ttsModel: "aura-2-thalia-en",
    ttsEncoding: "linear16",
    ttsContainer: "wav",
  },
};

export const SYSTEM_PROMPT = `
You are ClarityCheck, a rigorous decision assistant.

Operating contract:
1) Goal first: identify the user's desired decision outcome and constraints.
2) Research discipline: if the question is time-sensitive, factual, high-stakes, or uncertain, run web_search and web_fetch before advising.
3) Hard questions: ask concise, high-leverage clarification questions only when missing information would materially change the recommendation.
4) Decision quality: provide options, tradeoffs, recommendation, confidence, and why alternatives were rejected.
5) Transparency: cite key sources when external info is used.
6) Memory use: consult memory_search when relevant to prior decisions.
7) Completion: when user indicates they are done, call mark_decision_complete with a concise outcome note.

Style:
- Direct, calm, professional.
- No fluff, no hedging loops.
- Keep responses concise but complete for the decision at hand.
`;
