# ClarityCheck - Decision Assistant for Telegram

ClarityCheck is a lightweight, single-user AI decision assistant you self-host and talk to via Telegram. It's built to do the things generic chat apps won't do by default: research, ask hard questions, and keep memory of completed decisions.

**What you get**
- A local/VPS gateway you control (`claritycheck gateway start|stop|status|logs`)
- A guided terminal setup (`claritycheck onboard`)
- Telegram commands to manage decisions (`/newdecision`, `/completedecision`, `/model ...`)
- Optional voice messages (Deepgram STT/TTS + `ffmpeg`)

## Quick Start (5 minutes)

### 1) Install Bun
Install Bun for your OS: https://bun.sh

### 2) Clone and install deps
```bash
git clone https://github.com/arham-saigol/ClarityCheck
cd claritycheck
bun install
```

### 3) Expose the CLI
Recommended (adds `claritycheck` to your Bun environment):
```bash
bun link
claritycheck --help
```

Alternative (no global link):
```bash
bun run claritycheck --help
```

### 4) Run the setup wizard
```bash
claritycheck onboard
```

### 5) Start the gateway
```bash
claritycheck gateway start
claritycheck gateway status
claritycheck gateway logs
```

### 6) Pair Telegram
1. In Telegram, message your bot: `/start`
2. Pair via one of:
   - Startup code (shown in `claritycheck gateway logs`): `/pair <CODE>`
   - Local approval flow:
     - in Telegram: `/pair`
     - in terminal: `claritycheck pair <CODE>`

You're ready. Send a normal message to start your first decision.

## Requirements
- Bun `>= 1.1`
- Telegram bot token
- At least one LLM provider API key:
  - Cerebras (`zai-glm-4.7`)
  - Groq (`moonshotai/kimi-k2-instruct-0905`)
  - OpenRouter (`arcee-ai/trinity-large-preview:free`)
- Optional:
  - Tavily and/or Brave API key (enables `web_search`)
  - Deepgram API key (voice STT/TTS)
  - `ffmpeg` (required for voice replies)

## Telegram Commands
- `/newdecision` start a fresh decision thread
- `/completedecision` finalize and save memory
- `/model cerebras|groq|openrouter` switch model provider
- `/voice on|off|auto|status` configure voice replies
- `/status` show gateway/session settings
- `/help` show command list

## Voice (Optional)
If you configure Deepgram during `claritycheck onboard`:
- Voice input: send a Telegram voice note, ClarityCheck transcribes it (STT) and continues the decision.
- Voice output: depending on `/voice` mode, ClarityCheck generates TTS audio and sends it back as a Telegram voice message.

Install `ffmpeg`:
- Windows: `winget install Gyan.FFmpeg`
- Ubuntu/Debian: `sudo apt-get update && sudo apt-get install -y ffmpeg`
- macOS: `brew install ffmpeg`

## Data and Security
ClarityCheck stores local state in your OS config directory:
- `config.json` (non-secret settings)
- `secrets.json` (local secrets)
- `claritycheck.sqlite` (decision memory)
- `gateway.pid`, `gateway.log`

## Troubleshooting

### "Onboarding incomplete"
Run `claritycheck onboard` and confirm your Telegram token is provided.

### "Executable not found in $PATH: ffmpeg"
ClarityCheck attempts to auto-install `ffmpeg` during `claritycheck onboard` (when Deepgram is configured) and `claritycheck gateway start`. If auto-install fails, install manually and start again.

### Config directory issues
Override the config dir:
```bash
export CLARITYCHECK_CONFIG_DIR="$PWD/.claritycheck"
```

### Optional env overrides
You can override secrets from environment variables:
`CLARITYCHECK_TELEGRAM_BOT_TOKEN`, `CLARITYCHECK_CEREBRAS_API_KEY`, `CLARITYCHECK_GROQ_API_KEY`, `CLARITYCHECK_OPENROUTER_API_KEY`, `CLARITYCHECK_TAVILY_API_KEY`, `CLARITYCHECK_BRAVE_API_KEY`, `CLARITYCHECK_DEEPGRAM_API_KEY`.

## Contributing
Issues and PRs welcome. Start by running:
```bash
bun test
bun x tsc --noEmit
```
