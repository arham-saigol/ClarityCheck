import type { AppConfig, GatewayStatus } from "./types";

function controlBaseUrl(config: AppConfig): string {
  return `http://${config.gateway.controlHost}:${config.gateway.controlPort}`;
}

async function postJson<T>(url: string, body: object): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? `Control API error ${String(response.status)}`);
  }
  return payload;
}

export async function getGatewayHealth(config: AppConfig): Promise<GatewayStatus> {
  const response = await fetch(`${controlBaseUrl(config)}/health`);
  if (!response.ok) {
    throw new Error(`Gateway health failed with ${String(response.status)}`);
  }
  return (await response.json()) as GatewayStatus;
}

export async function approvePairCode(config: AppConfig, code: string): Promise<{ chatId: number }> {
  return postJson<{ chatId: number }>(`${controlBaseUrl(config)}/pair/approve`, { code });
}

