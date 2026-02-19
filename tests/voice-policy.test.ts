import { expect, test } from "bun:test";
import { shouldSendVoiceReply } from "../src/voice/policy";

test("voice policy off never sends voice", () => {
  expect(shouldSendVoiceReply("off", "text")).toBeFalse();
  expect(shouldSendVoiceReply("off", "voice")).toBeFalse();
});

test("voice policy on always sends voice", () => {
  expect(shouldSendVoiceReply("on", "text")).toBeTrue();
  expect(shouldSendVoiceReply("on", "voice")).toBeTrue();
});

test("voice policy auto sends voice only for voice input", () => {
  expect(shouldSendVoiceReply("auto", "text")).toBeFalse();
  expect(shouldSendVoiceReply("auto", "voice")).toBeTrue();
});

