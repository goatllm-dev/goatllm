import { ToolCall } from '../api/types';

const OPEN_TAG = '<tool_call>';
const CLOSE_TAG = '</tool_call>';

/**
 * Streaming parser that extracts `<tool_call>{...}</tool_call>` blocks from
 * model text output. Designed for models that don't support native OpenAI
 * function-calling (e.g. Gemma, base Llama) but can be prompted to emit a
 * structured JSON tool call as plain text.
 *
 * Usage:
 *   const x = new ToolCallExtractor();
 *   for each streamed chunk:
 *     const { visible, toolCalls } = x.push(chunk);
 *     -> emit `visible` to the UI
 *     -> queue `toolCalls` for execution
 *   const tail = x.flush();  // end of stream
 *
 * Safety: characters that *might* be the start of an opening tag are held
 * back so the UI never flashes a partial "<tool_" before the parser can
 * decide whether it's a tool call or literal text.
 */
export class ToolCallExtractor {
  private buffer = '';
  private inBlock = false;
  private callCounter = 0;

  push(chunk: string): { visible: string; toolCalls: ToolCall[] } {
    this.buffer += chunk;
    const toolCalls: ToolCall[] = [];
    let visible = '';

    while (true) {
      if (!this.inBlock) {
        const idx = this.buffer.indexOf(OPEN_TAG);
        if (idx !== -1) {
          visible += this.buffer.slice(0, idx);
          this.buffer = this.buffer.slice(idx + OPEN_TAG.length);
          this.inBlock = true;
          continue;
        }
        // Hold back a tail that might be the start of an opening tag.
        const hold = partialPrefixLength(this.buffer, OPEN_TAG);
        visible += this.buffer.slice(0, this.buffer.length - hold);
        this.buffer = this.buffer.slice(this.buffer.length - hold);
        break;
      } else {
        const idx = this.buffer.indexOf(CLOSE_TAG);
        if (idx === -1) break; // still collecting inside the block
        const jsonText = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + CLOSE_TAG.length);
        this.inBlock = false;
        const call = this.parseCall(jsonText);
        if (call) toolCalls.push(call);
      }
    }

    return { visible, toolCalls };
  }

  /** Emit any trailing visible text. Drops an incomplete tool_call block. */
  flush(): string {
    if (this.inBlock) {
      // Incomplete block at EOS — drop it, caller can see finishReason.
      this.buffer = '';
      this.inBlock = false;
      return '';
    }
    const out = this.buffer;
    this.buffer = '';
    return out;
  }

  private parseCall(jsonText: string): ToolCall | null {
    // Strip optional ```json fences that some models add inside the block.
    const cleaned = jsonText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    try {
      const obj = JSON.parse(cleaned);
      const name: string | undefined = obj.name ?? obj.tool ?? obj.function;
      const args = obj.arguments ?? obj.args ?? obj.parameters ?? {};
      if (!name || typeof name !== 'string') return null;
      this.callCounter += 1;
      return {
        id: `textcall_${Date.now().toString(36)}_${this.callCounter}`,
        type: 'function',
        function: {
          name,
          arguments: typeof args === 'string' ? args : JSON.stringify(args),
        },
      };
    } catch {
      return null;
    }
  }
}

/** Length of the longest suffix of `s` that is a prefix of `needle`. */
function partialPrefixLength(s: string, needle: string): number {
  const max = Math.min(s.length, needle.length - 1);
  for (let len = max; len > 0; len--) {
    if (needle.startsWith(s.slice(s.length - len))) return len;
  }
  return 0;
}
