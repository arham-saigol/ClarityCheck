import { afterEach, expect, test } from "bun:test";
import { TelegramClient } from "../src/telegram";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("sendMessage formats markdown-like text with HTML parse mode", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(input), body });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  const client = new TelegramClient("token");
  await client.sendMessage(1001, "**Start**\n## Key Reasons:\n`code`");

  expect(calls.length).toBe(1);
  expect(calls[0]?.body.parse_mode).toBe("HTML");
  expect(String(calls[0]?.body.text)).toContain("<b>Start</b>");
  expect(String(calls[0]?.body.text)).toContain("<b>Key Reasons:</b>");
  expect(String(calls[0]?.body.text)).toContain("<code>code</code>");
});

test("sendMessage falls back to plain text when HTML parse fails", async () => {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ body });
    if (calls.length === 1) {
      return new Response("bad parse", { status: 400 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  const client = new TelegramClient("token");
  await client.sendMessage(1001, "**Start**");

  expect(calls.length).toBe(2);
  expect(calls[0]?.body.parse_mode).toBe("HTML");
  expect(calls[1]?.body.parse_mode).toBeUndefined();
  expect(calls[1]?.body.text).toBe("**Start**");
});

