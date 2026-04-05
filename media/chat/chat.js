// @ts-check
// GoatLLM Chat Webview — Chat, Agent, Agent (full access) modes

(function () {
  // @ts-ignore
  var vscode = acquireVsCodeApi();

  var messagesEl = document.getElementById('messages');
  var inputEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
  var sendBtn = document.getElementById('send-btn');
  var modelSelect = /** @type {HTMLSelectElement} */ (document.getElementById('model-select'));
  var modeBtn = document.getElementById('mode-btn');
  var modeIcon = document.getElementById('mode-icon');
  var modeLabel = document.getElementById('mode-label');
  var endpointChip = document.getElementById('endpoint-chip');
  var endpointChipLabel = document.getElementById('endpoint-chip-label');

  if (endpointChip) {
    endpointChip.addEventListener('click', function () {
      vscode.postMessage({ type: 'selectEndpoint' });
    });
  }

  var MODES = [
    { id: 'chat',       label: 'Chat',                icon: '\uD83D\uDCAC', desc: 'Chat only \u2014 no tools or actions' },
    { id: 'agent',      label: 'Agent',               icon: '\uD83E\uDD16', desc: 'Edit files, run commands (asks for approval)' },
    { id: 'agent-full', label: 'Agent (full access)',  icon: '\u25B6\u25B6', desc: 'Full autopilot \u2014 auto-approves all actions' },
  ];

  /** @type {{ role: string; content: string }[]} */
  var chatHistory = [];
  var isStreaming = false;
  var currentMode = 'chat';
  var currentChatId = generateChatId();
  var pendingActionCount = 0;
  var actionResults = [];
  var lastAssistantResponse = '';
  var lastActionMode = '';

  var historyBtn = document.getElementById('history-btn');
  var newchatBtn = document.getElementById('newchat-btn');
  var fileInput = document.getElementById('file-input');
  var attachmentPreview = document.getElementById('attachment-preview');

  /** @type {{ type: string; name: string; dataUrl?: string; content?: string }[]} */
  var pendingAttachments = [];

  showEmptyState();

  function generateChatId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function saveCurrentChat() {
    if (chatHistory.length > 0) {
      vscode.postMessage({
        type: 'saveChat',
        chatId: currentChatId,
        messages: chatHistory,
        mode: currentMode,
      });
    }
  }

  function startNewChat() {
    saveCurrentChat();
    chatHistory = [];
    currentChatId = generateChatId();
    while (messagesEl.firstChild) { messagesEl.removeChild(messagesEl.firstChild); }
    showEmptyState();
    var indicator = document.getElementById('context-indicator');
    if (indicator) { indicator.remove(); }
    pendingAttachments = [];
    renderAttachmentPreview();
    inputEl.focus();
  }

  newchatBtn.addEventListener('click', startNewChat);

  historyBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'loadHistory' });
  });

  // Mode switcher — opens popup menu
  modeBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    var existing = document.querySelector('.mode-menu');
    if (existing) { existing.remove(); return; }
    showModeMenu();
  });

  // Close menu on click outside
  document.addEventListener('click', function () {
    var menu = document.querySelector('.mode-menu');
    if (menu) { menu.remove(); }
  });

  // Toolbar actions
  document.querySelectorAll('[data-action]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var action = btn.getAttribute('data-action');
      if (action === 'settings') {
        vscode.postMessage({ type: 'settings' });
      } else if (action === 'attach') {
        fileInput.click();
      } else if (action === 'insertcode') {
        vscode.postMessage({ type: 'insertcode' });
      }
    });
  });

  sendBtn.addEventListener('click', function () {
    if (isStreaming) {
      vscode.postMessage({ type: 'stop' });
      return;
    }
    sendMessage();
  });

  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  inputEl.addEventListener('input', function () {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + 'px';
  });

  // ─── File input handler ───
  fileInput.addEventListener('change', function () {
    var files = fileInput.files;
    if (!files) { return; }
    for (var fi = 0; fi < files.length; fi++) {
      handleAttachedFile(files[fi]);
    }
    fileInput.value = '';
  });

  // ─── Paste handler for images ───
  inputEl.addEventListener('paste', function (e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) { return; }
    for (var pi = 0; pi < items.length; pi++) {
      if (items[pi].type.indexOf('image/') === 0) {
        e.preventDefault();
        var file = items[pi].getAsFile();
        if (file) { handleAttachedFile(file); }
      }
    }
  });

  function handleAttachedFile(file) {
    var isImage = file.type.indexOf('image/') === 0;
    var reader = new FileReader();
    if (isImage) {
      reader.onload = function () {
        pendingAttachments.push({ type: 'image', name: file.name, dataUrl: reader.result });
        renderAttachmentPreview();
      };
      reader.readAsDataURL(file);
    } else {
      reader.onload = function () {
        pendingAttachments.push({ type: 'file', name: file.name, content: reader.result });
        renderAttachmentPreview();
      };
      reader.readAsText(file);
    }
  }

  function renderAttachmentPreview() {
    while (attachmentPreview.firstChild) { attachmentPreview.removeChild(attachmentPreview.firstChild); }
    if (pendingAttachments.length === 0) {
      attachmentPreview.style.display = 'none';
      return;
    }
    attachmentPreview.style.display = 'flex';
    pendingAttachments.forEach(function (att, idx) {
      var chip = document.createElement('div');
      chip.className = 'attachment-chip';
      if (att.type === 'image' && att.dataUrl) {
        var img = document.createElement('img');
        img.src = att.dataUrl;
        img.alt = att.name;
        chip.appendChild(img);
      }
      var nameSpan = document.createElement('span');
      nameSpan.className = 'attachment-name';
      nameSpan.textContent = att.name;
      chip.appendChild(nameSpan);
      var removeBtn = document.createElement('button');
      removeBtn.className = 'attachment-remove';
      removeBtn.textContent = '\u2715';
      removeBtn.dataset.index = String(idx);
      removeBtn.addEventListener('click', function () {
        pendingAttachments.splice(parseInt(this.dataset.index, 10), 1);
        renderAttachmentPreview();
      });
      chip.appendChild(removeBtn);
      attachmentPreview.appendChild(chip);
    });
  }

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (msg.type === 'chunk') {
      appendToAssistant(msg.content);
    } else if (msg.type === 'done') {
      finishStreaming();
    } else if (msg.type === 'error') {
      showError(msg.content);
      finishStreaming();
    } else if (msg.type === 'inject') {
      inputEl.value = msg.content;
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + 'px';
      inputEl.focus();
    } else if (msg.type === 'toolCalls') {
      renderToolCalls(msg.actions, msg.mode);
    } else if (msg.type === 'toolCallStatus') {
      updateToolCallStatus(msg.toolCallId, msg.status);
    } else if (msg.type === 'toolCallResult') {
      finalizeToolCall(msg.toolCallId, msg.success, msg.displayOutput);
    } else if (msg.type === 'settingsData') {
      showSettingsPanel(msg);
    } else if (msg.type === 'settingsSaved') {
      hideSettingsPanel();
    } else if (msg.type === 'historyData') {
      showHistoryPanel(msg.history);
    } else if (msg.type === 'chatLoaded') {
      loadChatSession(msg);
    } else if (msg.type === 'needsApiKey' || msg.type === 'needsEndpoint') {
      showApiKeyBanner();
    } else if (msg.type === 'apiKeySet') {
      removeApiKeyBanner();
    } else if (msg.type === 'followUpStart') {
      // Close out the previous streaming bubble (next agent iteration)
      var prev = messagesEl.querySelector('[data-streaming="true"]');
      if (prev) {
        prev.classList.remove('typing-indicator');
        delete prev.dataset.streaming;
        var prevText = getBubbleText(prev);
        if (prevText) {
          var prevHost = getStreamTextHost(prev);
          renderMarkdownSafe(prevHost, prevText);
          chatHistory.push({ role: 'assistant', content: prevText });
          lastAssistantResponse = prevText;
        } else if (!prev.querySelector('.inline-action')) {
          prev.remove();
        }
      }
      // Create fresh bubble for next iteration
      var bubble = addMessageBubble('assistant', '');
      bubble.classList.add('typing-indicator');
      bubble.dataset.streaming = 'true';
      isStreaming = true;
      sendBtn.textContent = '\u25A0';
      sendBtn.title = 'Stop';
    } else if (msg.type === 'usage') {
      updateContextIndicator(msg.promptTokens, msg.completionTokens, msg.totalTokens, msg.maxTokens);
    } else if (msg.type === 'models') {
      populateModelSelect(msg.models || []);
      updateEndpointChip(msg.endpoint, (msg.models || []).length > 0 ? 'connected' : 'disconnected');
    } else if (msg.type === 'modelsError') {
      populateModelSelect([]);
      updateEndpointChip(msg.endpoint, 'error');
      console.warn('GoatLLM: failed to load models from ' + (msg.endpoint && msg.endpoint.name) + ': ' + msg.message);
    }
  });

  function updateEndpointChip(endpoint, status) {
    if (!endpointChip || !endpointChipLabel) return;
    endpointChip.classList.remove('disconnected', 'error');
    if (status !== 'connected') endpointChip.classList.add(status);
    endpointChipLabel.textContent = endpoint ? endpoint.name : 'not connected';
    endpointChip.title = endpoint
      ? 'Connected to ' + endpoint.name + '\n' + endpoint.baseUrl + '\nClick to switch'
      : 'Click to configure endpoint';
  }

  function populateModelSelect(models) {
    if (!modelSelect) return;
    var previousValue = modelSelect.value;
    while (modelSelect.firstChild) {
      modelSelect.removeChild(modelSelect.firstChild);
    }
    if (models.length === 0) {
      var opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '(no models — connect an endpoint)';
      modelSelect.appendChild(opt);
      return;
    }
    models.forEach(function (m) {
      var opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name || m.id;
      modelSelect.appendChild(opt);
    });
    if (previousValue && models.some(function (m) { return m.id === previousValue; })) {
      modelSelect.value = previousValue;
    }
  }

  function showModeMenu() {
    var menu = document.createElement('div');
    menu.className = 'mode-menu';
    menu.addEventListener('click', function (e) { e.stopPropagation(); });

    var title = document.createElement('div');
    title.className = 'mode-menu-title';
    title.textContent = 'Switch mode';
    menu.appendChild(title);

    MODES.forEach(function (mode) {
      var item = document.createElement('button');
      item.className = 'mode-menu-item';
      if (mode.id === currentMode) { item.classList.add('active'); }

      var left = document.createElement('div');
      left.className = 'mode-menu-left';

      var icon = document.createElement('span');
      icon.className = 'mode-menu-icon';
      icon.textContent = mode.icon;

      var info = document.createElement('div');
      info.className = 'mode-menu-info';

      var name = document.createElement('span');
      name.className = 'mode-menu-name';
      name.textContent = mode.label;

      var desc = document.createElement('span');
      desc.className = 'mode-menu-desc';
      desc.textContent = mode.desc;

      info.appendChild(name);
      info.appendChild(desc);
      left.appendChild(icon);
      left.appendChild(info);
      item.appendChild(left);

      if (mode.id === currentMode) {
        var check = document.createElement('span');
        check.className = 'mode-menu-check';
        check.textContent = '\u2713';
        item.appendChild(check);
      }

      item.addEventListener('click', function () {
        currentMode = mode.id;
        modeIcon.textContent = mode.icon;
        modeLabel.textContent = mode.label;
        updatePlaceholder();
        menu.remove();
      });

      menu.appendChild(item);
    });

    // Position above the mode button
    var rect = modeBtn.getBoundingClientRect();
    menu.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
    menu.style.left = rect.left + 'px';
    document.body.appendChild(menu);
  }

  function updatePlaceholder() {
    if (currentMode === 'chat') {
      inputEl.placeholder = 'Ask GoatLLM anything...';
    } else if (currentMode === 'agent') {
      inputEl.placeholder = 'Describe a task for GoatLLM Agent...';
    } else {
      inputEl.placeholder = 'Describe a task (full autopilot)...';
    }
  }

  function sendMessage() {
    var text = inputEl.value.trim();
    if ((!text && pendingAttachments.length === 0) || isStreaming) { return; }

    clearEmptyState();
    removeApiKeyBanner();

    // Build content: plain string or content parts array
    var hasImages = pendingAttachments.some(function (a) { return a.type === 'image'; });
    var hasFiles = pendingAttachments.some(function (a) { return a.type === 'file'; });
    var content;
    var displayContent = text;

    if (hasImages || hasFiles) {
      var parts = [];
      // Add text files as text content
      pendingAttachments.forEach(function (att) {
        if (att.type === 'file' && att.content) {
          parts.push({ type: 'text', text: 'File: `' + att.name + '`\n```\n' + att.content + '\n```' });
        }
      });
      // Add user text
      if (text) {
        parts.push({ type: 'text', text: text });
      }
      // Add images
      pendingAttachments.forEach(function (att) {
        if (att.type === 'image' && att.dataUrl) {
          parts.push({ type: 'image_url', image_url: { url: att.dataUrl } });
        }
      });
      content = parts;
    } else {
      content = text;
    }

    // Render user bubble with attachments
    var userBubble = addMessageBubble('user', '');
    // Show attachment thumbnails in bubble
    pendingAttachments.forEach(function (att) {
      if (att.type === 'image' && att.dataUrl) {
        var img = document.createElement('img');
        img.src = att.dataUrl;
        img.className = 'bubble-attachment-img';
        userBubble.appendChild(img);
      } else if (att.type === 'file') {
        var fileTag = document.createElement('div');
        fileTag.className = 'bubble-attachment-file';
        fileTag.textContent = '\uD83D\uDCC4 ' + att.name;
        userBubble.appendChild(fileTag);
      }
    });
    if (text) {
      var textNode = document.createTextNode(text);
      userBubble.appendChild(textNode);
    }

    chatHistory.push({ role: 'user', content: content });

    // Clear input and attachments
    inputEl.value = '';
    inputEl.style.height = 'auto';
    pendingAttachments = [];
    renderAttachmentPreview();

    isStreaming = true;
    sendBtn.textContent = '\u25A0';
    sendBtn.title = 'Stop';

    var bubble = addMessageBubble('assistant', '');
    bubble.classList.add('typing-indicator');
    bubble.dataset.streaming = 'true';

    vscode.postMessage({
      type: 'chat',
      model: modelSelect.value,
      messages: chatHistory,
      mode: currentMode,
    });

    saveCurrentChat();
  }

  function getStreamTextHost(bubble) {
    var host = bubble.querySelector('.stream-text');
    if (!host) {
      host = document.createElement('div');
      host.className = 'stream-text';
      bubble.insertBefore(host, bubble.firstChild);
    }
    return host;
  }

  function getBubbleText(bubble) {
    if (!bubble) { return ''; }
    return bubble.dataset.streamText || '';
  }

  function appendToAssistant(chunk) {
    var bubble = messagesEl.querySelector('[data-streaming="true"]');
    if (bubble) {
      var prev = bubble.dataset.streamText || '';
      var next = prev + chunk;
      bubble.dataset.streamText = next;
      var host = getStreamTextHost(bubble);
      // Remove thinking-dots if still present (first chunk arrived)
      var dots = host.querySelector('.thinking-dots');
      if (dots) { dots.remove(); }
      host.textContent = next;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  function finishStreaming() {
    var bubble = messagesEl.querySelector('[data-streaming="true"]');
    if (bubble) {
      bubble.classList.remove('typing-indicator');
      delete bubble.dataset.streaming;
      var content = bubble.dataset.streamText || '';
      var host = getStreamTextHost(bubble);
      if (content) {
        renderMarkdownSafe(host, content);
        chatHistory.push({ role: 'assistant', content: content });
        lastAssistantResponse = content;
      } else if (!bubble.querySelector('.inline-action')) {
        // Empty bubble with no actions — remove it
        bubble.remove();
      }
    }
    isStreaming = false;
    sendBtn.textContent = '\u25B6';
    sendBtn.title = 'Send';
    inputEl.focus();
    saveCurrentChat();
  }

  function showError(text) {
    var div = document.createElement('div');
    div.className = 'message error';
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addMessageBubble(role, text) {
    var div = document.createElement('div');
    div.className = 'message ' + role;
    if (role === 'assistant') {
      var host = document.createElement('div');
      host.className = 'stream-text';
      div.appendChild(host);
      if (text) {
        div.dataset.streamText = text;
        renderMarkdownSafe(host, text);
      } else {
        // Insert thinking-dots indicator (removed on first streamed chunk)
        host.appendChild(buildThinkingDots());
      }
    } else if (text) {
      div.textContent = text;
    }
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function buildThinkingDots() {
    var wrap = document.createElement('span');
    wrap.className = 'thinking-dots';
    wrap.setAttribute('aria-label', 'Thinking');
    for (var d = 0; d < 3; d++) {
      var dot = document.createElement('span');
      dot.className = 'thinking-dot';
      wrap.appendChild(dot);
    }
    return wrap;
  }

  function renderMarkdownSafe(container, md) {
    while (container.firstChild) { container.removeChild(container.firstChild); }
    var blocks = parseBlocks(md);
    for (var bi = 0; bi < blocks.length; bi++) {
      renderBlock(container, blocks[bi]);
    }
  }

  // Block-level parser: splits markdown into typed blocks
  function parseBlocks(md) {
    var lines = md.split('\n');
    var blocks = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      // Fenced code block
      var fence = line.match(/^```(\w*)\s*$/);
      if (fence) {
        var codeLines = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          codeLines.push(lines[i]);
          i++;
        }
        i++;
        blocks.push({ type: 'code', lang: fence[1] || '', text: codeLines.join('\n') });
        continue;
      }

      if (/^\s*$/.test(line)) { i++; continue; }

      var heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
        i++;
        continue;
      }

      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        blocks.push({ type: 'hr' });
        i++;
        continue;
      }

      if (/^>\s?/.test(line)) {
        var quoteLines = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^>\s?/, ''));
          i++;
        }
        blocks.push({ type: 'blockquote', text: quoteLines.join('\n') });
        continue;
      }

      if (/^\s*[-*+]\s+/.test(line)) {
        var items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
          i++;
        }
        blocks.push({ type: 'ul', items: items });
        continue;
      }

      if (/^\s*\d+\.\s+/.test(line)) {
        var olItems = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          olItems.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
          i++;
        }
        blocks.push({ type: 'ol', items: olItems });
        continue;
      }

      var paraLines = [line];
      i++;
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^```/.test(lines[i]) &&
             !/^#{1,6}\s/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) &&
             !/^\s*\d+\.\s+/.test(lines[i]) && !/^>\s?/.test(lines[i]) &&
             !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) {
        paraLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'paragraph', text: paraLines.join('\n') });
    }

    return blocks;
  }

  function renderBlock(container, block) {
    if (block.type === 'code') {
      var pre = document.createElement('pre');
      var code = document.createElement('code');
      if (block.lang) { code.className = 'language-' + block.lang; }
      code.textContent = block.text;
      pre.appendChild(code);
      container.appendChild(pre);
    } else if (block.type === 'heading') {
      var h = document.createElement('h' + Math.min(block.level, 6));
      appendInlineContent(h, block.text);
      container.appendChild(h);
    } else if (block.type === 'hr') {
      container.appendChild(document.createElement('hr'));
    } else if (block.type === 'ul') {
      var ul = document.createElement('ul');
      for (var ui = 0; ui < block.items.length; ui++) {
        var li = document.createElement('li');
        appendInlineContent(li, block.items[ui]);
        ul.appendChild(li);
      }
      container.appendChild(ul);
    } else if (block.type === 'ol') {
      var ol = document.createElement('ol');
      for (var oi = 0; oi < block.items.length; oi++) {
        var oli = document.createElement('li');
        appendInlineContent(oli, block.items[oi]);
        ol.appendChild(oli);
      }
      container.appendChild(ol);
    } else if (block.type === 'blockquote') {
      var bq = document.createElement('blockquote');
      appendInlineContent(bq, block.text);
      container.appendChild(bq);
    } else if (block.type === 'paragraph') {
      var p = document.createElement('p');
      appendInlineContent(p, block.text);
      container.appendChild(p);
    }
  }

  // Inline parser: `code`, **bold**, *italic*, [text](url), autolinks
  function appendInlineContent(container, text) {
    var inlineRegex = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_|\[([^\]]+)\]\(([^)\s]+)\)|(\bhttps?:\/\/[^\s<>()]+)/g;
    var matches = text.matchAll(inlineRegex);
    var lastIdx = 0;
    for (var m of matches) {
      if (m.index > lastIdx) {
        container.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
      }
      if (m[1] !== undefined) {
        var codeEl = document.createElement('code');
        codeEl.textContent = m[1];
        container.appendChild(codeEl);
      } else if (m[2] !== undefined || m[3] !== undefined) {
        var strong = document.createElement('strong');
        strong.textContent = m[2] !== undefined ? m[2] : m[3];
        container.appendChild(strong);
      } else if (m[4] !== undefined || m[5] !== undefined) {
        var em = document.createElement('em');
        em.textContent = m[4] !== undefined ? m[4] : m[5];
        container.appendChild(em);
      } else if (m[6] !== undefined && m[7] !== undefined) {
        var a = document.createElement('a');
        a.textContent = m[6];
        a.href = m[7];
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        container.appendChild(a);
      } else if (m[8] !== undefined) {
        var autoA = document.createElement('a');
        autoA.textContent = m[8];
        autoA.href = m[8];
        autoA.target = '_blank';
        autoA.rel = 'noopener noreferrer';
        container.appendChild(autoA);
      }
      lastIdx = m.index + m[0].length;
    }
    if (lastIdx < text.length) {
      container.appendChild(document.createTextNode(text.slice(lastIdx)));
    }
  }

  function showEmptyState() {
    if (messagesEl.querySelector('.empty-state')) { return; }
    var div = document.createElement('div');
    div.className = 'empty-state';

    var logo = document.createElement('img');
    logo.src = window.goatllmLogoUri || '';
    logo.alt = 'GoatLLM';
    logo.className = 'empty-logo';

    var label = document.createElement('span');
    label.textContent = 'Local AI, your code';

    var tagline = document.createElement('div');
    tagline.className = 'empty-tagline';
    tagline.textContent = 'Chat with open-source LLMs running on your machine. Nothing leaves your device.';

    var actions = document.createElement('div');
    actions.className = 'empty-actions';

    var detectBtn = buildEmptyAction('\u26A1', 'Detect local servers', 'MLX, Ollama, LM Studio, exo…', function () {
      vscode.postMessage({ type: 'detectServers' });
    });
    var addBtn = buildEmptyAction('\u2795', 'Add endpoint', 'Manual URL + optional key', function () {
      vscode.postMessage({ type: 'addEndpoint' });
    });
    actions.appendChild(detectBtn);
    actions.appendChild(addBtn);

    div.appendChild(logo);
    div.appendChild(label);
    div.appendChild(tagline);
    div.appendChild(actions);
    messagesEl.appendChild(div);
  }

  function buildEmptyAction(icon, title, sub, onClick) {
    var btn = document.createElement('button');
    btn.className = 'empty-action';
    var iconEl = document.createElement('span');
    iconEl.className = 'empty-action-icon';
    iconEl.textContent = icon;
    var textWrap = document.createElement('span');
    textWrap.className = 'empty-action-text';
    var t = document.createElement('span');
    t.className = 'empty-action-title';
    t.textContent = title;
    var s = document.createElement('span');
    s.className = 'empty-action-sub';
    s.textContent = sub;
    textWrap.appendChild(t);
    textWrap.appendChild(s);
    btn.appendChild(iconEl);
    btn.appendChild(textWrap);
    btn.addEventListener('click', onClick);
    return btn;
  }

  function clearEmptyState() {
    var empty = messagesEl.querySelector('.empty-state');
    if (empty) { empty.remove(); }
  }

  function showApiKeyBanner() {
    if (document.querySelector('.setup-banner')) { return; }
    showEmptyState();
    var banner = document.createElement('div');
    banner.className = 'setup-banner';
    var p = document.createElement('p');
    p.textContent = 'Connect to a local LLM server to start.';
    var btn = document.createElement('button');
    btn.className = 'setup-btn';
    btn.textContent = 'Detect local servers';
    btn.addEventListener('click', function () {
      vscode.postMessage({ type: 'detectServers' });
    });
    banner.appendChild(p);
    banner.appendChild(btn);
    messagesEl.appendChild(banner);
  }

  function removeApiKeyBanner() {
    var banner = document.querySelector('.setup-banner');
    if (banner) { banner.remove(); }
  }

  function renderToolCalls(actions, mode) {
    lastActionMode = mode;

    // Find the last assistant bubble to append inline action blocks
    var bubbles = messagesEl.querySelectorAll('.message.assistant');
    var lastBubble = bubbles[bubbles.length - 1];
    if (!lastBubble) {
      lastBubble = addMessageBubble('assistant', '');
    }
    // If thinking-dots are still showing (no text arrived), remove them
    var pendingDots = lastBubble.querySelector('.thinking-dots');
    if (pendingDots) { pendingDots.remove(); }

    // Approvable actions are the write/run ones (not read-only)
    var approvableActions = actions.filter(function (a) { return !a.readOnly; });

    if (mode === 'agent' && approvableActions.length > 1) {
      var approveAllBar = document.createElement('div');
      approveAllBar.className = 'inline-actions-bar';
      var approveAllBtn = document.createElement('button');
      approveAllBtn.className = 'action-btn approve';
      approveAllBtn.textContent = 'Approve All (' + approvableActions.length + ')';
      approveAllBtn.addEventListener('click', function () {
        for (var ai = 0; ai < approvableActions.length; ai++) {
          var tcid = approvableActions[ai].toolCallId;
          var blk = lastBubble.querySelector('[data-tool-call-id="' + tcid + '"]');
          if (blk && !blk.classList.contains('action-done')) {
            vscode.postMessage({ type: 'approveToolCall', toolCallId: tcid });
            blk.classList.add('action-running');
            var s = blk.querySelector('.inline-action-status');
            if (s) { s.textContent = 'Running...'; s.className = 'inline-action-status running'; }
            var b = blk.querySelector('.inline-action-buttons');
            if (b) { b.style.display = 'none'; }
          }
        }
        approveAllBar.remove();
      });
      approveAllBar.appendChild(approveAllBtn);
      lastBubble.appendChild(approveAllBar);
    }

    for (var i = 0; i < actions.length; i++) {
      var action = actions[i];
      var block = document.createElement('div');
      block.className = 'inline-action';
      block.dataset.toolCallId = action.toolCallId;

      // Header
      var header = document.createElement('div');
      header.className = 'inline-action-header';

      var iconSpan = document.createElement('span');
      iconSpan.className = 'inline-action-icon';

      var labelSpan = document.createElement('span');
      labelSpan.className = 'inline-action-label';

      var bodyText = '';
      if (action.type === 'fileEdit') {
        iconSpan.textContent = '\uD83D\uDCC1';
        labelSpan.textContent = 'Write: ' + action.filePath;
        bodyText = action.content;
      } else if (action.type === 'bash') {
        iconSpan.textContent = '\u25B6';
        labelSpan.textContent = 'Run: ' + action.command;
        bodyText = action.command + (action.explanation ? '\n\n# ' + action.explanation : '');
      } else if (action.type === 'read') {
        iconSpan.textContent = '\uD83D\uDCD6';
        labelSpan.textContent = 'Read: ' + action.filePath;
        bodyText = action.filePath;
      } else if (action.type === 'list') {
        iconSpan.textContent = '\uD83D\uDCC2';
        labelSpan.textContent = 'List: ' + (action.path || '.');
        bodyText = action.path || '.';
      } else {
        iconSpan.textContent = '\u2699';
        labelSpan.textContent = 'Tool: ' + (action.name || 'unknown');
      }

      var headerLeft = document.createElement('div');
      headerLeft.className = 'inline-action-header-left';
      headerLeft.appendChild(iconSpan);
      headerLeft.appendChild(labelSpan);

      var statusSpan = document.createElement('span');
      statusSpan.className = 'inline-action-status';
      headerLeft.appendChild(statusSpan);

      header.appendChild(headerLeft);

      // Approval buttons only for write/run in agent mode
      if (mode === 'agent' && !action.readOnly) {
        var btns = document.createElement('div');
        btns.className = 'inline-action-buttons';

        var approveBtn = document.createElement('button');
        approveBtn.className = 'action-btn approve action-btn-sm';
        approveBtn.textContent = action.type === 'fileEdit' ? 'Apply' : 'Run';
        approveBtn.dataset.toolCallId = action.toolCallId;
        approveBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          var tcid = this.dataset.toolCallId;
          vscode.postMessage({ type: 'approveToolCall', toolCallId: tcid });
          var parent = lastBubble.querySelector('[data-tool-call-id="' + tcid + '"]');
          if (parent) {
            parent.classList.add('action-running');
            var s = parent.querySelector('.inline-action-status');
            if (s) { s.textContent = 'Running...'; s.className = 'inline-action-status running'; }
            var b = parent.querySelector('.inline-action-buttons');
            if (b) { b.style.display = 'none'; }
          }
        });

        var rejectBtn = document.createElement('button');
        rejectBtn.className = 'action-btn reject action-btn-sm';
        rejectBtn.textContent = 'Skip';
        rejectBtn.dataset.toolCallId = action.toolCallId;
        rejectBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          var tcid = this.dataset.toolCallId;
          vscode.postMessage({ type: 'rejectToolCall', toolCallId: tcid });
          var parent = lastBubble.querySelector('[data-tool-call-id="' + tcid + '"]');
          if (parent) {
            parent.classList.add('action-done');
            var s = parent.querySelector('.inline-action-status');
            if (s) { s.textContent = 'Skipped'; s.className = 'inline-action-status skipped'; }
            var b = parent.querySelector('.inline-action-buttons');
            if (b) { b.style.display = 'none'; }
          }
        });

        btns.appendChild(approveBtn);
        btns.appendChild(rejectBtn);
        header.appendChild(btns);
      } else {
        // agent-full mode, or read-only action: auto-running
        statusSpan.textContent = 'Running...';
        statusSpan.className = 'inline-action-status running';
      }

      block.appendChild(header);

      // Collapsible body
      var body = document.createElement('div');
      body.className = 'inline-action-body';

      if (bodyText) {
        var pre = document.createElement('pre');
        var code = document.createElement('code');
        code.textContent = bodyText;
        pre.appendChild(code);
        body.appendChild(pre);
      }
      block.appendChild(body);

      // Toggle collapse on header click
      (function (bodyEl) {
        header.style.cursor = 'pointer';
        header.addEventListener('click', function () {
          bodyEl.classList.toggle('expanded');
        });
      })(body);

      lastBubble.appendChild(block);
    }

    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function updateToolCallStatus(toolCallId, status) {
    var block = messagesEl.querySelector('.inline-action[data-tool-call-id="' + toolCallId + '"]');
    if (!block) { return; }
    var statusEl = block.querySelector('.inline-action-status');
    if (status === 'running') {
      block.classList.add('action-running');
      if (statusEl) {
        statusEl.textContent = 'Running...';
        statusEl.className = 'inline-action-status running';
      }
      var btns = block.querySelector('.inline-action-buttons');
      if (btns) { btns.style.display = 'none'; }
    } else if (status === 'awaiting-approval') {
      if (statusEl) {
        statusEl.textContent = 'Awaiting approval';
        statusEl.className = 'inline-action-status';
      }
    }
  }

  function finalizeToolCall(toolCallId, success, displayOutput) {
    var block = messagesEl.querySelector('.inline-action[data-tool-call-id="' + toolCallId + '"]');
    if (!block) { return; }

    block.classList.remove('action-running');
    block.classList.add(success ? 'action-success' : 'action-error');
    block.classList.add('action-done');

    var status = block.querySelector('.inline-action-status');
    if (status) {
      status.textContent = success
        ? '\u2713 ' + (displayOutput || 'Done')
        : '\u2717 ' + (displayOutput || 'Failed');
      status.className = 'inline-action-status ' + (success ? 'success' : 'error');
    }

    var btns = block.querySelector('.inline-action-buttons');
    if (btns) { btns.style.display = 'none'; }

    if (displayOutput && !success) {
      var body = block.querySelector('.inline-action-body');
      if (body) {
        var outputEl = document.createElement('div');
        outputEl.className = 'inline-action-output';
        outputEl.textContent = displayOutput;
        body.appendChild(outputEl);
        body.classList.add('expanded');
      }
    }

    // If all tool calls in the current bubble are done, remove the approve-all bar
    var remaining = messagesEl.querySelectorAll('.inline-action:not(.action-done)');
    if (remaining.length === 0) {
      var bar = messagesEl.querySelector('.inline-actions-bar');
      if (bar) { bar.remove(); }
    }
  }

  // ─── Settings Panel ───

  var settingsVisible = false;

  function showSettingsPanel(data) {
    settingsVisible = true;
    var existing = document.getElementById('settings-panel');
    if (existing) { existing.remove(); }

    var panel = document.createElement('div');
    panel.id = 'settings-panel';

    // Header
    var header = document.createElement('div');
    header.className = 'settings-header';
    var headerTitle = document.createElement('span');
    headerTitle.className = 'settings-title';
    headerTitle.textContent = 'Settings';
    var closeBtn = document.createElement('button');
    closeBtn.className = 'settings-close';
    closeBtn.textContent = '\u2715';
    closeBtn.addEventListener('click', hideSettingsPanel);
    header.appendChild(headerTitle);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    var body = document.createElement('div');
    body.className = 'settings-body';

    // ─ xAI Console link ─
    var consoleSection = document.createElement('div');
    consoleSection.className = 'settings-section';
    var consoleLink = document.createElement('button');
    consoleLink.className = 'settings-console-link';
    consoleLink.textContent = 'Open xAI Console \u2197';
    consoleLink.addEventListener('click', function () {
      vscode.postMessage({ type: 'openConsole' });
    });
    consoleSection.appendChild(consoleLink);
    body.appendChild(consoleSection);

    // ─ API Key ─
    var keySection = document.createElement('div');
    keySection.className = 'settings-section';
    var keyLabel = document.createElement('label');
    keyLabel.className = 'settings-label';
    keyLabel.textContent = 'API Key';
    keySection.appendChild(keyLabel);

    var keyRow = document.createElement('div');
    keyRow.className = 'settings-key-row';
    var keyDisplay = document.createElement('span');
    keyDisplay.className = 'settings-key-display';
    keyDisplay.textContent = data.apiKeySet ? data.apiKeyDisplay : 'Not set';
    keyRow.appendChild(keyDisplay);

    var setKeyBtn = document.createElement('button');
    setKeyBtn.className = 'action-btn approve';
    setKeyBtn.textContent = data.apiKeySet ? 'Change' : 'Set Key';
    setKeyBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'setApiKey' });
    });
    keyRow.appendChild(setKeyBtn);

    if (data.apiKeySet) {
      var clearKeyBtn = document.createElement('button');
      clearKeyBtn.className = 'action-btn reject';
      clearKeyBtn.textContent = 'Clear';
      clearKeyBtn.addEventListener('click', function () {
        vscode.postMessage({ type: 'clearApiKey' });
      });
      keyRow.appendChild(clearKeyBtn);
    }
    keySection.appendChild(keyRow);
    body.appendChild(keySection);

    // ─ Default Model ─
    var modelSection = document.createElement('div');
    modelSection.className = 'settings-section';
    var modelLabel = document.createElement('label');
    modelLabel.className = 'settings-label';
    modelLabel.textContent = 'Default Model';
    modelSection.appendChild(modelLabel);
    var modelSel = document.createElement('select');
    modelSel.id = 'settings-model';
    modelSel.className = 'settings-select';
    var modelOpts = modelSelect.options;
    for (var mi = 0; mi < modelOpts.length; mi++) {
      var opt = document.createElement('option');
      opt.value = modelOpts[mi].value;
      opt.textContent = modelOpts[mi].textContent;
      if (modelOpts[mi].value === data.defaultModel) { opt.selected = true; }
      modelSel.appendChild(opt);
    }
    modelSection.appendChild(modelSel);
    body.appendChild(modelSection);

    // ─ Temperature ─
    var tempSection = document.createElement('div');
    tempSection.className = 'settings-section';
    var tempLabel = document.createElement('label');
    tempLabel.className = 'settings-label';
    tempLabel.textContent = 'Temperature';
    tempSection.appendChild(tempLabel);
    var tempRow = document.createElement('div');
    tempRow.className = 'settings-temp-row';
    var tempRange = document.createElement('input');
    tempRange.type = 'range';
    tempRange.id = 'settings-temp';
    tempRange.className = 'settings-range';
    tempRange.min = '0';
    tempRange.max = '2';
    tempRange.step = '0.1';
    tempRange.value = String(data.temperature);
    var tempVal = document.createElement('span');
    tempVal.className = 'settings-temp-val';
    tempVal.textContent = String(data.temperature);
    tempRange.addEventListener('input', function () {
      tempVal.textContent = tempRange.value;
    });
    tempRow.appendChild(tempRange);
    tempRow.appendChild(tempVal);
    tempSection.appendChild(tempRow);
    body.appendChild(tempSection);

    // ─ System Prompts ─
    var promptModes = [
      { key: 'chat', label: 'Chat System Prompt' },
      { key: 'agent', label: 'Agent System Prompt' },
      { key: 'agentFull', label: 'Agent (Full Access) System Prompt' },
    ];
    promptModes.forEach(function (pm) {
      var section = document.createElement('div');
      section.className = 'settings-section';
      var label = document.createElement('label');
      label.className = 'settings-label';
      label.textContent = pm.label;
      section.appendChild(label);
      var hint = document.createElement('span');
      hint.className = 'settings-hint';
      hint.textContent = 'Leave empty for default';
      section.appendChild(hint);
      var ta = document.createElement('textarea');
      ta.className = 'settings-textarea';
      ta.id = 'settings-prompt-' + pm.key;
      ta.rows = 3;
      ta.placeholder = 'Custom system prompt...';
      ta.value = (data.systemPrompts && data.systemPrompts[pm.key]) || '';
      section.appendChild(ta);
      body.appendChild(section);
    });

    // ─ Command Deny List ─
    var denySection = document.createElement('div');
    denySection.className = 'settings-section';
    var denyLabel = document.createElement('label');
    denyLabel.className = 'settings-label';
    denyLabel.textContent = 'Command Deny List';
    denySection.appendChild(denyLabel);
    var denyHint = document.createElement('span');
    denyHint.className = 'settings-hint';
    denyHint.textContent = 'One pattern per line. Commands containing these strings are blocked.';
    denySection.appendChild(denyHint);
    var denyTa = document.createElement('textarea');
    denyTa.className = 'settings-textarea';
    denyTa.id = 'settings-deny-list';
    denyTa.rows = 3;
    denyTa.placeholder = 'e.g.\nrm -rf\nnpm publish\ndocker push';
    denyTa.value = (data.commandDenyList || []).join('\n');
    denySection.appendChild(denyTa);

    // Built-in list info
    var builtinHint = document.createElement('span');
    builtinHint.className = 'settings-hint';
    builtinHint.textContent = 'Built-in: rm -rf /, sudo, mkfs, dd if=, fork bombs are always blocked.';
    denySection.appendChild(builtinHint);
    body.appendChild(denySection);

    // ─ Allow Sudo toggle ─
    var sudoSection = document.createElement('div');
    sudoSection.className = 'settings-section';
    var sudoRow = document.createElement('label');
    sudoRow.className = 'settings-checkbox-row';
    var sudoCb = document.createElement('input');
    sudoCb.type = 'checkbox';
    sudoCb.id = 'settings-allow-sudo';
    sudoCb.checked = !!data.allowSudo;
    var sudoText = document.createElement('span');
    sudoText.textContent = 'Allow sudo commands (not recommended)';
    sudoRow.appendChild(sudoCb);
    sudoRow.appendChild(sudoText);
    sudoSection.appendChild(sudoRow);
    body.appendChild(sudoSection);

    panel.appendChild(body);

    // ─ Save button ─
    var footer = document.createElement('div');
    footer.className = 'settings-footer';
    var saveBtn = document.createElement('button');
    saveBtn.className = 'action-btn approve settings-save';
    saveBtn.textContent = 'Save Settings';
    saveBtn.addEventListener('click', function () {
      var selModel = document.getElementById('settings-model');
      var selTemp = document.getElementById('settings-temp');
      vscode.postMessage({
        type: 'saveSettings',
        defaultModel: selModel.value,
        temperature: parseFloat(selTemp.value),
        systemPrompts: {
          chat: document.getElementById('settings-prompt-chat').value,
          agent: document.getElementById('settings-prompt-agent').value,
          agentFull: document.getElementById('settings-prompt-agentFull').value,
        },
        commandDenyList: document.getElementById('settings-deny-list').value,
        allowSudo: document.getElementById('settings-allow-sudo').checked,
      });
      // Also sync model select in footer
      modelSelect.value = selModel.value;
    });
    footer.appendChild(saveBtn);
    panel.appendChild(footer);

    // Insert into DOM — overlay on top of messages
    var app = document.getElementById('app');
    app.insertBefore(panel, messagesEl);
    messagesEl.style.display = 'none';
  }

  function hideSettingsPanel() {
    settingsVisible = false;
    var panel = document.getElementById('settings-panel');
    if (panel) { panel.remove(); }
    messagesEl.style.display = '';
  }

  // ─── History Panel ───

  function showHistoryPanel(history) {
    var existing = document.getElementById('history-panel');
    if (existing) { existing.remove(); }

    var panel = document.createElement('div');
    panel.id = 'history-panel';

    var header = document.createElement('div');
    header.className = 'settings-header';
    var title = document.createElement('span');
    title.className = 'settings-title';
    title.textContent = 'Chat History';
    var closeBtn = document.createElement('button');
    closeBtn.className = 'settings-close';
    closeBtn.textContent = '\u2715';
    closeBtn.addEventListener('click', function () {
      panel.remove();
      messagesEl.style.display = '';
    });
    header.appendChild(title);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    var body = document.createElement('div');
    body.className = 'settings-body';

    if (!history || history.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = 'No previous chats';
      body.appendChild(empty);
    } else {
      history.forEach(function (item) {
        var row = document.createElement('div');
        row.className = 'history-item';

        var info = document.createElement('div');
        info.className = 'history-item-info';
        info.addEventListener('click', function () {
          vscode.postMessage({ type: 'loadChat', chatId: item.id });
        });

        var preview = document.createElement('div');
        preview.className = 'history-item-preview';
        preview.textContent = item.preview || 'Empty chat';
        info.appendChild(preview);

        var meta = document.createElement('div');
        meta.className = 'history-item-meta';
        var date = new Date(item.date);
        meta.textContent = date.toLocaleDateString() + ' · ' + item.messageCount + ' msgs';
        if (item.mode && item.mode !== 'chat') {
          meta.textContent += ' · ' + item.mode;
        }
        info.appendChild(meta);

        row.appendChild(info);

        var delBtn = document.createElement('button');
        delBtn.className = 'history-delete';
        delBtn.title = 'Delete';
        delBtn.textContent = '\u2715';
        delBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          vscode.postMessage({ type: 'deleteChat', chatId: item.id });
        });
        row.appendChild(delBtn);

        body.appendChild(row);
      });
    }

    panel.appendChild(body);

    var app = document.getElementById('app');
    app.insertBefore(panel, messagesEl);
    messagesEl.style.display = 'none';
  }

  function loadChatSession(data) {
    // Close history panel if open
    var histPanel = document.getElementById('history-panel');
    if (histPanel) { histPanel.remove(); }
    messagesEl.style.display = '';

    // Clear current messages
    while (messagesEl.firstChild) { messagesEl.removeChild(messagesEl.firstChild); }

    // Restore state
    chatHistory = data.messages || [];
    currentChatId = data.chatId;
    if (data.mode) {
      currentMode = data.mode;
      var modeData = MODES.find(function (m) { return m.id === data.mode; });
      if (modeData) {
        modeIcon.textContent = modeData.icon;
        modeLabel.textContent = modeData.label;
      }
      updatePlaceholder();
    }

    // Re-render all messages
    chatHistory.forEach(function (msg) {
      addMessageBubble(msg.role, msg.content);
    });

    inputEl.focus();
  }

  function updateContextIndicator(promptTokens, completionTokens, totalTokens, maxTokens) {
    var indicator = document.getElementById('context-indicator');
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'context-indicator';
      // Place it in footer-right, before the settings button
      var footerRight = document.getElementById('footer-right');
      if (footerRight) {
        footerRight.insertBefore(indicator, footerRight.firstChild);
      }
    }
    var used = promptTokens + completionTokens;
    var pct = Math.min(100, Math.round((used / maxTokens) * 100));

    var color = pct < 50 ? '#4caf50' : pct < 80 ? '#ff9800' : '#f44336';

    indicator.title = pct + '% used\n' +
      promptTokens.toLocaleString() + ' prompt + ' +
      completionTokens.toLocaleString() + ' completion\n' +
      used.toLocaleString() + ' / ' + maxTokens.toLocaleString() + ' tokens';

    // SVG pie chart
    // The pie uses a conic-gradient approach via two arc paths
    var size = 16;
    var r = 6;
    var cx = size / 2;
    var cy = size / 2;
    var angle = (pct / 100) * 360;
    var rad = (angle - 90) * (Math.PI / 180);
    var largeArc = angle > 180 ? 1 : 0;
    var x = cx + r * Math.cos(rad);
    var y = cy + r * Math.sin(rad);

    var pathD = 'M ' + cx + ' ' + (cy - r) +
      ' A ' + r + ' ' + r + ' 0 ' + largeArc + ' 1 ' + x.toFixed(2) + ' ' + y.toFixed(2) +
      ' L ' + cx + ' ' + cy + ' Z';

    indicator.innerHTML = '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="1.5"/>' +
      '<path d="' + pathD + '" fill="' + color + '"/>' +
      '</svg>' +
      '<span class="context-label">' + pct + '%</span>';
  }

})();
