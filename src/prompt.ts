import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export async function ask(
  question: string,
  options?: { required?: boolean; defaultValue?: string; allowEmpty?: boolean },
): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    while (true) {
      const suffix =
        options?.defaultValue !== undefined && options.defaultValue.length > 0
          ? ` (${options.defaultValue})`
          : "";
      const raw = await rl.question(`${question}${suffix}: `);
      const value = raw.trim();
      if (value.length > 0) {
        return value;
      }
      if (options?.defaultValue !== undefined) {
        return options.defaultValue;
      }
      if (options?.allowEmpty) {
        return "";
      }
      if (!options?.required) {
        return "";
      }
    }
  } finally {
    rl.close();
  }
}

export function toYesNo(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return ["y", "yes", "1", "true"].includes(normalized);
}

