export interface FfmpegRunnerResult {
  exitCode: number;
  stderr: string;
}

export type FfmpegRunner = (args: string[]) => FfmpegRunnerResult;

function defaultRunner(args: string[]): FfmpegRunnerResult {
  try {
    const result = Bun.spawnSync(["ffmpeg", ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: result.exitCode,
      stderr: Buffer.from(result.stderr).toString("utf8"),
    };
  } catch (error) {
    return {
      exitCode: 1,
      stderr: (error as Error).message,
    };
  }
}

export function isFfmpegInstalled(runner: FfmpegRunner = defaultRunner): boolean {
  const result = runner(["-version"]);
  return result.exitCode === 0;
}

export function convertWavToOggOpus(
  wavPath: string,
  oggPath: string,
  runner: FfmpegRunner = defaultRunner,
): void {
  const args = [
    "-y",
    "-i",
    wavPath,
    "-vn",
    "-acodec",
    "libopus",
    "-b:a",
    "32k",
    "-vbr",
    "on",
    "-application",
    "voip",
    oggPath,
  ];
  const result = runner(args);
  if (result.exitCode !== 0) {
    throw new Error(`ffmpeg conversion failed: ${result.stderr.trim() || "unknown error"}`);
  }
}
