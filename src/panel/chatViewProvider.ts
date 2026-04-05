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

const MAX_AGENT_ITERATIONS = 25;

const DEFAULT_SYSTEM_PROMPTS: Record<string, string> = {
  chat: `You are a helpful AI coding assistant running locally on the user's machine. You are helpful, concise, and accurate. When writing code, use markdown code blocks with the language specified. You are in Chat mode — answer questions and have conversations. Do not suggest file edits or terminal commands unless the user explicitly asks.`,

  agent: `You are an AI coding agent with native tool access, operating directly inside the user's VS Code workspace.

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
- Be decisive and autonomous. The user sees what you do in real time.`,

  'agent-full': `You are an AI coding agent with native tool access and full autonomy. All tool calls execute immediately without human approval.

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
- You are the developer. Own the outcome.`,
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

        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: turn.text || null,
          ...(turn.toolCalls.length > 0 ? { tool_calls: turn.toolCalls } : {}),
        };
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
            workingMessages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: 'User skipped this tool call.',
            });
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

          workingMessages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: result.modelOutput,
          });
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
  ): Promise<{ text: string; toolCalls: ToolCall[] }> {
    if (isFollowUp) {
      this.postMessage({ type: 'followUpStart' });
    }

    let text = '';
    let toolCalls: ToolCall[] = [];

    for await (const evt of this.client.streamChat(
      {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: true,
        ...(tools ? { tools, tool_choice: 'auto' } : {}),
      },
      signal
    )) {
      if (evt.type === 'text') {
        text += evt.text;
        this.postMessage({ type: 'chunk', content: evt.text });
      } else if (evt.type === 'tool_calls') {
        toolCalls = evt.toolCalls;
      }
    }

    if (this.client.lastUsage) {
      this.postMessage({
        type: 'usage',
        promptTokens: this.client.lastUsage.prompt_tokens,
        completionTokens: this.client.lastUsage.completion_tokens,
        totalTokens: this.client.lastUsage.total_tokens,
      });
    }

    return { text, toolCalls };
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
