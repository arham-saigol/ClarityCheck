import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_CONFIG, DEFAULT_PROVIDER_ORDER } from "./constants";
import type { AppPaths } from "./paths";
import type { AppConfig, AppSecrets, ProviderName } from "./types";

export function loadConfig(paths: AppPaths): AppConfig {
  if (!existsSync(paths.configFile)) {
    return structuredClone(DEFAULT_CONFIG);
  }
  const parsed = JSON.parse(readFileSync(paths.configFile, "utf8")) as Partial<AppConfig>;
  return normalizeConfig(parsed);
}

export function saveConfig(paths: AppPaths, config: AppConfig): void {
  const normalized = normalizeConfig(config);
  writeFileSync(paths.configFile, JSON.stringify(normalized, null, 2), "utf8");
}

function normalizeConfig(input: Partial<AppConfig>): AppConfig {
  const providerOrder = normalizeProviderOrder(input.providerOrder);
  const activeProvider = providerOrder.includes(input.activeProvider as ProviderName)
    ? (input.activeProvider as ProviderName)
    : providerOrder[0];

  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...input,
    activeProvider,
    providerOrder,
    models: {
      ...DEFAULT_CONFIG.models,
      ...(input.models ?? {}),
    },
    search: {
      ...DEFAULT_CONFIG.search,
      ...(input.search ?? {}),
    },
    gateway: {
      ...DEFAULT_CONFIG.gateway,
      ...(input.gateway ?? {}),
    },
    telegram: {
      ...DEFAULT_CONFIG.telegram,
      ...(input.telegram ?? {}),
    },
    memory: {
      ...DEFAULT_CONFIG.memory,
      ...(input.memory ?? {}),
    },
    voice: {
      ...DEFAULT_CONFIG.voice,
      ...(input.voice ?? {}),
    },
  };
}

function normalizeProviderOrder(order?: ProviderName[]): ProviderName[] {
  const set = new Set<ProviderName>();
  for (const value of order ?? []) {
    if (value === "cerebras" || value === "groq" || value === "openrouter") {
      set.add(value);
    }
  }
  for (const fallback of DEFAULT_PROVIDER_ORDER) {
    set.add(fallback);
  }
  return [...set];
}

export function loadSecrets(paths: AppPaths): AppSecrets {
  if (existsSync(paths.secretsFile)) {
    const plaintext = readFileSync(paths.secretsFile, "utf8");
    const parsed = JSON.parse(plaintext) as Partial<AppSecrets>;
    return applyEnvOverrides(normalizeSecrets(parsed));
  }

  const envOnly = applyEnvOverrides(
    normalizeSecrets({
      telegramBotToken: "",
      providers: {},
      search: {},
    }),
  );
  if (envOnly.telegramBotToken || Object.keys(envOnly.providers).length > 0 || envOnly.deepgramApiKey) {
    return envOnly;
  }

  throw new Error(`Missing secrets file: ${paths.secretsFile}. Run 'claritycheck onboard' first.`);
}

export function saveSecrets(paths: AppPaths, secrets: AppSecrets): void {
  const normalized = normalizeSecrets(secrets);
  writeFileSync(paths.secretsFile, JSON.stringify(normalized, null, 2), "utf8");
}

function normalizeSecrets(input: Partial<AppSecrets>): AppSecrets {
  return {
    telegramBotToken: input.telegramBotToken ?? "",
    deepgramApiKey: input.deepgramApiKey || undefined,
    providers: {
      cerebras: input.providers?.cerebras || undefined,
      groq: input.providers?.groq || undefined,
      openrouter: input.providers?.openrouter || undefined,
    },
    search: {
      tavilyApiKey: input.search?.tavilyApiKey || undefined,
      braveApiKey: input.search?.braveApiKey || undefined,
    },
  };
}

function applyEnvOverrides(secrets: AppSecrets): AppSecrets {
  return {
    telegramBotToken:
      process.env.CLARITYCHECK_TELEGRAM_BOT_TOKEN?.trim() || secrets.telegramBotToken,
    deepgramApiKey: process.env.CLARITYCHECK_DEEPGRAM_API_KEY?.trim() || secrets.deepgramApiKey,
    providers: {
      cerebras:
        process.env.CLARITYCHECK_CEREBRAS_API_KEY?.trim() || secrets.providers.cerebras,
      groq: process.env.CLARITYCHECK_GROQ_API_KEY?.trim() || secrets.providers.groq,
      openrouter:
        process.env.CLARITYCHECK_OPENROUTER_API_KEY?.trim() || secrets.providers.openrouter,
    },
    search: {
      tavilyApiKey:
        process.env.CLARITYCHECK_TAVILY_API_KEY?.trim() || secrets.search.tavilyApiKey,
      braveApiKey:
        process.env.CLARITYCHECK_BRAVE_API_KEY?.trim() || secrets.search.braveApiKey,
    },
  };
}
