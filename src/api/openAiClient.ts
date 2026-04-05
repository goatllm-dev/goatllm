import { ChatRequest, StreamChunk, StreamEvent, ToolCall, ModelInfo, Endpoint } from './types';

const MAX_RETRIES = 3;

/**
 * OpenAI-compatible streaming chat client.
 * Works with any server that speaks the OpenAI /v1/chat/completions protocol:
 * MLX (mlx_lm.server), Ollama, LM Studio, llama.cpp server, exo, vLLM, etc.
 */
export class OpenAiClient {
  /** Usage from the most recent streamChat call */
  public lastUsage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };

  constructor(private getEndpoint: () => Endpoint | undefined) {}

  /** List models from the active endpoint's /v1/models */
  async listModels(): Promise<ModelInfo[]> {
    const ep = this.getEndpoint();
    if (!ep) throw new Error('No active endpoint configured.');

    const res = await fetch(`${trimTrailingSlash(ep.baseUrl)}/models`, {
      headers: authHeaders(ep.apiKey),
    });
    if (!res.ok) {
      throw new Error(`Failed to list models from ${ep.name}: ${res.status} ${res.statusText}`);
    }
    const body: any = await res.json();
    const data: any[] = body.data ?? body.models ?? [];
    return data.map((m) => ({
      id: m.id ?? m.name,
      name: m.name ?? m.id,
      contextLength: m.context_length ?? m.max_context_length,
      ownedBy: m.owned_by,
    }));
  }

  async *streamChat(
    request: ChatRequest,
    signal?: AbortSignal
  ): AsyncGenerator<StreamEvent> {
    const ep = this.getEndpoint();
    if (!ep) {
      throw new Error('No active endpoint configured. Run "GoatLLM: Select Endpoint".');
    }

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        yield* this._doStream(ep, request, signal);
        return;
      } catch (err: any) {
        lastError = err;
        if (err.name === 'AbortError') throw err;
        if (err.status === 429 || (err.status >= 500 && err.status < 600)) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }

    throw lastError ?? new Error('Max retries exceeded');
  }

  private async *_doStream(
    endpoint: Endpoint,
    request: ChatRequest,
    signal?: AbortSignal
  ): AsyncGenerator<StreamEvent> {
    const response = await fetch(`${trimTrailingSlash(endpoint.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        ...authHeaders(endpoint.apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...request, stream: true, stream_options: { include_usage: true } }),
      signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const err: any = new Error(
        `${endpoint.name} API error ${response.status}: ${body || response.statusText}`
      );
      err.status = response.status;
      throw err;
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Accumulators for tool_call deltas (indexed by their `index`)
    const toolCallAcc: Record<number, { id: string; name: string; arguments: string }> = {};
    let finishReason: string | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            const calls = this._finalizeToolCalls(toolCallAcc);
            if (calls.length > 0) {
              yield { type: 'tool_calls', toolCalls: calls };
            }
            yield { type: 'done', finishReason };
            return;
          }

          try {
            const chunk: StreamChunk = JSON.parse(data);
            if (chunk.usage) {
              this.lastUsage = chunk.usage;
            }
            const choice = chunk.choices?.[0];
            if (!choice) continue;

            if (choice.finish_reason) {
              finishReason = choice.finish_reason;
            }

            const delta = choice.delta;
            if (!delta) continue;

            if (delta.content) {
              yield { type: 'text', text: delta.content };
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index;
                if (!toolCallAcc[idx]) {
                  toolCallAcc[idx] = { id: '', name: '', arguments: '' };
                }
                if (tc.id) toolCallAcc[idx].id = tc.id;
                if (tc.function?.name) toolCallAcc[idx].name += tc.function.name;
                if (tc.function?.arguments) toolCallAcc[idx].arguments += tc.function.arguments;
              }
            }
          } catch {
            // skip malformed chunks
          }
        }
      }

      // Stream ended without [DONE] marker
      const calls = this._finalizeToolCalls(toolCallAcc);
      if (calls.length > 0) {
        yield { type: 'tool_calls', toolCalls: calls };
      }
      yield { type: 'done', finishReason };
    } finally {
      reader.releaseLock();
    }
  }

  private _finalizeToolCalls(
    acc: Record<number, { id: string; name: string; arguments: string }>
  ): ToolCall[] {
    const indices = Object.keys(acc)
      .map((k) => parseInt(k, 10))
      .sort((a, b) => a - b);
    return indices
      .map((i) => acc[i])
      .filter((tc) => tc.name)
      .map((tc) => ({
        id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      }));
  }
}

function trimTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey && apiKey.trim().length > 0
    ? { Authorization: `Bearer ${apiKey}` }
    : {};
}
