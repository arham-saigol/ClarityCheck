import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { EOL } from "node:os";

export function logLine(logFile: string, level: "INFO" | "WARN" | "ERROR", message: string): void {
  const line = `${new Date().toISOString()} [${level}] ${message}${EOL}`;
  appendFileSync(logFile, line, "utf8");
}

export function tailLog(logFile: string, lineCount = 120): string {
  if (!existsSync(logFile)) {
    return "";
  }
  const content = readFileSync(logFile, "utf8");
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
  return lines.slice(-lineCount).join(EOL);
}

