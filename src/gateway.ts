import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeDecision, runDecisionTurn } from "./agent";
import { loadConfig, loadSecrets, saveConfig } from "./config";
import { ClarityDb } from "./db";
import {
  CLI_PAIR_TTL_MS,
  STARTUP_PAIR_TTL_MS,
  SYSTEM_PROMPT,
  CONTROL_DEFAULT_HOST,
  CONTROL_DEFAULT_PORT,
} from "./constants";
import { logLine } from "./logger";
import { ensureConfigDir, getAppPaths } from "./paths";
import { TelegramClient, type TelegramUpdate } from "./telegram";
import type { AppConfig, AppSecrets, ProviderName, VoiceReplyMode } from "./types";
import {
  synthesizeSpeechWithDeepgram,
  transcribeAudioWithDeepgram,
} from "./voice/deepgram";
import { convertWavToOggOpus, isFfmpegInstalled } from "./voice/ffmpeg";
import { shouldSendVoiceReply, type UserInputType } from "./voice/policy";

const TELEGRAM_COMMANDS = [
  { command: "start", description: "Show pairing and quick help" },
  { command: "newdecision", description: "Start a fresh decision thread" },
  { command: "completedecision", description: "Finalize active decision" },
  { command: "model", description: "Switch model provider" },
  { command: "voice", description: "Set voice mode: on/off/auto" },
  { command: "status", description: "Show current bot status" },
  { command: "help", description: "List available commands" },
  { command: "pair", description: "Pair this chat with gateway" },
];

interface PendingPair {
  chatId: number;
  expiresAt: number;
}

function generateCode(length = 6): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(length);
  let output = "";
  for (let i = 0; i < length; i += 1) {
    output += alphabet[bytes[i] % alphabet.length];
  }
  return output;
}

function parseCommand(text: string): { command: string; args: string[] } {
  const [head, ...rest] = text.trim().split(/\s+/);
  const command = head.toLowerCase().replace(/^\/+/, "").split("@")[0];
  return { command, args: rest };
}

class GatewayApp {
  private readonly startupPairCode = generateCode(8);
  private readonly startupPairCodeExpiresAt = Date.now() + STARTUP_PAIR_TTL_MS;
  private readonly pendingPairs = new Map<string, PendingPair>();
  private readonly telegram: TelegramClient;
  private readonly db: ClarityDb;
  private latestUpdateId = 0;
  private shuttingDown = false;
  private controlServer: ReturnType<typeof Bun.serve> | undefined;
  private ffmpegAvailable: boolean | undefined;

  constructor(
    private config: AppConfig,
    private readonly secrets: AppSecrets,
    private readonly dbPath: string,
    private readonly logFile: string,
    private readonly saveConfigFn: (config: AppConfig) => void,
  ) {
    this.telegram = new TelegramClient(secrets.telegramBotToken);
    this.db = new ClarityDb(dbPath);
    const persistedOffset = this.db.getRuntimeState("telegram_last_update_id");
    this.latestUpdateId = persistedOffset ? Number.parseInt(persistedOffset, 10) || 0 : 0;
  }

  async start(): Promise<void> {
    logLine(this.logFile, "INFO", "Gateway booting.");
    logLine(this.logFile, "INFO", `System prompt loaded (${SYSTEM_PROMPT.length} chars).`);
    logLine(
      this.logFile,
      "INFO",
      `Startup Telegram pair code ${this.startupPairCode} expires ${new Date(this.startupPairCodeExpiresAt).toISOString()}`,
    );

    await this.registerTelegramCommands();
    this.startControlServer();
    await this.pollLoop();
  }

  private async registerTelegramCommands(): Promise<void> {
    try {
      await this.telegram.setMyCommands(TELEGRAM_COMMANDS);
      logLine(this.logFile, "INFO", "Telegram command menu registered.");
    } catch (error) {
      logLine(this.logFile, "WARN", `Failed to register Telegram commands: ${(error as Error).message}`);
    }
  }

