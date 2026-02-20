export interface FfmpegRunnerResult {
  exitCode: number;
  stderr: string;
  stdout?: string;
}

export type FfmpegRunner = (args: string[]) => FfmpegRunnerResult;
export type CommandRunner = (command: string, args: string[]) => FfmpegRunnerResult;

function defaultCommandRunner(command: string, args: string[]): FfmpegRunnerResult {
  try {
    const result = Bun.spawnSync([command, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 180_000,
    });
    return {
      exitCode: result.exitCode,
      stderr: Buffer.from(result.stderr).toString("utf8"),
      stdout: Buffer.from(result.stdout).toString("utf8"),
    };
  } catch (error) {
    return {
      exitCode: 1,
      stderr: (error as Error).message,
    };
  }
}

function defaultRunner(args: string[]): FfmpegRunnerResult {
  return defaultCommandRunner("ffmpeg", args);
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

export interface InstallFfmpegResult {
  installed: boolean;
  method?: string;
  attempted: string[];
  errors: string[];
}

interface InstallerStep {
  command: string;
  args: string[];
}

interface InstallerPlan {
  method: string;
  steps: InstallerStep[];
}

function toCommandText(step: InstallerStep): string {
  return `${step.command} ${step.args.join(" ")}`.trim();
}

function ffmpegProbeWithRunner(runner: CommandRunner): FfmpegRunner {
  return (args: string[]) => runner("ffmpeg", args);
}

function resolvePlans(platform: NodeJS.Platform): InstallerPlan[] {
  if (platform === "win32") {
    return [
      {
        method: "winget",
        steps: [
          {
            command: "winget",
            args: [
              "install",
              "--id",
              "Gyan.FFmpeg",
              "-e",
              "--accept-package-agreements",
              "--accept-source-agreements",
            ],
          },
        ],
      },
      {
        method: "choco",
        steps: [
          {
            command: "choco",
            args: ["install", "ffmpeg", "-y"],
          },
        ],
      },
      {
        method: "scoop",
        steps: [
          {
            command: "scoop",
            args: ["install", "ffmpeg"],
          },
        ],
      },
    ];
  }

  if (platform === "darwin") {
    return [
      {
        method: "brew",
        steps: [
          {
            command: "brew",
            args: ["install", "ffmpeg"],
          },
        ],
      },
    ];
  }

  return [
    {
      method: "apt-get",
      steps: [
        { command: "apt-get", args: ["update"] },
        { command: "apt-get", args: ["install", "-y", "ffmpeg"] },
      ],
    },
    {
      method: "sudo apt-get",
      steps: [
        { command: "sudo", args: ["apt-get", "update"] },
        { command: "sudo", args: ["apt-get", "install", "-y", "ffmpeg"] },
      ],
    },
    {
      method: "dnf",
      steps: [{ command: "dnf", args: ["install", "-y", "ffmpeg"] }],
    },
    {
      method: "yum",
      steps: [{ command: "yum", args: ["install", "-y", "ffmpeg"] }],
    },
    {
      method: "pacman",
      steps: [{ command: "pacman", args: ["-Sy", "--noconfirm", "ffmpeg"] }],
    },
    {
      method: "apk",
      steps: [{ command: "apk", args: ["add", "ffmpeg"] }],
    },
  ];
}

export function installFfmpegAuto(
  options?: {
    platform?: NodeJS.Platform;
    runner?: CommandRunner;
  },
): InstallFfmpegResult {
  const runner = options?.runner ?? defaultCommandRunner;
  const platform = options?.platform ?? process.platform;
  const attempted: string[] = [];
  const errors: string[] = [];
  const probe = ffmpegProbeWithRunner(runner);

  if (isFfmpegInstalled(probe)) {
    return {
      installed: true,
      method: "already-installed",
      attempted,
      errors,
    };
  }

  const plans = resolvePlans(platform);
  for (const plan of plans) {
    let planOk = true;
    for (const step of plan.steps) {
      attempted.push(toCommandText(step));
      const result = runner(step.command, step.args);
      if (result.exitCode !== 0) {
        const msg = result.stderr?.trim() || result.stdout?.trim() || "unknown error";
        errors.push(`${toCommandText(step)} -> ${msg}`);
        planOk = false;
        break;
      }
    }

    if (planOk && isFfmpegInstalled(probe)) {
      return {
        installed: true,
        method: plan.method,
        attempted,
        errors,
      };
    }
  }

  return {
    installed: false,
    attempted,
    errors,
  };
}
