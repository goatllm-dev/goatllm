import * as vscode from 'vscode';

export function buildChatHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  models: { id: string; name: string }[],
  defaultModel: string
): string {
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'chat', 'chat.css')
  );
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'chat', 'chat.js')
  );
  const logoUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'goatllm-logo-white.png')
  );
  const nonce = getNonce();

  const modelOptions = models
    .map(
      (m) =>
        `<option value="${m.id}"${m.id === defaultModel ? ' selected' : ''}>${m.name}</option>`
    )
    .join('\n');

  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
  <link rel="stylesheet" href="${styleUri}">
  <title>GoatLLM Chat</title>
</head>
<body>
  <div id="app">
    <div id="panel-header">
      <div style="display:flex;align-items:center;min-width:0;flex:1;">
        <span class="panel-header-title">GOATLLM</span>
        <button id="endpoint-chip" class="endpoint-chip disconnected" title="Click to switch endpoint">
          <span class="endpoint-chip-dot"></span>
          <span id="endpoint-chip-label">not connected</span>
        </button>
      </div>
      <div class="panel-header-actions">
        <button id="history-btn" class="panel-header-btn" title="Chat history">&#128344;</button>
        <button id="newchat-btn" class="panel-header-btn" title="New chat">&#9998;</button>
      </div>
    </div>
    <div id="messages"></div>
    <div id="input-area">
      <div id="input-container">
        <div id="toolbar">
          <button class="toolbar-btn" title="Attach file" data-action="attach">⊕</button>
          <div class="toolbar-separator"></div>
          <button class="toolbar-btn" title="Insert code from editor" data-action="insertcode">{ }</button>
        </div>
        <div id="attachment-preview"></div>
        <textarea id="input" rows="1" placeholder="Ask GoatLLM anything..."></textarea>
        <input type="file" id="file-input" accept="image/*,.txt,.ts,.js,.jsx,.tsx,.py,.json,.md,.html,.css,.csv,.yaml,.yml,.xml,.sh,.go,.rs,.java,.c,.cpp,.h,.rb,.php,.sql,.toml" multiple style="display:none">
        <div id="input-footer">
          <div id="footer-left">
            <button id="mode-btn" class="footer-btn" title="Switch mode">
              <span id="mode-icon">💬</span>
              <span id="mode-label">Chat</span>
            </button>
            <div class="toolbar-separator"></div>
            <select id="model-select">
              ${modelOptions}
            </select>
          </div>
          <div id="footer-right">
            <button class="settings-btn" title="Settings" data-action="settings">⚙</button>
            <button id="send-btn" title="Send">▶</button>
          </div>
        </div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">window.goatllmLogoUri = "${logoUri}";</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
