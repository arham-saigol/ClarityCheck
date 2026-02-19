import { expect, test } from "bun:test";
import { convertWavToOggOpus, isFfmpegInstalled } from "../src/voice/ffmpeg";

test("isFfmpegInstalled returns true when runner succeeds", () => {
  const available = isFfmpegInstalled(() => ({ exitCode: 0, stderr: "" }));
  expect(available).toBeTrue();
});

test("convertWavToOggOpus throws on non-zero exit code", () => {
  expect(() =>
    convertWavToOggOpus("in.wav", "out.ogg", () => ({
      exitCode: 1,
      stderr: "bad file",
    })),
  ).toThrow("ffmpeg conversion failed");
});

