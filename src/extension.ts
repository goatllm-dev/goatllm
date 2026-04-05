import * as vscode from 'vscode';
import { EndpointManager } from './endpoint/endpointManager';
import { OpenAiClient } from './api/openAiClient';
import { GoatLlmChatViewProvider } from './panel/chatViewProvider';
import { enrichModelInfo } from './api/models';

export function activate(context: vscode.ExtensionContext) {
  const endpointManager = new EndpointManager(context.secrets);
  const client = new OpenAiClient(() => endpointManager.getActiveSync());

  // Sidebar chat panel
  const chatProvider = new GoatLlmChatViewProvider(
    context.extensionUri,
    client,
    endpointManager,
    context.globalState
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      GoatLlmChatViewProvider.viewType,
      chatProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Status bar item showing active endpoint
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  const refreshStatus = () => {
    const ep = endpointManager.getActiveSync();
    statusBarItem.text = ep ? `$(rocket) GoatLLM: ${ep.name}` : '$(rocket) GoatLLM';
    statusBarItem.tooltip = ep
      ? `GoatLLM — ${ep.name}\n${ep.baseUrl}\nClick to switch endpoint`
      : 'Click to configure GoatLLM endpoint';
  };
  statusBarItem.command = 'goatllm.selectEndpoint';
  refreshStatus();
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('goatllm')) refreshStatus();
    })
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('goatllm.addEndpoint', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Endpoint name',
        placeHolder: 'e.g. MLX on Mac Studio',
        ignoreFocusOut: true,
      });
      if (!name) return;
      const baseUrl = await vscode.window.showInputBox({
        prompt: 'Base URL (OpenAI-compatible)',
        placeHolder: 'http://localhost:8013/v1',
        ignoreFocusOut: true,
        validateInput: (v) => (v && /^https?:\/\//.test(v) ? null : 'Must start with http:// or https://'),
      });
      if (!baseUrl) return;
      const apiKey = await vscode.window.showInputBox({
        prompt: 'API key (leave empty for local servers)',
        password: true,
        ignoreFocusOut: true,
      });
      await endpointManager.addEndpoint({ name, baseUrl }, apiKey || undefined);
      await endpointManager.setActiveName(name);
      vscode.window.showInformationMessage(`GoatLLM: added and activated "${name}".`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('goatllm.removeEndpoint', async () => {
      const endpoints = endpointManager.list();
      if (endpoints.length === 0) {
        vscode.window.showInformationMessage('No endpoints configured.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        endpoints.map((e) => ({ label: e.name, description: e.baseUrl })),
        { placeHolder: 'Remove which endpoint?' }
      );
      if (picked) {
        await endpointManager.removeEndpoint(picked.label);
        vscode.window.showInformationMessage(`Removed "${picked.label}".`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('goatllm.selectEndpoint', async () => {
      const endpoints = endpointManager.list();
      if (endpoints.length === 0) {
        const add = 'Add endpoint';
        const detect = 'Detect local servers';
        const choice = await vscode.window.showInformationMessage(
          'No endpoints configured.',
          add,
          detect
        );
        if (choice === add) {
          await vscode.commands.executeCommand('goatllm.addEndpoint');
        } else if (choice === detect) {
          await vscode.commands.executeCommand('goatllm.detectLocalServers');
        }
        return;
      }
      const active = endpointManager.getActiveName();
      const picked = await vscode.window.showQuickPick(
        endpoints.map((e) => ({
          label: e.name,
          description: e.baseUrl,
          detail: e.name === active ? '$(check) currently active' : undefined,
        })),
        { placeHolder: 'Select active endpoint' }
      );
      if (picked) {
        await endpointManager.setActiveName(picked.label);
        vscode.window.showInformationMessage(`GoatLLM: active endpoint set to "${picked.label}".`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('goatllm.detectLocalServers', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'GoatLLM: detecting local servers…' },
        async () => {
          const found = await endpointManager.detectLocalServers();
          if (found.length === 0) {
            vscode.window.showWarningMessage(
              'No local LLM servers detected on common ports (8013, 11434, 1234, 8080, 52415, 8000).'
            );
            return;
          }
          for (const ep of found) {
            await endpointManager.addEndpoint(ep);
          }
          vscode.window.showInformationMessage(
            `GoatLLM: detected ${found.length} local server${found.length > 1 ? 's' : ''}: ${found
              .map((e) => e.name)
              .join(', ')}.`
          );
        }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('goatllm.selectModel', async () => {
      try {
        const models = await client.listModels();
        if (models.length === 0) {
          vscode.window.showWarningMessage('No models returned from active endpoint.');
          return;
        }
        const items = models.map((m) => {
          const enriched = enrichModelInfo(m);
          return {
            label: enriched.name ?? enriched.id,
            description: enriched.id,
            detail: [
              enriched.contextLength ? `${(enriched.contextLength / 1000).toFixed(0)}K ctx` : null,
              enriched.ramGb ? `~${enriched.ramGb}GB RAM` : null,
              enriched.tags?.join(' · ') ?? null,
            ]
              .filter(Boolean)
              .join('  ·  '),
          };
        });
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select default model',
        });
        if (picked) {
          await vscode.workspace
            .getConfiguration('goatllm')
            .update('defaultModel', picked.description, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage(`Default model: ${picked.label}`);
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`GoatLLM: ${err.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('goatllm.explainSelection', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const selection = editor.document.getText(editor.selection);
      if (!selection) {
        vscode.window.showWarningMessage('No text selected.');
        return;
      }
      chatProvider.sendToChat(
        `Explain the following code:\n\n\`\`\`\n${selection}\n\`\`\``
      );
      vscode.commands.executeCommand('goatllm.chatView.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('goatllm.generateCode', async () => {
      const prompt = await vscode.window.showInputBox({
        prompt: 'What code should GoatLLM generate?',
        placeHolder: 'e.g. A function that sorts an array by date',
      });
      if (prompt) {
        chatProvider.sendToChat(prompt);
        vscode.commands.executeCommand('goatllm.chatView.focus');
      }
    })
  );
}

export function deactivate() {}
