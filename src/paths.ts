import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { APP_NAME } from "./constants";

export interface AppPaths {
  configDir: string;
  configFile: string;
  secretsFile: string;
  dbFile: string;
  pidFile: string;
  logFile: string;
}

function resolveBaseDir(): string {
  if (process.env.CLARITYCHECK_CONFIG_DIR) {
    return process.env.CLARITYCHECK_CONFIG_DIR;
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, APP_NAME);
  }

  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdg, APP_NAME);
}

export function getAppPaths(): AppPaths {
  const configDir = resolveBaseDir();
  return {
    configDir,
    configFile: join(configDir, "config.json"),
    secretsFile: join(configDir, "secrets.json"),
    dbFile: join(configDir, "claritycheck.sqlite"),
    pidFile: join(configDir, "gateway.pid"),
    logFile: join(configDir, "gateway.log"),
  };
}

export function ensureConfigDir(paths: AppPaths): void {
  mkdirSync(paths.configDir, { recursive: true });
}
