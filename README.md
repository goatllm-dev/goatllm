# GoatLLM — Local AI Coding Assistant

Chat with open-source LLMs running on your own machine, right inside VS Code. No accounts, no cloud, no data leaves your device.

**Works out-of-the-box with:**
- [MLX](https://github.com/ml-explore/mlx-lm) (Apple Silicon)
- [Ollama](https://ollama.com)
- [LM Studio](https://lmstudio.ai)
- [llama.cpp server](https://github.com/ggerganov/llama.cpp)
- [exo](https://github.com/exo-explore/exo) (distributed)
- [vLLM](https://github.com/vllm-project/vllm)
- Any OpenAI-compatible endpoint

## Features

- **Auto-detect local servers** — one command probes common ports and wires everything up
- **Live model list** — reads `/v1/models` from your server; switch models with one click
- **Agent mode** — native tool calling: read files, edit files, run commands, with optional approval gates
- **Full autonomy mode** — hands-off coding agent that iterates until the task is done
- **Streaming** — token-by-token responses with live tokens/sec in the status bar
- **Multiple endpoints** — hot-swap between local MLX, remote Mac over Thunderbolt, exo cluster, etc.
- **Nothing phones home** — no telemetry, no logins, no rate limits

## Quick start

1. Start a local LLM server. On Apple Silicon:
   ```bash
   pip install -U "git+https://github.com/ml-explore/mlx-lm.git"
   mlx_lm.server --model mlx-community/Qwen2.5-Coder-32B-Instruct-4bit --port 8013 --host localhost
   ```
   Or with Ollama:
   ```bash
   ollama serve
   ollama pull qwen2.5-coder:32b
   ```

2. Install the GoatLLM extension (or F5 from this repo for development).

3. Open the GoatLLM sidebar, click **Detect local servers**. Done.

## Configuration

Everything is in VS Code settings under `goatllm.*`:

| Setting | What it does |
|---|---|
| `goatllm.endpoints` | Array of `{name, baseUrl, apiKey?}` — your connected servers |
| `goatllm.activeEndpoint` | Name of the currently-selected endpoint |
| `goatllm.defaultModel` | Default model id (falls back to first from `/v1/models`) |
| `goatllm.temperature` | 0 (deterministic) → 2 (creative) |
| `goatllm.maxTokens` | Max tokens to generate per response |
| `goatllm.systemPrompt.chat` | Custom system prompt for Chat mode |
| `goatllm.systemPrompt.agent` | Custom system prompt for Agent mode |
| `goatllm.systemPrompt.agentFull` | Custom system prompt for Agent (full access) mode |
| `goatllm.commandDenyList` | Extra substrings to block in Agent modes |
| `goatllm.allowSudo` | Allow `sudo` in Agent modes (default: false) |

API keys are stored in VS Code's `SecretStorage`, not in settings.

## Modes

| Mode | Tools | Approval |
|---|---|---|
| **Chat** | none | — |
| **Agent** | `read_file`, `list_directory`, `write_file`, `run_command` | asks for writes/commands |
| **Agent (full access)** | all four | auto-approves everything |

Agent mode uses OpenAI-style `tool_choice: auto` — your local model must support tool calling. Most recent Qwen, Llama 3.1+, Gemma 2+, DeepSeek, and Mistral models do.

## Security

Agent modes block dangerous command patterns by default: `rm -rf /`, `mkfs`, fork bombs, etc. `sudo` is blocked unless `goatllm.allowSudo` is true. Add your own patterns via `goatllm.commandDenyList`.

Write and command calls require manual approval in `Agent` mode. `Agent (full access)` skips approval — use with caution and keep an eye on what it does.

## Why "GoatLLM"

Because the best LLM is the one you can run locally, own completely, and doesn't cost $0.02 per request. 🐐

## License

MIT. See [LICENSE](LICENSE).
