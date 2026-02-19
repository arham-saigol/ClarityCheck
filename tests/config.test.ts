import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { loadConfig, loadSecrets, saveConfig, saveSecrets } from "../src/config";
import { DEFAULT_CONFIG } from "../src/constants";
import type { AppPaths, } from "../src/paths";
import type { AppSecrets } from "../src/types";

function tempPaths(): AppPaths {
  const dir = join(tmpdir(), `claritycheck-config-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return {
    configDir: dir,
    configFile: join(dir, "config.json"),
    secretsFile: join(dir, "secrets.json"),
    dbFile: join(dir, "claritycheck.sqlite"),
    pidFile: join(dir, "gateway.pid"),
    logFile: join(dir, "gateway.log"),
  };
}

test("save/load config normalizes invalid provider order", () => {
  const paths = tempPaths();
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.activeProvider = "openrouter";
    config.providerOrder = ["openrouter", "openrouter", "groq"] as typeof config.providerOrder;
    saveConfig(paths, config);
    const loaded = loadConfig(paths);
    expect(loaded.providerOrder).toEqual(["openrouter", "groq", "cerebras"]);
    expect(loaded.activeProvider).toBe("openrouter");
  } finally {
    rmSync(paths.configDir, { recursive: true, force: true });
  }
});

test("save/load secrets round trip", () => {
  const paths = tempPaths();
  const secrets: AppSecrets = {
    telegramBotToken: "telegram-token",
    deepgramApiKey: "deepgram-key",
    providers: {
      cerebras: "c-key",
    },
    search: {
      braveApiKey: "b-key",
    },
  };
  try {
    saveSecrets(paths, secrets);
    const loaded = loadSecrets(paths);
    expect(loaded.telegramBotToken).toBe("telegram-token");
    expect(loaded.deepgramApiKey).toBe("deepgram-key");
    expect(loaded.providers.cerebras).toBe("c-key");
    expect(loaded.search.braveApiKey).toBe("b-key");
  } finally {
    rmSync(paths.configDir, { recursive: true, force: true });
  }
});
