import * as vscode from 'vscode';
import { OpenAiClient } from '../api/openAiClient';
import { enrichModelInfo } from '../api/models';
import { ChatMessage, ToolCall, ModelInfo } from '../api/types';
import { EndpointManager } from '../endpoint/endpointManager';
import { buildChatHtml } from './chatHtml';
import {
  AGENT_TOOLS,
  READ_ONLY_TOOLS,
  toUiAction,
  executeToolCall,
  ToolExecutionResult,
} from '../agent/tools';
import { ToolCallExtractor } from '../agent/toolCallExtractor';

const MAX_AGENT_ITERATIONS = 25;

/**
 * Stop sequences sent on every request. These catch runaway generation when
 * a local server's chat template doesn't emit a proper EOS token and the model
 * starts hallucinating the next conversational turn as plain text.
 */
const DEFAULT_STOP_SEQUENCES = [
  // Plain-text fake turns — with colon
  '\nUSER:', '\nuser:', '\nHuman:', '\nHUMAN:',
  '\nASSISTANT:', '\nassistant:', '\nmodel:', '\nMODEL:',
  // Without colon (bare role label on its own line)
  '\nUSER\n', '\nuser\n', '\nHuman\n', '\nHUMAN\n',
  '\nASSISTANT\n', '\nassistant\n', '\nmodel\n', '\nMODEL\n',
  // Model-family-specific end-of-turn tokens
  '<end_of_turn>',          // Gemma
  '<start_of_turn>',        // Gemma (next turn start)
  '<|im_end|>',             // ChatML (Qwen, Yi, Mistral derivatives)
  '<|eot_id|>',             // Llama 3
  '<|end_of_turn|>',        // Command-R variant
  '<|END_OF_TURN_TOKEN|>',  // Command-R
];

/**
 * Patterns that indicate the model started hallucinating a fake next turn.
 * If any of these appear in the streamed output, we truncate there — a
 * client-side safety net in case the server ignored our `stop` array.
 */
const FAKE_TURN_PATTERNS = [
  // Role labels on their own line (colon optional, trailing whitespace ok).
  // Word boundary \b avoids matching USERNAME, ASSISTANTSHIP, etc.
  /\n\s*USER\b\s*:?\s*\n?/i,
  /\n\s*HUMAN\b\s*:?\s*\n?/i,
  /\n\s*ASSISTANT\b\s*:?\s*\n?/i,
  /\n\s*MODEL\b\s*:?\s*\n?/i,
  // Chat-template markers leaking as raw text
  /<end_of_turn>/,
  /<start_of_turn>/,
  /<\|im_end\|>/,
  /<\|eot_id\|>/,
  /<\|end_of_turn\|>/,
  /<\|END_OF_TURN_TOKEN\|>/,
];

function truncateAtFakeTurn(text: string): string {
  let earliest = text.length;
  for (const pat of FAKE_TURN_PATTERNS) {
    const m = text.match(pat);
    if (m && m.index !== undefined && m.index < earliest) {
      earliest = m.index;
    }
  }
  return earliest < text.length ? text.slice(0, earliest) : text;
}

const IDENTITY_PREAMBLE = `You are GoatLLM, a local coding assistant running on the user's own machine. Only if the user directly asks what model or AI you are, briefly say you are the local model they loaded in their endpoint and that you don't know its specific name. Do not volunteer this information, do not disclaim commercial models, and do not mention your identity unless asked. Never claim to be GPT-4, ChatGPT, Claude, Gemini, or any commercial model.

Reply only with your own single turn. Never write "USER:", "ASSISTANT:", "Human:", or similar role labels in your output. Never continue the conversation for the user. Stop when your reply is complete.`;

