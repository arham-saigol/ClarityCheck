function stripHtml(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

export async function webFetch(url: string): Promise<{
  url: string;
  source: "jina" | "direct";
  content: string;
}> {
  const normalized = normalizeUrl(url);
  const jinaUrl = `https://r.jina.ai/${normalized}`;

  try {
    const response = await fetch(jinaUrl, { signal: AbortSignal.timeout(15_000) });
    if (response.ok) {
      const text = (await response.text()).slice(0, 20_000);
      return {
        url: normalized,
        source: "jina",
        content: text,
      };
    }
  } catch {
    // fallback path below
  }

  const response = await fetch(normalized, {
    headers: {
      "user-agent":
        "ClarityCheckBot/0.1 (+https://localhost; lightweight decision assistant)",
      accept: "text/html,application/xhtml+xml,application/xml",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`web_fetch failed with status ${String(response.status)}`);
  }
  const html = (await response.text()).slice(0, 200_000);
  return {
    url: normalized,
    source: "direct",
    content: stripHtml(html).slice(0, 20_000),
  };
}
