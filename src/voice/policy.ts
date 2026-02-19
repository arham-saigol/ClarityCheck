import type { VoiceReplyMode } from "../types";

export type UserInputType = "text" | "voice";

export function shouldSendVoiceReply(mode: VoiceReplyMode, inputType: UserInputType): boolean {
  if (mode === "on") {
    return true;
  }
  if (mode === "off") {
    return false;
  }
  return inputType === "voice";
}

