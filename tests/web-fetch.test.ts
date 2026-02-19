import { afterEach, expect, test } from "bun:test";
import { webFetch } from "../src/tools/web-fetch";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("webFetch uses Jina Reader first when available", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    return new Response("Jina extracted content", { status: 200 });
  }) as typeof fetch;

  const result = await webFetch("https://example.com/path");
  expect(result.source).toBe("jina");
  expect(result.content).toContain("Jina extracted content");
  expect(calls[0]).toBe("https://r.jina.ai/https://example.com/path");
  expect(calls.length).toBe(1);
});

test("webFetch falls back to direct fetch when Jina fails", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (calls.length === 1) {
      throw new Error("network fail");
    }
    return new Response("<html><body><h1>Hello</h1><p>World</p></body></html>", { status: 200 });
  }) as typeof fetch;

  const result = await webFetch("example.com");
  expect(result.source).toBe("direct");
  expect(result.content).toContain("Hello");
  expect(result.content).toContain("World");
  expect(calls[0]).toBe("https://r.jina.ai/https://example.com");
  expect(calls[1]).toBe("https://example.com");
});