const TOOL_CALL_FORMAT_INSTRUCTIONS = `## How to call tools

When you need to use a tool, emit a tool call wrapped in <tool_call> tags containing a single JSON object with "name" and "arguments". Emit nothing else on the lines containing the tool call.

Format (exactly):
<tool_call>
{"name": "TOOL_NAME", "arguments": {"ARG": "VALUE"}}
</tool_call>

Examples:

To list the workspace root:
<tool_call>
{"name": "list_directory", "arguments": {"path": "."}}
</tool_call>

To read a file:
<tool_call>
{"name": "read_file", "arguments": {"path": "src/index.ts"}}
</tool_call>

To create a directory called "test":
<tool_call>
{"name": "run_command", "arguments": {"command": "mkdir -p test", "explanation": "create the test folder"}}
</tool_call>

To write a file:
<tool_call>
{"name": "write_file", "arguments": {"path": "test/hello.txt", "content": "Hello, world!"}}
</tool_call>

Rules:
- Use this exact <tool_call>...</tool_call> format. Do NOT write "Action:", "Thinking:", "Observation:", or any other ReAct-style labels.
- Emit ONE tool call per turn. After the tool runs you will see its result and can issue the next call.
- The JSON must be valid. Escape quotes and newlines inside string values.
- You may write a brief sentence of intent BEFORE the tool call, but after the <tool_call> block stop immediately and wait for the result.
- When the task is fully complete, respond with a short summary and NO <tool_call> block.`;

const DEFAULT_SYSTEM_PROMPTS: Record<string, string> = {
  chat: `${IDENTITY_PREAMBLE}

You are helpful, concise, and accurate. When writing code, use markdown code blocks with the language specified. You are in Chat mode — answer questions and have conversations. Do not suggest file edits or terminal commands unless the user explicitly asks.`,

  agent: `${IDENTITY_PREAMBLE}

You are an AI coding agent with native tool access, operating directly inside the user's VS Code workspace.

Tools available to you:
- read_file(path): read a workspace file
- list_directory(path): list a directory
- write_file(path, content): create or overwrite a file with COMPLETE content
- run_command(command, explanation): run a shell command (bash/cmd) and get stdout/stderr/exit code

Operating principles:
- Before editing, READ the files you plan to modify. Before creating, LIST the directory to avoid collisions.
- After making changes, VERIFY with run_command (build, typecheck, tests, etc).
- If a command fails, read the output and iterate — fix the real problem, do not give up.
- When you are done with a task, respond with a brief summary and NO further tool calls.
- Never include partial file snippets in write_file; always provide the full new file.
- The user must approve write_file and run_command invocations. read_file and list_directory run automatically.
- Be decisive and autonomous. The user sees what you do in real time.

${TOOL_CALL_FORMAT_INSTRUCTIONS}`,

  'agent-full': `${IDENTITY_PREAMBLE}

You are an AI coding agent with native tool access and full autonomy. All tool calls execute immediately without human approval.

Tools available to you:
- read_file(path): read a workspace file
- list_directory(path): list a directory
- write_file(path, content): create or overwrite a file with COMPLETE content
- run_command(command, explanation): run a shell command (bash/cmd) and get stdout/stderr/exit code

Operating principles:
- Be thorough and decisive. Do not ask "should I proceed?" — investigate, plan, act, verify.
- Always READ files before editing them; LIST directories before creating new files there.
- After making changes, VERIFY with run_command (build, typecheck, tests, lint).
- If a command fails, read the output carefully and iterate until the task is actually complete.
- Never include partial file snippets in write_file; always provide the full new file content.
- When the task is complete and verified, respond with a brief summary and NO further tool calls.
- You are the developer. Own the outcome.

${TOOL_CALL_FORMAT_INSTRUCTIONS}`,
};

const PROMPT_CONFIG_KEYS: Record<string, string> = {
  chat: 'systemPrompt.chat',
  agent: 'systemPrompt.agent',
  'agent-full': 'systemPrompt.agentFull',
};

function getSystemPrompt(mode: string): string {
  const config = vscode.workspace.getConfiguration('goatllm');
  const configKey = PROMPT_CONFIG_KEYS[mode];
  const custom = configKey ? config.get<string>(configKey, '') : '';
  return custom?.trim() || DEFAULT_SYSTEM_PROMPTS[mode] || DEFAULT_SYSTEM_PROMPTS.chat;
}

interface PendingApproval {
  resolve: (approved: boolean) => void;
}

