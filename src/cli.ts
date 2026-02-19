import { existsSync } from "node:fs";
import { approvePairCode, getGatewayHealth } from "./control-client";
import {
  loadConfig,
  loadSecrets,
  saveConfig,
  saveSecrets,
} from "./config";
import { cleanupPidFile, isPidAlive, readPid, startGatewayProcess, stopPid } from "./daemon";
import { DEFAULT_PROVIDER_ORDER } from "./constants";
import { tailLog } from "./logger";
import { ensureConfigDir, getAppPaths } from "./paths";
import { ask, toYesNo } from "./prompt";
import type { AppConfig, AppSecrets, ProviderName, SearchProviderName, VoiceReplyMode } from "./types";
import { isFfmpegInstalled } from "./voice/ffmpeg";

function printHelp(): void {
  console.log(`
ClarityCheck CLI

Usage:
  claritycheck onboard
  claritycheck gateway start|stop|restart|status|logs
  claritycheck pair <CODE>
  claritycheck doctor
`);
}

async function onboard(paths: ReturnType<typeof getAppPaths>): Promise<void> {
  ensureConfigDir(paths);
  const currentConfig = loadConfig(paths);

  const line = "=".repeat(64);
  console.log(line);
  console.log("ClarityCheck Onboarding");
  console.log(line);
  console.log("Tip: press Enter to skip optional keys.");
  console.log("");

  console.log("[1/5] Telegram");
  const telegramBotToken = await ask("Telegram bot token (required)", { required: true });
  console.log("  - telegram bot token captured");
  console.log("");

  console.log("[2/5] Model providers");
  const cerebrasKey = await ask("Cerebras API key (optional)", { allowEmpty: true });
  const groqKey = await ask("Groq API key (optional)", { allowEmpty: true });
  const openrouterKey = await ask("OpenRouter API key (optional)", { allowEmpty: true });
  const configuredProviders = DEFAULT_PROVIDER_ORDER.filter((provider) => {
    if (provider === "cerebras") return cerebrasKey.length > 0;
    if (provider === "groq") return groqKey.length > 0;
    return openrouterKey.length > 0;
  });
  if (configuredProviders.length === 0) {
    console.log("  ! no provider key configured (chat will fail until one is added)");
    const continueWithoutProvider = await ask("Continue anyway? (y/n)", { defaultValue: "y" });
    if (!toYesNo(continueWithoutProvider)) {
      throw new Error("Onboarding cancelled. Re-run and add at least one provider key.");
    }
  } else {
    console.log(`  - configured providers: ${configuredProviders.join(", ")}`);
  }
  console.log("");

  console.log("[3/5] Web search");
  const tavilyKey = await ask("Tavily API key (optional)", { allowEmpty: true });
  const braveKey = await ask("Brave Search API key (optional)", { allowEmpty: true });
  console.log(
    `  - search keys: ${[
      tavilyKey ? "tavily" : null,
      braveKey ? "brave" : null,
    ]
      .filter(Boolean)
      .join(", ") || "none"}`,
  );
  console.log("");

  console.log("[4/5] Voice");
  const deepgramKey = await ask("Deepgram API key for STT/TTS (optional)", { allowEmpty: true });
  const ffmpegAvailable = isFfmpegInstalled();
  if (deepgramKey && !ffmpegAvailable) {
    console.log("  ! ffmpeg not found (voice replies will be disabled until installed)");
  } else if (deepgramKey && ffmpegAvailable) {
    console.log("  - deepgram + ffmpeg ready");
  } else {
    console.log("  - voice optional components not configured");
  }
  console.log("");

  console.log("[5/5] Runtime defaults");
  const defaultProvider = (await ask(
    "Default model provider [cerebras|groq|openrouter]",
    {
      defaultValue: configuredProviders[0] ?? currentConfig.activeProvider,
    },
  )) as ProviderName;
  const normalizedDefaultProvider: ProviderName = ["cerebras", "groq", "openrouter"].includes(
    defaultProvider,
  )
    ? defaultProvider
    : configuredProviders[0] ?? currentConfig.activeProvider;

  const primarySearch = (await ask("Primary web search engine [tavily|brave|none]", {
    defaultValue: tavilyKey ? "tavily" : braveKey ? "brave" : "none",
  })) as SearchProviderName | "none";
  const normalizedPrimarySearch: SearchProviderName | "none" =
    primarySearch === "tavily" || primarySearch === "brave" || primarySearch === "none"
      ? primarySearch
      : "none";

  const fallbackSearch = (await ask("Fallback web search engine [tavily|brave|none]", {
    defaultValue: normalizedPrimarySearch === "tavily" && braveKey ? "brave" : "none",
  })) as SearchProviderName | "none";
  const normalizedFallbackSearch: SearchProviderName | "none" =
    fallbackSearch === "tavily" || fallbackSearch === "brave" || fallbackSearch === "none"
      ? fallbackSearch
      : "none";

  const voiceReplyModeInput = await ask("Voice reply mode [off|on|auto]", {
    defaultValue: deepgramKey ? "auto" : "off",
  });
  const voiceReplyMode: VoiceReplyMode = ["off", "on", "auto"].includes(voiceReplyModeInput)
    ? (voiceReplyModeInput as VoiceReplyMode)
    : deepgramKey
      ? "auto"
      : "off";

  const config: AppConfig = {
    ...currentConfig,
    onboardingCompleted: true,
    activeProvider: normalizedDefaultProvider,
    providerOrder: DEFAULT_PROVIDER_ORDER,
    search: {
      primary: normalizedPrimarySearch === "none" ? undefined : normalizedPrimarySearch,
      fallback:
        normalizedFallbackSearch === "none" || normalizedFallbackSearch === normalizedPrimarySearch
          ? undefined
          : normalizedFallbackSearch,
    },
    voice: {
      ...currentConfig.voice,
      replyMode: voiceReplyMode,
    },
  };

  const secrets: AppSecrets = {
    telegramBotToken,
    deepgramApiKey: deepgramKey || undefined,
    providers: {
      cerebras: cerebrasKey || undefined,
      groq: groqKey || undefined,
      openrouter: openrouterKey || undefined,
    },
    search: {
      tavilyApiKey: tavilyKey || undefined,
      braveApiKey: braveKey || undefined,
    },
  };

  const summaryLines = [
    "",
    "Summary",
    `  - default provider: ${config.activeProvider}`,
    `  - providers configured: ${
      [
        secrets.providers.cerebras ? "cerebras" : null,
        secrets.providers.groq ? "groq" : null,
        secrets.providers.openrouter ? "openrouter" : null,
      ]
        .filter(Boolean)
        .join(", ") || "none"
    }`,
    `  - search primary: ${config.search.primary ?? "none"}`,
    `  - search fallback: ${config.search.fallback ?? "none"}`,
    `  - deepgram: ${secrets.deepgramApiKey ? "configured" : "missing"}`,
    `  - voice mode: ${config.voice.replyMode}`,
    `  - ffmpeg: ${ffmpegAvailable ? "available" : "missing"}`,
    `  - config path: ${paths.configDir}`,
  ];
  console.log(summaryLines.join("\n"));
  const confirm = await ask("Save these settings? (y/n)", { defaultValue: "y" });
  if (!toYesNo(confirm)) {
    throw new Error("Onboarding cancelled. No files were written.");
  }

  saveConfig(paths, config);
  saveSecrets(paths, secrets);

  console.log("");
  console.log("Onboarding complete.");
  console.log(`Config directory: ${paths.configDir}`);
  console.log("Next steps:");
  console.log("  1) claritycheck gateway start");
  console.log("  2) In Telegram: /start then /pair ...");
  if (deepgramKey && !ffmpegAvailable) {
    console.log("  3) Install ffmpeg for voice replies (Deepgram TTS -> OGG conversion).");
  }
}

