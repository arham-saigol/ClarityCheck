export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramMessage {
  message_id: number;
  text?: string;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  voice?: {
    file_id: string;
    file_unique_id?: string;
    duration?: number;
    mime_type?: string;
    file_size?: number;
  };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramCommand {
  command: string;
  description: string;
}

export type TelegramChatAction =
  | "typing"
  | "upload_photo"
  | "record_video"
  | "upload_video"
  | "record_voice"
  | "upload_voice"
  | "upload_document"
  | "choose_sticker"
  | "find_location"
  | "record_video_note"
  | "upload_video_note";

export class TelegramClient {
  private readonly baseUrl: string;
  private readonly fileBaseUrl: string;

  constructor(private readonly token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.fileBaseUrl = `https://api.telegram.org/file/bot${token}`;
  }

  private escapeHtml(input: string): string {
    return input
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  private formatMarkdownLikeToTelegramHtml(input: string): string {
    const codeFencePattern = /```([\s\S]*?)```/g;
    const segments: Array<{ type: "text" | "code"; content: string }> = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = codeFencePattern.exec(input)) !== null) {
      if (match.index > lastIndex) {
        segments.push({ type: "text", content: input.slice(lastIndex, match.index) });
      }
      segments.push({ type: "code", content: match[1] ?? "" });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < input.length) {
      segments.push({ type: "text", content: input.slice(lastIndex) });
    }
    if (segments.length === 0) {
      segments.push({ type: "text", content: input });
    }

    const transformed = segments
      .map((segment) => {
        if (segment.type === "code") {
          const escapedCode = this.escapeHtml(segment.content.trim());
          return `<pre><code>${escapedCode}</code></pre>`;
        }

        let text = this.escapeHtml(segment.content);
        text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
        text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
        text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
        text = text.replace(/__(.+?)__/g, "<b>$1</b>");
        text = text.replace(/`([^`\n]+)`/g, "<code>$1</code>");
        return text;
      })
      .join("");

    return transformed;
  }

  async getUpdates(offset?: number, timeoutSeconds = 25): Promise<TelegramUpdate[]> {
    const url = new URL(`${this.baseUrl}/getUpdates`);
    if (offset !== undefined) {
      url.searchParams.set("offset", String(offset));
    }
    url.searchParams.set("timeout", String(timeoutSeconds));
    url.searchParams.set("allowed_updates", JSON.stringify(["message"]));

    const response = await fetch(url, {
      signal: AbortSignal.timeout((timeoutSeconds + 5) * 1000),
    });
    if (!response.ok) {
      throw new Error(`Telegram getUpdates failed: ${String(response.status)}`);
    }
    const payload = (await response.json()) as {
      ok: boolean;
      result?: TelegramUpdate[];
      description?: string;
    };
    if (!payload.ok) {
      throw new Error(payload.description ?? "Telegram API returned non-ok response");
    }
    return payload.result ?? [];
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    const htmlText = this.formatMarkdownLikeToTelegramHtml(text);
    const response = await fetch(`${this.baseUrl}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: htmlText,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) {
      return;
    }

    const fallbackResponse = await fetch(`${this.baseUrl}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!fallbackResponse.ok) {
      throw new Error(`Telegram sendMessage failed: ${String(fallbackResponse.status)}`);
    }
  }

  async sendChatAction(chatId: number, action: TelegramChatAction): Promise<void> {
    const response = await fetch(`${this.baseUrl}/sendChatAction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        action,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Telegram sendChatAction failed: ${String(response.status)}`);
    }
  }

  async setMyCommands(commands: TelegramCommand[]): Promise<void> {
    const response = await fetch(`${this.baseUrl}/setMyCommands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commands }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Telegram setMyCommands failed: ${String(response.status)}`);
    }
    const payload = (await response.json()) as { ok: boolean; description?: string };
    if (!payload.ok) {
      throw new Error(payload.description ?? "Telegram setMyCommands failed");
    }
  }

  async getFile(fileId: string): Promise<{ file_id: string; file_path?: string }> {
    const response = await fetch(`${this.baseUrl}/getFile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Telegram getFile failed: ${String(response.status)}`);
    }
    const payload = (await response.json()) as {
      ok: boolean;
      result?: { file_id: string; file_path?: string };
      description?: string;
    };
    if (!payload.ok || !payload.result) {
      throw new Error(payload.description ?? "Telegram getFile failed");
    }
    return payload.result;
  }

  async downloadFile(filePath: string): Promise<Uint8Array> {
    const response = await fetch(`${this.fileBaseUrl}/${filePath}`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`Telegram file download failed: ${String(response.status)}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async sendVoice(chatId: number, oggFilePath: string, caption?: string): Promise<void> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("voice", Bun.file(oggFilePath), "response.ogg");
    if (caption?.trim()) {
      form.append("caption", caption.trim());
    }

    const response = await fetch(`${this.baseUrl}/sendVoice`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) {
      throw new Error(`Telegram sendVoice failed: ${String(response.status)}`);
    }
  }
}