export class GoatLlmChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'goatllm.chatView';

  private view?: vscode.WebviewView;
  private abortController?: AbortController;
  /** Map of tool_call_id → pending approval promise resolver (agent mode only) */
  private pendingApprovals = new Map<string, PendingApproval>();

  constructor(
    private extensionUri: vscode.Uri,
    private client: OpenAiClient,
    private endpointManager: EndpointManager,
    private globalState: vscode.Memento
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };

    const config = vscode.workspace.getConfiguration('goatllm');
    const defaultModel = config.get<string>('defaultModel', '');

    // Initial render with empty model list; refresh asynchronously.
    webviewView.webview.html = buildChatHtml(
      webviewView.webview,
      this.extensionUri,
      [],
      defaultModel
    );

    // Kick off async model refresh from active endpoint
    this.refreshModels();

    // Prompt to pick/add endpoint if none configured
    if (!this.endpointManager.getActiveSync()) {
      this.postMessage({ type: 'needsEndpoint' });
    }

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'chat':
          await this.handleChat(msg.messages, msg.model, msg.mode);
          break;
        case 'stop':
          this.abortController?.abort();
          for (const [, p] of this.pendingApprovals) {
            p.resolve(false);
          }
          this.pendingApprovals.clear();
          break;
        case 'settings':
          await this.sendSettingsToWebview();
          break;
        case 'selectEndpoint':
          await vscode.commands.executeCommand('goatllm.selectEndpoint');
          await this.refreshModels();
          break;
        case 'addEndpoint':
          await vscode.commands.executeCommand('goatllm.addEndpoint');
          await this.refreshModels();
          break;
        case 'detectServers':
          await vscode.commands.executeCommand('goatllm.detectLocalServers');
          await this.refreshModels();
          break;
        case 'refreshModels':
          await this.refreshModels();
          break;
        case 'saveSettings':
          await this.handleSaveSettings(msg);
          break;
        case 'saveChat':
          await this.handleSaveChat(msg);
          break;
        case 'loadHistory':
          this.handleLoadHistory();
          break;
        case 'loadChat':
          this.handleLoadChat(msg.chatId);
          break;
        case 'deleteChat':
          await this.handleDeleteChat(msg.chatId);
          break;
        case 'insertcode':
          this.handleInsertCode();
          break;
        case 'approveToolCall':
          this.resolveApproval(msg.toolCallId, true);
          break;
        case 'rejectToolCall':
          this.resolveApproval(msg.toolCallId, false);
          break;
      }
    });
  }

  private async refreshModels(): Promise<void> {
    const ep = this.endpointManager.getActiveSync();
    if (!ep) {
      this.postMessage({ type: 'models', models: [], endpoint: null });
      return;
    }
    try {
      const models = await this.client.listModels();
      const enriched = models.map((m) => {
        const e = enrichModelInfo(m);
        return { id: e.id, name: e.name ?? e.id };
      });
      this.postMessage({
        type: 'models',
        models: enriched,
        endpoint: { name: ep.name, baseUrl: ep.baseUrl },
      });
    } catch (err: any) {
      this.postMessage({
        type: 'modelsError',
        message: err.message ?? String(err),
        endpoint: { name: ep.name, baseUrl: ep.baseUrl },
      });
    }
  }

  private resolveApproval(toolCallId: string, approved: boolean): void {
    const pending = this.pendingApprovals.get(toolCallId);
    if (pending) {
      this.pendingApprovals.delete(toolCallId);
      pending.resolve(approved);
    }
  }

  private async handleChat(
    messages: ChatMessage[],
    model: string,
    mode: string
  ): Promise<void> {
    const ep = await this.endpointManager.getActive();
    if (!ep) {
      this.postMessage({ type: 'needsEndpoint' });
      return;
    }

    const config = vscode.workspace.getConfiguration('goatllm');
    const temperature = config.get<number>('temperature', 0.7);
    const maxTokens = config.get<number>('maxTokens', 4096);

    const systemPrompt = getSystemPrompt(mode);
    const workingMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const useTools = mode === 'agent' || mode === 'agent-full';

    try {
      for (let iteration = 0; iteration < MAX_AGENT_ITERATIONS; iteration++) {
        if (signal.aborted) break;

        const turn = await this.streamOneTurn(
          workingMessages,
          model,
          temperature,
          maxTokens,
          useTools ? AGENT_TOOLS : undefined,
          signal,
          /*isFollowUp*/ iteration > 0
        );

        // In native mode, attach structured tool_calls so the server can
        // correlate them with follow-up `tool` messages. In text mode, the
        // tool-call JSON is already inside `turn.text`, and the server has
        // no record of these calls — so we don't attach tool_calls and we
        // feed results back as user messages below.
        const assistantMsg: ChatMessage =
          turn.mode === 'native'
            ? {
                role: 'assistant',
                content: turn.text || null,
                ...(turn.toolCalls.length > 0 ? { tool_calls: turn.toolCalls } : {}),
              }
            : { role: 'assistant', content: turn.text || '' };
        workingMessages.push(assistantMsg);

        if (turn.toolCalls.length === 0) break;

        this.postMessage({
          type: 'toolCalls',
          mode,
          actions: turn.toolCalls.map((tc) => toUiAction(tc)),
        });

        for (const call of turn.toolCalls) {
          if (signal.aborted) break;

          const isReadOnly = READ_ONLY_TOOLS.has(call.function.name);
          const needsApproval = mode === 'agent' && !isReadOnly;

          let approved = true;
          if (needsApproval) {
            this.postMessage({
              type: 'toolCallStatus',
              toolCallId: call.id,
              status: 'awaiting-approval',
            });
            approved = await new Promise<boolean>((resolve) => {
              this.pendingApprovals.set(call.id, { resolve });
            });
          }

          if (!approved) {
            this.postMessage({
              type: 'toolCallResult',
              toolCallId: call.id,
              success: false,
              displayOutput: 'Skipped by user',
            });
            workingMessages.push(
              turn.mode === 'native'
                ? {
                    role: 'tool',
                    tool_call_id: call.id,
                    content: 'User skipped this tool call.',
                  }
                : {
                    role: 'user',
                    content: `Tool result for ${call.function.name}: User skipped this tool call.`,
                  }
            );
            continue;
          }

          this.postMessage({
            type: 'toolCallStatus',
            toolCallId: call.id,
            status: 'running',
          });

          let result: ToolExecutionResult;
          try {
            result = await executeToolCall(call);
          } catch (err: any) {
            result = {
              success: false,
              displayOutput: `Tool error: ${err.message ?? err}`,
              modelOutput: `Tool error: ${err.message ?? err}`,
            };
          }

          this.postMessage({
            type: 'toolCallResult',
            toolCallId: call.id,
            success: result.success,
            displayOutput: result.displayOutput,
          });

          workingMessages.push(
            turn.mode === 'native'
              ? {
                  role: 'tool',
                  tool_call_id: call.id,
                  content: result.modelOutput,
                }
              : {
                  role: 'user',
                  content: `Tool result for ${call.function.name}:\n${result.modelOutput}`,
                }
          );
        }
      }

      this.postMessage({ type: 'done' });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        this.postMessage({ type: 'done' });
        return;
      }
      this.postMessage({ type: 'error', content: err.message ?? String(err) });
    } finally {
      for (const [, p] of this.pendingApprovals) {
        p.resolve(false);
      }
      this.pendingApprovals.clear();
    }
  }

  private async streamOneTurn(
    messages: ChatMessage[],
    model: string,
    temperature: number,
    maxTokens: number,
    tools: typeof AGENT_TOOLS | undefined,
    signal: AbortSignal,
    isFollowUp: boolean
  ): Promise<{ text: string; toolCalls: ToolCall[]; mode: 'native' | 'text' }> {
    if (isFollowUp) {
      this.postMessage({ type: 'followUpStart' });
    }

    let text = '';
    let toolCalls: ToolCall[] = [];
    const textToolCalls: ToolCall[] = [];
    const extractor = tools ? new ToolCallExtractor() : null;

    // Per-turn controller chained to the outer signal so that fake-turn
    // truncation only cancels THIS request, not the whole chat session.
    const turnController = new AbortController();
    const onOuterAbort = () => turnController.abort();
    if (signal.aborted) {
      turnController.abort();
    } else {
      signal.addEventListener('abort', onOuterAbort, { once: true });
    }

    try {
      for await (const evt of this.client.streamChat(
        {
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: true,
          stop: DEFAULT_STOP_SEQUENCES,
          ...(tools ? { tools, tool_choice: 'auto' } : {}),
        },
        turnController.signal
      )) {
        if (evt.type === 'text') {
          // Client-side safety net: if the model starts a fake conversational
          // turn, truncate there and stop streaming further chunks to the UI.
          const candidate = text + evt.text;
          const truncated = truncateAtFakeTurn(candidate);
          if (truncated.length < candidate.length) {
            const emitRaw = truncated.slice(text.length);
            text = truncated;
            if (extractor) {
              const { visible, toolCalls: extracted } = extractor.push(emitRaw);
              if (visible.length > 0) {
                this.postMessage({ type: 'chunk', content: visible });
              }
              textToolCalls.push(...extracted);
            } else if (emitRaw.length > 0) {
              this.postMessage({ type: 'chunk', content: emitRaw });
            }
            turnController.abort();
            break;
          }
          text = candidate;
          if (extractor) {
            const { visible, toolCalls: extracted } = extractor.push(evt.text);
            if (visible.length > 0) {
              this.postMessage({ type: 'chunk', content: visible });
            }
            textToolCalls.push(...extracted);
          } else {
            this.postMessage({ type: 'chunk', content: evt.text });
          }
        } else if (evt.type === 'tool_calls') {
          toolCalls = evt.toolCalls;
        }
      }
      if (extractor) {
        const tail = extractor.flush();
        if (tail.length > 0) {
          this.postMessage({ type: 'chunk', content: tail });
        }
      }
    } catch (err: any) {
      // Swallow AbortError when WE triggered it via fake-turn detection
      // (outer signal still clean). Rethrow if user actually hit stop.
      if (err?.name === 'AbortError' && !signal.aborted) {
        // fake-turn truncation — treat as normal turn end
      } else {
        throw err;
      }
    } finally {
      signal.removeEventListener('abort', onOuterAbort);
    }

    if (this.client.lastUsage) {
      this.postMessage({
        type: 'usage',
        promptTokens: this.client.lastUsage.prompt_tokens,
        completionTokens: this.client.lastUsage.completion_tokens,
        totalTokens: this.client.lastUsage.total_tokens,
      });
    }

    // Prefer native OpenAI tool_calls; fall back to text-extracted calls
    // for models that don't support native function calling (e.g. Gemma).
    if (toolCalls.length > 0) {
      return { text, toolCalls, mode: 'native' };
    }
    return { text, toolCalls: textToolCalls, mode: 'text' };
  }

  private async sendSettingsToWebview(): Promise<void> {
    const config = vscode.workspace.getConfiguration('goatllm');
    const endpoints = this.endpointManager.list();
    const activeName = this.endpointManager.getActiveName();

    this.postMessage({
      type: 'settingsData',
      endpoints,
      activeEndpoint: activeName,
      defaultModel: config.get<string>('defaultModel', ''),
      temperature: config.get<number>('temperature', 0.7),
      maxTokens: config.get<number>('maxTokens', 4096),
      systemPrompts: {
        chat: config.get<string>('systemPrompt.chat', ''),
        agent: config.get<string>('systemPrompt.agent', ''),
        agentFull: config.get<string>('systemPrompt.agentFull', ''),
      },
      commandDenyList: config.get<string[]>('commandDenyList', []),
      allowSudo: config.get<boolean>('allowSudo', false),
    });
  }

  private async handleSaveSettings(msg: any): Promise<void> {
    const config = vscode.workspace.getConfiguration('goatllm');
    if (msg.defaultModel !== undefined) {
      await config.update('defaultModel', msg.defaultModel, vscode.ConfigurationTarget.Global);
    }
    if (msg.temperature !== undefined) {
      await config.update('temperature', msg.temperature, vscode.ConfigurationTarget.Global);
    }
    if (msg.maxTokens !== undefined) {
      await config.update('maxTokens', msg.maxTokens, vscode.ConfigurationTarget.Global);
    }
    if (msg.systemPrompts) {
      await config.update('systemPrompt.chat', msg.systemPrompts.chat || '', vscode.ConfigurationTarget.Global);
      await config.update('systemPrompt.agent', msg.systemPrompts.agent || '', vscode.ConfigurationTarget.Global);
      await config.update('systemPrompt.agentFull', msg.systemPrompts.agentFull || '', vscode.ConfigurationTarget.Global);
    }
    if (msg.commandDenyList !== undefined) {
      const list = (msg.commandDenyList as string)
        .split('\n')
        .map((s: string) => s.trim())
        .filter(Boolean);
      await config.update('commandDenyList', list, vscode.ConfigurationTarget.Global);
    }
    if (msg.allowSudo !== undefined) {
      await config.update('allowSudo', msg.allowSudo, vscode.ConfigurationTarget.Global);
    }
    vscode.window.showInformationMessage('GoatLLM settings saved.');
    this.postMessage({ type: 'settingsSaved' });
  }

  private static readonly HISTORY_KEY = 'goatllm.chatHistory';
  private static readonly MAX_HISTORY = 50;

  private async handleSaveChat(msg: any): Promise<void> {
    if (!msg.messages || msg.messages.length === 0) return;
    const history: any[] = this.globalState.get(GoatLlmChatViewProvider.HISTORY_KEY, []);

    const idx = history.findIndex((h: any) => h.id === msg.chatId);
    if (idx >= 0) history.splice(idx, 1);

    const firstUser = msg.messages.find((m: any) => m.role === 'user');
    const previewText = typeof firstUser?.content === 'string' ? firstUser.content : '';
    const preview = firstUser
      ? previewText.slice(0, 80) + (previewText.length > 80 ? '...' : '')
      : 'New chat';

    history.unshift({
      id: msg.chatId,
      messages: msg.messages,
      mode: msg.mode || 'chat',
      date: Date.now(),
      preview,
      messageCount: msg.messages.length,
    });

    if (history.length > GoatLlmChatViewProvider.MAX_HISTORY) {
      history.length = GoatLlmChatViewProvider.MAX_HISTORY;
    }

    await this.globalState.update(GoatLlmChatViewProvider.HISTORY_KEY, history);
  }

  private handleLoadHistory(): void {
    const history: any[] = this.globalState.get(GoatLlmChatViewProvider.HISTORY_KEY, []);
    const list = history.map((h: any) => ({
      id: h.id,
      preview: h.preview,
      date: h.date,
      messageCount: h.messageCount,
      mode: h.mode,
    }));
    this.postMessage({ type: 'historyData', history: list });
  }

  private handleLoadChat(chatId: string): void {
    const history: any[] = this.globalState.get(GoatLlmChatViewProvider.HISTORY_KEY, []);
    const chat = history.find((h: any) => h.id === chatId);
    if (chat) {
      this.postMessage({
        type: 'chatLoaded',
        chatId: chat.id,
        messages: chat.messages,
        mode: chat.mode,
      });
    }
  }

  private async handleDeleteChat(chatId: string): Promise<void> {
    const history: any[] = this.globalState.get(GoatLlmChatViewProvider.HISTORY_KEY, []);
    const filtered = history.filter((h: any) => h.id !== chatId);
    await this.globalState.update(GoatLlmChatViewProvider.HISTORY_KEY, filtered);
    this.handleLoadHistory();
  }

  private handleInsertCode(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No active editor.');
      return;
    }
    const selection = editor.document.getText(editor.selection);
    const fileName = vscode.workspace.asRelativePath(editor.document.uri);
    if (selection) {
      this.postMessage({
        type: 'inject',
        content: `From \`${fileName}\`:\n\`\`\`\n${selection}\n\`\`\`\n\n`,
      });
    } else {
      vscode.window.showWarningMessage('No text selected in editor.');
    }
  }

  public sendToChat(text: string): void {
    this.postMessage({ type: 'inject', content: text });
  }

  private postMessage(msg: any): void {
    this.view?.webview.postMessage(msg);
  }
}
