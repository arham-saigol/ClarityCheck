import { expect, test } from "bun:test";
import {
  convertWavToOggOpus,
  installFfmpegAuto,
  isFfmpegInstalled,
} from "../src/voice/ffmpeg";

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

test("installFfmpegAuto returns already-installed when ffmpeg exists", () => {
  const result = installFfmpegAuto({
    platform: "win32",
    runner: (command, args) => {
      if (command === "ffmpeg" && args[0] === "-version") {
        return { exitCode: 0, stderr: "" };
      }
      return { exitCode: 1, stderr: "unexpected call" };
    },
  });
  expect(result.installed).toBeTrue();
  expect(result.method).toBe("already-installed");
});

test("installFfmpegAuto installs with winget on windows", () => {
  let ffmpegInstalled = false;
  const result = installFfmpegAuto({
    platform: "win32",
    runner: (command, args) => {
      if (command === "ffmpeg" && args[0] === "-version") {
        return ffmpegInstalled ? { exitCode: 0, stderr: "" } : { exitCode: 1, stderr: "missing" };
      }
      if (command === "winget") {
        ffmpegInstalled = true;
        return { exitCode: 0, stderr: "" };
      }
      return { exitCode: 1, stderr: "not attempted" };
    },
  });
  expect(result.installed).toBeTrue();
  expect(result.method).toBe("winget");
});

test("installFfmpegAuto returns failure when installers fail", () => {
  const result = installFfmpegAuto({
    platform: "darwin",
    runner: (_command, _args) => ({ exitCode: 1, stderr: "fail" }),
  });
  expect(result.installed).toBeFalse();
  expect(result.errors.length).toBeGreaterThan(0);
});

