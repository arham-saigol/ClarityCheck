import { afterEach, expect, test } from "bun:test";
import {
  synthesizeSpeechWithDeepgram,
  transcribeAudioWithDeepgram,
} from "../src/voice/deepgram";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("transcribeAudioWithDeepgram parses transcript", async () => {
  globalThis.fetch = (async (_input: string | URL | Request) =>
    new Response(
      JSON.stringify({
        results: {
          channels: [
            {
              alternatives: [
                {
                  transcript: "hello world",
                  confidence: 0.92,
                },
              ],
            },
          ],
        },
      }),
      { status: 200 },
    )) as typeof fetch;

  const result = await transcribeAudioWithDeepgram(
    new Uint8Array([1, 2, 3]),
    {
      apiKey: "dg-key",
      model: "nova-3",
      mimeType: "audio/ogg",
    },
    globalThis.fetch,
  );
  expect(result.transcript).toBe("hello world");
  expect(result.confidence).toBe(0.92);
});

test("synthesizeSpeechWithDeepgram returns wav bytes", async () => {
  globalThis.fetch = (async (_input: string | URL | Request) =>
    new Response(new Uint8Array([82, 73, 70, 70]), { status: 200 })) as typeof fetch;

  const wav = await synthesizeSpeechWithDeepgram(
    "test",
    {
      apiKey: "dg-key",
      model: "aura-2-thalia-en",
      encoding: "linear16",
      container: "wav",
    },
    globalThis.fetch,
  );
  expect(wav.byteLength).toBeGreaterThan(0);
});

