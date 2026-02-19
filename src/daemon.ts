import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { AppPaths } from "./paths";

function parsePid(value: string): number | undefined {
  const pid = Number.parseInt(value.trim(), 10);
  if (Number.isNaN(pid) || pid <= 0) {
    return undefined;
  }
  return pid;
}

export function readPid(paths: AppPaths): number | undefined {
  if (!existsSync(paths.pidFile)) {
    return undefined;
  }
  return parsePid(readFileSync(paths.pidFile, "utf8"));
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function cleanupPidFile(paths: AppPaths): void {
  if (existsSync(paths.pidFile)) {
    rmSync(paths.pidFile, { force: true });
  }
}

export function stopPid(paths: AppPaths): { stopped: boolean; pid?: number } {
  const pid = readPid(paths);
  if (!pid) {
    cleanupPidFile(paths);
    return { stopped: false };
  }
  if (!isPidAlive(pid)) {
    cleanupPidFile(paths);
    return { stopped: false, pid };
  }
  process.kill(pid);
  cleanupPidFile(paths);
  return { stopped: true, pid };
}

export async function startGatewayProcess(
  paths: AppPaths,
  env: Record<string, string | undefined>,
): Promise<{ started: boolean; pid?: number; reason?: string }> {
  const existingPid = readPid(paths);
  if (existingPid && isPidAlive(existingPid)) {
    return { started: false, pid: existingPid, reason: "already-running" };
  }

  cleanupPidFile(paths);

  const entry = fileURLToPath(new URL("./gateway.ts", import.meta.url));
  const runtime = process.versions.bun ? process.execPath : "bun";
  const args = process.versions.bun ? [entry] : ["run", entry];

  const child = Bun.spawn([runtime, ...args], {
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();
  writeFileSync(paths.pidFile, String(child.pid), "utf8");

  return { started: true, pid: child.pid };
}

export function resolveRoot(): string {
  return fileURLToPath(new URL("../", import.meta.url));
}

export function resolveProjectPath(...segments: string[]): string {
  return join(resolveRoot(), ...segments);
}

