export interface DeepgramTranscribeResult {
  transcript: string;
  confidence?: number;
}

export interface DeepgramTranscribeOptions {
  apiKey: string;
  model: string;
  mimeType: string;
}

type FetchLike = typeof fetch;

function deepgramAuthHeader(apiKey: string): Record<string, string> {
  return {
    Authorization: `Token ${apiKey}`,
  };
}

export async function transcribeAudioWithDeepgram(
  audio: Uint8Array,
  options: DeepgramTranscribeOptions,
  fetchImpl: FetchLike = fetch,
): Promise<DeepgramTranscribeResult> {
  const url = new URL("https://api.deepgram.com/v1/listen");
  url.searchParams.set("model", options.model);
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("punctuate", "true");

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      ...deepgramAuthHeader(options.apiKey),
      "content-type": options.mimeType,
    },
    body: audio,
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Deepgram STT failed (${String(response.status)}): ${errText || "request failed"}`);
  }

  const payload = (await response.json()) as {
    results?: {
      channels?: Array<{
        alternatives?: Array<{
          transcript?: string;
          confidence?: number;
        }>;
      }>;
    };
  };
  const alternative = payload.results?.channels?.[0]?.alternatives?.[0];
  const transcript = alternative?.transcript?.trim() ?? "";
  if (!transcript) {
    throw new Error("Deepgram STT returned empty transcript.");
  }
  return {
    transcript,
    confidence: alternative?.confidence,
  };
}

export interface DeepgramSynthesizeOptions {
  apiKey: string;
  model: string;
  encoding: "linear16";
  container: "wav";
}

export async function synthesizeSpeechWithDeepgram(
  text: string,
  options: DeepgramSynthesizeOptions,
  fetchImpl: FetchLike = fetch,
): Promise<Uint8Array> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Cannot synthesize empty text.");
  }
  const url = new URL("https://api.deepgram.com/v1/speak");
  url.searchParams.set("model", options.model);
  url.searchParams.set("encoding", options.encoding);
  url.searchParams.set("container", options.container);

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      ...deepgramAuthHeader(options.apiKey),
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: trimmed }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Deepgram TTS failed (${String(response.status)}): ${errText || "request failed"}`);
  }
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength === 0) {
    throw new Error("Deepgram TTS returned empty audio.");
  }
  return data;
}