  shutdown(): void {
    this.shuttingDown = true;
    try {
      this.controlServer?.stop(true);
    } catch {
      // ignore close errors during shutdown
    }
    try {
      this.db.close();
    } catch {
      // ignore db close errors during shutdown
    }
  }

  private startControlServer(): void {
    const host = this.config.gateway.controlHost || CONTROL_DEFAULT_HOST;
    const port = this.config.gateway.controlPort || CONTROL_DEFAULT_PORT;

    this.controlServer = Bun.serve({
      hostname: host,
      port,
      fetch: async (request) => this.handleControlRequest(request),
    });
    logLine(this.logFile, "INFO", `Control API listening on http://${host}:${String(port)}`);
  }

  private async handleControlRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({
        ok: true,
        pid: process.pid,
        activeProvider: this.config.activeProvider,
        authorizedChatId: this.config.telegram.authorizedChatId,
        startupPairCodeActive: Date.now() < this.startupPairCodeExpiresAt,
        startupPairCodeExpiresAt: new Date(this.startupPairCodeExpiresAt).toISOString(),
      });
    }

    if (url.pathname === "/pair/approve" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { code?: string };
      const code = body.code?.trim().toUpperCase() ?? "";
      const pending = this.pendingPairs.get(code);
      if (!pending) {
        return Response.json({ error: "Unknown or already-used pair code." }, { status: 404 });
      }
      if (Date.now() > pending.expiresAt) {
        this.pendingPairs.delete(code);
        return Response.json({ error: "Pair code expired." }, { status: 410 });
      }

      this.pendingPairs.delete(code);
      this.setAuthorizedChat(pending.chatId);
      await this.telegram.sendMessage(
        pending.chatId,
        "Pairing complete. You can now use /newdecision to begin.",
      );
      return Response.json({ ok: true, chatId: pending.chatId });
    }

    return Response.json({ error: "Not found." }, { status: 404 });
  }

  private setAuthorizedChat(chatId: number): void {
    this.config = {
      ...this.config,
      telegram: {
        ...this.config.telegram,
        authorizedChatId: chatId,
      },
    };
    this.saveConfigFn(this.config);
    logLine(this.logFile, "INFO", `Authorized Telegram chat id set to ${String(chatId)}.`);
  }

  private async pollLoop(): Promise<void> {
    while (!this.shuttingDown) {
      try {
        const updates = await this.telegram.getUpdates(this.latestUpdateId + 1, 25);
        for (const update of updates) {
          this.latestUpdateId = Math.max(this.latestUpdateId, update.update_id);
          this.db.setRuntimeState("telegram_last_update_id", String(this.latestUpdateId));
          await this.handleUpdate(update);
        }
      } catch (error) {
        logLine(this.logFile, "ERROR", `Polling error: ${(error as Error).message}`);
        await Bun.sleep(1500);
      }
      await Bun.sleep(Math.max(200, this.config.gateway.pollingIntervalMs));
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message) {
      return;
    }
    const chatId = message.chat.id;
    const text = message.text?.trim();
    const voice = message.voice;

    if (text && text.startsWith("/")) {
      await this.handleCommand(chatId, text);
      return;
    }

    if (!this.isAuthorized(chatId)) {
      await this.telegram.sendMessage(
        chatId,
        "This bot is not paired with your chat yet. Send /pair to begin pairing.",
      );
      return;
    }

    if (voice) {
      await this.handleVoiceMessage(chatId, voice.file_id, voice.mime_type ?? "audio/ogg");
      return;
    }

    if (!text) {
      return;
    }
    await this.handleUserMessage(chatId, text, "text");
  }

  private async handleVoiceMessage(chatId: number, fileId: string, mimeType: string): Promise<void> {
    if (!this.secrets.deepgramApiKey) {
      await this.telegram.sendMessage(
        chatId,
        "Voice input is not available yet. Add Deepgram API key via claritycheck onboard.",
      );
      return;
    }

    try {
      const file = await this.telegram.getFile(fileId);
      if (!file.file_path) {
        throw new Error("Telegram did not return a file path for voice note.");
      }
      const audio = await this.telegram.downloadFile(file.file_path);
      const stt = await transcribeAudioWithDeepgram(audio, {
        apiKey: this.secrets.deepgramApiKey,
        model: this.config.voice.sttModel,
        mimeType,
      });
      await this.telegram.sendMessage(chatId, `Transcribed: ${stt.transcript}`);
      await this.handleUserMessage(chatId, stt.transcript, "voice");
    } catch (error) {
      await this.telegram.sendMessage(
        chatId,
        `Failed to transcribe voice note: ${(error as Error).message}`,
      );
      logLine(this.logFile, "ERROR", `Voice STT error: ${(error as Error).stack ?? (error as Error).message}`);
    }
  }

  private async handleUserMessage(
    chatId: number,
    text: string,
    inputType: UserInputType,
  ): Promise<void> {
    let decisionId = this.db.getActiveDecisionId();
    if (!decisionId) {
      const title = text.slice(0, 60);
      decisionId = this.db.createDecision(title || "Untitled decision", text);
      await this.telegram.sendMessage(
        chatId,
        "Started a new decision thread. I will research and challenge assumptions when needed.",
      );
    }

    this.db.addMessage(decisionId, "user", text);
    try {
      const result = await runDecisionTurn({
        db: this.db,
        config: this.config,
        secrets: this.secrets,
      }, decisionId);
      const replyText = `${result.text}\n\n(Provider: ${result.providerUsed})`;
      await this.telegram.sendMessage(chatId, replyText);
      await this.maybeSendVoiceReply(chatId, result.text, inputType);
    } catch (error) {
      await this.telegram.sendMessage(
        chatId,
        `I hit an error while processing that turn: ${(error as Error).message}`,
      );
      logLine(this.logFile, "ERROR", `Turn error: ${(error as Error).stack ?? (error as Error).message}`);
    }
  }

  private canUseVoiceOutput(): boolean {
    if (this.ffmpegAvailable === undefined) {
      this.ffmpegAvailable = isFfmpegInstalled();
      if (!this.ffmpegAvailable) {
        logLine(this.logFile, "WARN", "ffmpeg not available, voice replies disabled.");
      }
    }
    return Boolean(this.secrets.deepgramApiKey && this.ffmpegAvailable);
  }

  private isFfmpegReady(): boolean {
    if (this.ffmpegAvailable === undefined) {
      this.ffmpegAvailable = isFfmpegInstalled();
      if (!this.ffmpegAvailable) {
        logLine(this.logFile, "WARN", "ffmpeg not available, voice replies disabled.");
      }
    }
    return this.ffmpegAvailable;
  }

  private async maybeSendVoiceReply(
    chatId: number,
    assistantText: string,
    inputType: UserInputType,
  ): Promise<void> {
    if (!shouldSendVoiceReply(this.config.voice.replyMode, inputType)) {
      return;
    }
    if (!this.canUseVoiceOutput()) {
      return;
    }
    const deepgramApiKey = this.secrets.deepgramApiKey;
    if (!deepgramApiKey) {
      return;
    }

    const tempDir = mkdtempSync(join(tmpdir(), "claritycheck-voice-"));
    const wavPath = join(tempDir, "reply.wav");
    const oggPath = join(tempDir, "reply.ogg");
    try {
      const ttsText = assistantText.slice(0, 1800);
      const wavBytes = await synthesizeSpeechWithDeepgram(ttsText, {
        apiKey: deepgramApiKey,
        model: this.config.voice.ttsModel,
        encoding: this.config.voice.ttsEncoding,
        container: this.config.voice.ttsContainer,
      });
      writeFileSync(wavPath, wavBytes);
      convertWavToOggOpus(wavPath, oggPath);
      await this.telegram.sendVoice(chatId, oggPath);
    } catch (error) {
      logLine(
        this.logFile,
        "ERROR",
        `Voice TTS error: ${(error as Error).stack ?? (error as Error).message}`,
      );
      await this.telegram.sendMessage(
        chatId,
        "Voice reply failed, but text reply was sent successfully.",
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private isAuthorized(chatId: number): boolean {
    return this.config.telegram.authorizedChatId === chatId;
  }

  private ensureAuthorizedOrExplain(chatId: number): Promise<boolean> {
    if (this.isAuthorized(chatId)) {
      return Promise.resolve(true);
    }
    if (!this.config.telegram.authorizedChatId) {
      return this.telegram
        .sendMessage(chatId, "No chat paired yet. Send /pair to request pairing.")
        .then(() => false);
    }
    return this.telegram
      .sendMessage(chatId, "This bot is bound to another chat in single-user mode.")
      .then(() => false);
  }

  private async handleCommand(chatId: number, rawText: string): Promise<void> {
    const { command, args } = parseCommand(rawText);

    if (command === "start") {
      if (this.isAuthorized(chatId)) {
        await this.telegram.sendMessage(
          chatId,
          "ClarityCheck is active. Use /newdecision to begin or /help for commands.",
        );
      } else {
        await this.telegram.sendMessage(
          chatId,
          [
            "ClarityCheck single-user pairing required.",
            `Option A: use /pair ${this.startupPairCode} (expires soon).`,
            "Option B: send /pair to receive a local approval code and run `claritycheck pair CODE`.",
          ].join("\n"),
        );
      }
      return;
    }

    if (command === "pair") {
      await this.handlePairCommand(chatId, args);
      return;
    }

    if (!(await this.ensureAuthorizedOrExplain(chatId))) {
      return;
    }

    if (command === "help") {
      await this.telegram.sendMessage(
        chatId,
        [
          "/newdecision - start a fresh decision thread",
          "/completedecision - finalize and store structured memory",
          "/model cerebras|groq|openrouter - switch active provider",
          "/voice on|off|auto|status - configure voice responses",
          "/status - show current session status",
          "/help - show this message",
        ].join("\n"),
      );
      return;
    }

    if (command === "status") {
      const activeDecisionId = this.db.getActiveDecisionId();
      await this.telegram.sendMessage(
        chatId,
        [
          `Provider: ${this.config.activeProvider}`,
          `Authorized chat: ${String(this.config.telegram.authorizedChatId)}`,
          `Active decision: ${activeDecisionId ?? "none"}`,
          `Search primary: ${this.config.search.primary ?? "not configured"}`,
          `Voice mode: ${this.config.voice.replyMode}`,
          `Deepgram key: ${this.secrets.deepgramApiKey ? "configured" : "missing"}`,
          `ffmpeg: ${this.isFfmpegReady() ? "available" : "missing"}`,
        ].join("\n"),
      );
      return;
    }

    if (command === "model") {
      const requested = (args[0] ?? "").toLowerCase() as ProviderName;
      if (!["cerebras", "groq", "openrouter"].includes(requested)) {
        await this.telegram.sendMessage(chatId, "Usage: /model cerebras|groq|openrouter");
        return;
      }
      if (!this.secrets.providers[requested]) {
        await this.telegram.sendMessage(
          chatId,
          `No API key configured for ${requested}. Run claritycheck onboard to add it.`,
        );
        return;
      }
      this.config = {
        ...this.config,
        activeProvider: requested,
      };
      this.saveConfigFn(this.config);
      await this.telegram.sendMessage(chatId, `Active provider switched to ${requested}.`);
      return;
    }

    if (command === "voice") {
      const mode = (args[0] ?? "").toLowerCase();
      if (!mode || mode === "status") {
        await this.telegram.sendMessage(
          chatId,
          [
            `Voice mode: ${this.config.voice.replyMode}`,
            `Deepgram key: ${this.secrets.deepgramApiKey ? "configured" : "missing"}`,
            `ffmpeg: ${this.isFfmpegReady() ? "available" : "missing"}`,
            "Usage: /voice on|off|auto|status",
          ].join("\n"),
        );
        return;
      }
      if (!["on", "off", "auto"].includes(mode)) {
        await this.telegram.sendMessage(chatId, "Usage: /voice on|off|auto|status");
        return;
      }
      const nextMode = mode as VoiceReplyMode;
      this.config = {
        ...this.config,
        voice: {
          ...this.config.voice,
          replyMode: nextMode,
        },
      };
      this.saveConfigFn(this.config);
      await this.telegram.sendMessage(chatId, `Voice reply mode set to ${nextMode}.`);
      return;
    }

    if (command === "newdecision") {
      const decisionId = this.db.createDecision("New decision", "User started a new decision.");
      await this.telegram.sendMessage(
        chatId,
        `New decision started (${decisionId.slice(0, 8)}). Send your context and goal.`,
      );
      return;
    }

    if (command === "completedecision") {
      const decisionId = this.db.getActiveDecisionId();
      if (!decisionId) {
        await this.telegram.sendMessage(chatId, "No active decision to complete.");
        return;
      }
      try {
        const completion = await completeDecision(
          {
            db: this.db,
            config: this.config,
            secrets: this.secrets,
          },
          decisionId,
        );
        const lines = [
          "Decision completed and saved.",
          `Title: ${completion.record.title}`,
          `Recommendation: ${completion.record.recommendedOption}`,
          `Confidence: ${completion.record.confidence}`,
          `Provider: ${completion.providerUsed}`,
        ];
        await this.telegram.sendMessage(chatId, lines.join("\n"));
      } catch (error) {
        await this.telegram.sendMessage(
          chatId,
          `Failed to complete decision: ${(error as Error).message}`,
        );
      }
      return;
    }

    await this.telegram.sendMessage(chatId, "Unknown command. Use /help.");
  }

  private async handlePairCommand(chatId: number, args: string[]): Promise<void> {
    if (this.isAuthorized(chatId)) {
      await this.telegram.sendMessage(chatId, "This chat is already paired.");
      return;
    }
    if (this.config.telegram.authorizedChatId && this.config.telegram.authorizedChatId !== chatId) {
      await this.telegram.sendMessage(
        chatId,
        "This bot is already paired with another chat. Clear pairing in config to re-pair.",
      );
      return;
    }

    if (args.length > 0) {
      const code = args[0].trim().toUpperCase();
      const isStartupCodeValid =
        code === this.startupPairCode && Date.now() < this.startupPairCodeExpiresAt;
      if (!isStartupCodeValid) {
        await this.telegram.sendMessage(chatId, "Pair code invalid or expired. Send /pair to request a new flow.");
        return;
      }
      this.setAuthorizedChat(chatId);
      await this.telegram.sendMessage(chatId, "Paired successfully. Use /newdecision to begin.");
      return;
    }

    const code = generateCode(6);
    this.pendingPairs.set(code, {
      chatId,
      expiresAt: Date.now() + CLI_PAIR_TTL_MS,
    });
    await this.telegram.sendMessage(
      chatId,
      `Run this locally to approve pairing:\nclaritycheck pair ${code}\nExpires in 10 minutes.`,
    );
  }
}

function writePid(paths: ReturnType<typeof getAppPaths>): void {
  writeFileSync(paths.pidFile, String(process.pid), "utf8");
}

function removePid(paths: ReturnType<typeof getAppPaths>): void {
  if (existsSync(paths.pidFile)) {
    rmSync(paths.pidFile, { force: true });
  }
}

async function main(): Promise<void> {
  const paths = getAppPaths();
  ensureConfigDir(paths);
  const config = loadConfig(paths);
  const secrets = loadSecrets(paths);
  if (!secrets.telegramBotToken) {
    throw new Error("Telegram bot token is missing. Run claritycheck onboard.");
  }

  writePid(paths);
  const saveConfigFn = (next: AppConfig) => saveConfig(paths, next);
  const app = new GatewayApp(config, secrets, paths.dbFile, paths.logFile, saveConfigFn);

  const shutdown = (signal: string) => {
    logLine(paths.logFile, "WARN", `Gateway received ${signal}, shutting down.`);
    app.shutdown();
    removePid(paths);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("exit", () => {
    app.shutdown();
    removePid(paths);
  });

  try {
    await app.start();
  } catch (error) {
    removePid(paths);
    logLine(paths.logFile, "ERROR", `Gateway fatal error: ${(error as Error).stack ?? (error as Error).message}`);
    throw error;
  }
}

if (import.meta.main) {
  void main();
}
