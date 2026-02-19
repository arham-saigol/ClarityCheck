import { afterEach, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/constants";
import { webSearch } from "../src/tools/web-search";
import type { AppConfig, AppSecrets } from "../src/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function baseConfig(): AppConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.search.primary = "tavily";
  config.search.fallback = "brave";
  return config;
}

function baseSecrets(): AppSecrets {
  return {
    telegramBotToken: "token",
    providers: {},
    search: {
      tavilyApiKey: "tavily-key",
      braveApiKey: "brave-key",
    },
  };
}

test("webSearch falls back from Tavily to Brave on provider failure", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("tavily")) {
      return new Response("{}", { status: 500 });
    }
    return new Response(
      JSON.stringify({
        web: {
          results: [
            {
              title: "Result",
              url: "https://example.com",
              description: "Snippet",
            },
          ],
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  const result = await webSearch("clarity check", baseConfig(), baseSecrets());
  expect(result.providerUsed).toBe("brave");
  expect(result.results.length).toBe(1);
  expect(calls.length).toBe(2);
});

test("webSearch errors when no search key is configured", async () => {
  const config = baseConfig();
  const secrets: AppSecrets = {
    telegramBotToken: "token",
    providers: {},
    search: {},
  };

  await expect(webSearch("test", config, secrets)).rejects.toThrow(
    "No web_search provider configured",
  );
});
