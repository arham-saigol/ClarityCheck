import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/constants";
import { getProviderCandidates } from "../src/provider";
import type { AppConfig, AppSecrets } from "../src/types";

function baseConfig(): AppConfig {
  return structuredClone(DEFAULT_CONFIG);
}

function baseSecrets(): AppSecrets {
  return {
    telegramBotToken: "token",
    providers: {},
    search: {},
  };
}

test("getProviderCandidates keeps active provider first and filters missing keys", () => {
  const config = baseConfig();
  config.activeProvider = "groq";
  config.providerOrder = ["cerebras", "groq", "openrouter"];

  const secrets = baseSecrets();
  secrets.providers = {
    groq: "groq-key",
    cerebras: "cerebras-key",
  };

  const candidates = getProviderCandidates(config, secrets);
  expect(candidates.map((item) => item.provider)).toEqual(["groq", "cerebras"]);
});

test("getProviderCandidates returns empty when no provider keys exist", () => {
  const config = baseConfig();
  const secrets = baseSecrets();
  const candidates = getProviderCandidates(config, secrets);
  expect(candidates.length).toBe(0);
});

