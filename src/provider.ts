import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { AppConfig, AppSecrets, ProviderName } from "./types";

interface ProviderCandidate {
  provider: ProviderName;
  apiKey: string;
  model: string;
}

function getApiKey(provider: ProviderName, secrets: AppSecrets): string | undefined {
  return secrets.providers[provider];
}

export function getProviderCandidates(config: AppConfig, secrets: AppSecrets): ProviderCandidate[] {
  const ordered = [config.activeProvider, ...config.providerOrder.filter((p) => p !== config.activeProvider)];
  const output: ProviderCandidate[] = [];
  for (const provider of ordered) {
    const key = getApiKey(provider, secrets);
    if (!key) {
      continue;
    }
    output.push({
      provider,
      apiKey: key,
      model: config.models[provider],
    });
  }
  return output;
}

function buildProvider(provider: ProviderName, apiKey: string): ReturnType<typeof createOpenAICompatible> {
  if (provider === "cerebras") {
    return createOpenAICompatible({
      name: "cerebras",
      apiKey,
      baseURL: "https://api.cerebras.ai/v1",
    });
  }
  if (provider === "groq") {
    return createOpenAICompatible({
      name: "groq",
      apiKey,
      baseURL: "https://api.groq.com/openai/v1",
    });
  }
  return createOpenAICompatible({
    name: "openrouter",
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    headers: {
      "HTTP-Referer": "https://localhost",
      "X-Title": "ClarityCheck",
    },
  });
}

export function resolveModel(provider: ProviderName, model: string, apiKey: string): unknown {
  const instance = buildProvider(provider, apiKey) as unknown as Record<string, unknown>;
  if (typeof instance === "function") {
    return (instance as (modelName: string) => unknown)(model);
  }

  const asAny = instance as {
    chat?: (name: string) => unknown;
    model?: (name: string) => unknown;
    languageModel?: (name: string) => unknown;
  };
  if (typeof asAny.chat === "function") {
    return asAny.chat(model);
  }
  if (typeof asAny.model === "function") {
    return asAny.model(model);
  }
  if (typeof asAny.languageModel === "function") {
    return asAny.languageModel(model);
  }

  throw new Error("Unable to resolve model from OpenAI-compatible provider.");
}
