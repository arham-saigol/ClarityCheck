# Setup Commands

## Local (PowerShell)
```powershell
cd E:\claritycheck
bun install
bun link

# Required for voice replies
winget install Gyan.FFmpeg

claritycheck onboard
claritycheck gateway start
claritycheck gateway status
claritycheck gateway logs
```

## VPS (Linux bash)
```bash
cd /opt/claritycheck
bun install
bun link

sudo apt-get update && sudo apt-get install -y ffmpeg

claritycheck onboard
claritycheck gateway start
claritycheck gateway status
```

## Pairing flow
1. In Telegram, send `/start`.
2. Option A: send `/pair <startup_code>` shown in `claritycheck gateway logs`.
3. Option B: send `/pair`, then locally run:

```bash
claritycheck pair <CODE>
```

## Decision flow commands
```text
/newdecision
/model cerebras
/model groq
/model openrouter
/voice on
/voice auto
/voice off
/completedecision
/status
/help
```