async function gatewayStart(paths: ReturnType<typeof getAppPaths>): Promise<void> {
  ensureConfigDir(paths);
  const config = loadConfig(paths);
  if (!config.onboardingCompleted || !existsSync(paths.secretsFile)) {
    throw new Error("Onboarding incomplete. Run 'claritycheck onboard' first.");
  }

  loadSecrets(paths);
  const started = await startGatewayProcess(paths, {
    CLARITYCHECK_CONFIG_DIR: paths.configDir,
  });
  if (!started.started) {
    console.log(`Gateway already running (pid ${String(started.pid)}).`);
    return;
  }

  for (let i = 0; i < 15; i += 1) {
    await Bun.sleep(400);
    try {
      const status = await getGatewayHealth(config);
      console.log(`Gateway started (pid ${String(started.pid)}).`);
      console.log(`Active provider: ${status.activeProvider}`);
      console.log(`Pair code is available in gateway logs: ${paths.logFile}`);
      return;
    } catch {
      // keep waiting
    }
  }

  console.log(`Gateway started (pid ${String(started.pid)}), waiting for health endpoint timed out.`);
  console.log(`Check logs: ${paths.logFile}`);
}

function gatewayStop(paths: ReturnType<typeof getAppPaths>): void {
  const result = stopPid(paths);
  if (!result.pid) {
    console.log("Gateway is not running.");
    return;
  }
  if (!result.stopped) {
    console.log(`Gateway process ${String(result.pid)} was already stopped.`);
    return;
  }
  console.log(`Gateway stopped (pid ${String(result.pid)}).`);
}

