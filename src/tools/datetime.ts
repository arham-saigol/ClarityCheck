export function getDateTime(): { iso: string; timezone: string; unixMs: number } {
  const now = new Date();
  const timezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone ?? `UTC${String(-now.getTimezoneOffset() / 60)}`;
  return {
    iso: now.toISOString(),
    timezone,
    unixMs: now.getTime(),
  };
}

