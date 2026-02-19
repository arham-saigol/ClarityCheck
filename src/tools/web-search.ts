import type { AppConfig, AppSecrets, SearchProviderName, WebSearchResult } from "../types";

async function tavilySearch(query: string, apiKey: string): Promise<WebSearchResult> {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: "advanced",
      max_results: 5,
      include_answer: false,
    }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    throw new Error(`Tavily search failed: ${String(response.status)}`);
  }
  const payload = (await response.json()) as {
    results?: Array<{
      title?: string;
      url?: string;
      content?: string;
      published_date?: string;
    }>;
  };
  return {
    query,
    providerUsed: "tavily",
    results: (payload.results ?? []).map((item) => ({
      title: item.title ?? "Untitled",
      url: item.url ?? "",
      snippet: item.content ?? "",
      publishedDate: item.published_date,
      source: "tavily",
    })),
  };
}

async function braveSearch(query: string, apiKey: string): Promise<WebSearchResult> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "5");
  url.searchParams.set("text_decorations", "0");
  url.searchParams.set("search_lang", "en");
  url.searchParams.set("safesearch", "moderate");

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    throw new Error(`Brave search failed: ${String(response.status)}`);
  }
  const payload = (await response.json()) as {
    web?: {
      results?: Array<{
        title?: string;
        url?: string;
        description?: string;
        age?: string;
      }>;
    };
  };
  return {
    query,
    providerUsed: "brave",
    results: (payload.web?.results ?? []).map((item) => ({
      title: item.title ?? "Untitled",
      url: item.url ?? "",
      snippet: item.description ?? "",
      publishedDate: item.age,
      source: "brave",
    })),
  };
}

function chooseSearchOrder(config: AppConfig): SearchProviderName[] {
  const order: SearchProviderName[] = [];
  if (config.search.primary) {
    order.push(config.search.primary);
  }
  if (config.search.fallback && config.search.fallback !== config.search.primary) {
    order.push(config.search.fallback);
  }
  if (!order.includes("tavily")) {
    order.push("tavily");
  }
  if (!order.includes("brave")) {
    order.push("brave");
  }
  return order;
}

export async function webSearch(
  query: string,
  config: AppConfig,
  secrets: AppSecrets,
): Promise<WebSearchResult> {
  const order = chooseSearchOrder(config);
  let lastError: Error | undefined;

  for (const provider of order) {
    try {
      if (provider === "tavily" && secrets.search.tavilyApiKey) {
        return await tavilySearch(query, secrets.search.tavilyApiKey);
      }
      if (provider === "brave" && secrets.search.braveApiKey) {
        return await braveSearch(query, secrets.search.braveApiKey);
      }
    } catch (error) {
      lastError = error as Error;
    }
  }

  throw new Error(
    lastError?.message ??
      "No web_search provider configured. Add Tavily and/or Brave keys in 'claritycheck onboard'.",
  );
}