async function gatewayRestart(paths: ReturnType<typeof getAppPaths>): Promise<void> {
  gatewayStop(paths);
  await gatewayStart(paths);
}

async function gatewayStatus(paths: ReturnType<typeof getAppPaths>): Promise<void> {
  const config = loadConfig(paths);
  const pid = readPid(paths);
  if (!pid) {
    console.log("Gateway status: stopped (no PID file).");
    return;
  }
  if (!isPidAlive(pid)) {
    cleanupPidFile(paths);
    console.log(`Gateway status: stopped (stale PID ${String(pid)}).`);
    return;
  }

  try {
    const health = await getGatewayHealth(config);
    console.log("Gateway status: running");
    console.log(`PID: ${String(health.pid)}`);
    console.log(`Active provider: ${health.activeProvider}`);
    console.log(`Authorized chat ID: ${String(health.authorizedChatId ?? "not paired")}`);
    console.log(
      `Startup /pair code active: ${health.startupPairCodeActive ? `yes (expires ${health.startupPairCodeExpiresAt})` : "no"}`,
    );
  } catch (error) {
    console.log("Gateway status: running process, but control API not responding.");
    console.log(`Details: ${(error as Error).message}`);
  }
}

function gatewayLogs(paths: ReturnType<typeof getAppPaths>): void {
  const logs = tailLog(paths.logFile, 160);
  if (!logs) {
    console.log("No logs available yet.");
    return;
  }
  console.log(logs);
}

async function pairCode(paths: ReturnType<typeof getAppPaths>, code: string): Promise<void> {
  if (!code.trim()) {
    throw new Error("Usage: claritycheck pair <CODE>");
  }
  const config = loadConfig(paths);
  const response = await approvePairCode(config, code.trim().toUpperCase());
  console.log(`Pairing approved for chat ID ${String(response.chatId)}.`);
}

async function doctor(paths: ReturnType<typeof getAppPaths>): Promise<void> {
  console.log("ClarityCheck doctor");
  console.log(`- Bun runtime: ${process.versions.bun ? process.versions.bun : "missing"}`);
  console.log(`- Config dir: ${paths.configDir}`);
  console.log(`- Config file: ${existsSync(paths.configFile) ? "present" : "missing"}`);
  console.log(`- Secrets file: ${existsSync(paths.secretsFile) ? "present" : "missing"}`);
  console.log(`- Database file: ${existsSync(paths.dbFile) ? "present" : "missing"}`);

  const pid = readPid(paths);
  if (!pid) {
    console.log("- Gateway PID: not running");
  } else {
    console.log(`- Gateway PID: ${String(pid)} (${isPidAlive(pid) ? "alive" : "stale"})`);
  }

  const config = loadConfig(paths);
  console.log(`- Active provider: ${config.activeProvider}`);
  console.log(`- Voice mode: ${config.voice.replyMode}`);
  console.log(`- ffmpeg: ${isFfmpegInstalled() ? "available" : "missing"}`);

  if (existsSync(paths.secretsFile)) {
    try {
      const secrets = loadSecrets(paths);
      console.log(`- Telegram token: ${secrets.telegramBotToken ? "configured" : "missing"}`);
      console.log(
        `- Provider keys: ${[
          secrets.providers.cerebras ? "cerebras" : null,
          secrets.providers.groq ? "groq" : null,
          secrets.providers.openrouter ? "openrouter" : null,
        ]
          .filter(Boolean)
          .join(", ") || "none"}`,
      );
      console.log(`- Deepgram key: ${secrets.deepgramApiKey ? "configured" : "missing"}`);
    } catch (error) {
      console.log(`- Secrets load: failed (${(error as Error).message})`);
    }
  } else {
    console.log("- Deepgram key: missing");
  }
}

export async function runCli(argv: string[]): Promise<void> {
  const paths = getAppPaths();
  ensureConfigDir(paths);

  const [command, subcommand, maybeArg] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "onboard") {
    await onboard(paths);
    return;
  }

  if (command === "gateway") {
    const action = subcommand?.toLowerCase();
    if (!action) {
      throw new Error("Usage: claritycheck gateway start|stop|restart|status|logs");
    }
    if (action === "start") {
      await gatewayStart(paths);
      return;
    }
    if (action === "stop") {
      gatewayStop(paths);
      return;
    }
    if (action === "restart") {
      await gatewayRestart(paths);
      return;
    }
    if (action === "status") {
      await gatewayStatus(paths);
      return;
    }
    if (action === "logs") {
      gatewayLogs(paths);
      return;
    }
    throw new Error("Usage: claritycheck gateway start|stop|restart|status|logs");
  }

  if (command === "pair") {
    await pairCode(paths, subcommand ?? maybeArg ?? "");
    return;
  }

  if (command === "doctor") {
    await doctor(paths);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  });
}
