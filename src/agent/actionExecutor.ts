import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';

export interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  output: string; // combined summary for display
}

export interface FileWriteResult {
  success: boolean;
  output: string;
}

export interface FileReadResult {
  success: boolean;
  content: string;
  output: string;
}

export interface ListResult {
  success: boolean;
  entries: { name: string; type: 'file' | 'directory' }[];
  output: string;
}

// Default patterns that are always blocked (case-insensitive match against command)
const BUILTIN_DENY_PATTERNS = [
  'rm -rf /',
  'rm -rf ~',
  'rm -rf *',
  'mkfs',
  'dd if=',
  ':(){ :|:& };:', // fork bomb
  '> /dev/sda',
  'chmod -R 777 /',
  'chown -R',
  'format c:',
];

const COMMAND_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64_000;

function getDenyList(): string[] {
  const config = vscode.workspace.getConfiguration('goatllm');
  const userDeny = config.get<string[]>('commandDenyList', []);
  return [...BUILTIN_DENY_PATTERNS, ...userDeny];
}

function isCommandDenied(command: string): string | null {
  const lower = command.toLowerCase().trim();
  const denyList = getDenyList();
  for (const pattern of denyList) {
    if (pattern && lower.includes(pattern.toLowerCase())) {
      return pattern;
    }
  }
  const allowSudo = vscode.workspace.getConfiguration('goatllm').get<boolean>('allowSudo', false);
  if (!allowSudo && /\bsudo\b/.test(lower)) {
    return 'sudo (enable goatllm.allowSudo to allow)';
  }
  return null;
}

function validateFilePath(
  filePath: string,
  workspaceFolder: vscode.WorkspaceFolder
): { valid: true; uri: vscode.Uri } | { valid: false; reason: string } {
  if (path.isAbsolute(filePath)) {
    return { valid: false, reason: `Absolute paths are not allowed: ${filePath}` };
  }
  const normalized = path.normalize(filePath);
  if (normalized.startsWith('..') || normalized.includes(`${path.sep}..`)) {
    return { valid: false, reason: `Path traversal detected: ${filePath}` };
  }
  const fullUri = vscode.Uri.joinPath(workspaceFolder.uri, normalized);
  const workspaceRoot = workspaceFolder.uri.fsPath;
  if (!fullUri.fsPath.startsWith(workspaceRoot)) {
    return { valid: false, reason: `Path escapes workspace: ${filePath}` };
  }
  return { valid: true, uri: fullUri };
}

function getWorkspaceFolder(): vscode.WorkspaceFolder | null {
  return vscode.workspace.workspaceFolders?.[0] ?? null;
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT_BYTES) return s;
  return s.slice(0, MAX_OUTPUT_BYTES) + `\n…[truncated ${s.length - MAX_OUTPUT_BYTES} bytes]`;
}

export async function writeFile(filePath: string, content: string): Promise<FileWriteResult> {
  try {
    const wsFolder = getWorkspaceFolder();
    if (!wsFolder) return { success: false, output: 'No workspace folder open.' };

    const validation = validateFilePath(filePath, wsFolder);
    if (!validation.valid) return { success: false, output: `Blocked: ${validation.reason}` };

    const fullUri = validation.uri;
    const parentDir = vscode.Uri.joinPath(wsFolder.uri, path.dirname(path.normalize(filePath)));
    try {
      await vscode.workspace.fs.stat(parentDir);
    } catch {
      await vscode.workspace.fs.createDirectory(parentDir);
    }

    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(fullUri, encoder.encode(content));

    const doc = await vscode.workspace.openTextDocument(fullUri);
    await vscode.window.showTextDocument(doc, { preview: false });

    return { success: true, output: `Wrote ${filePath} (${content.length} bytes)` };
  } catch (err: any) {
    return { success: false, output: `Failed to write ${filePath}: ${err.message ?? err}` };
  }
}

export async function readFile(filePath: string): Promise<FileReadResult> {
  try {
    const wsFolder = getWorkspaceFolder();
    if (!wsFolder) return { success: false, content: '', output: 'No workspace folder open.' };

    const validation = validateFilePath(filePath, wsFolder);
    if (!validation.valid) {
      return { success: false, content: '', output: `Blocked: ${validation.reason}` };
    }

    const bytes = await vscode.workspace.fs.readFile(validation.uri);
    const content = new TextDecoder().decode(bytes);
    const truncated = truncate(content);
    return {
      success: true,
      content: truncated,
      output: `Read ${filePath} (${content.length} bytes)`,
    };
  } catch (err: any) {
    return {
      success: false,
      content: '',
      output: `Failed to read ${filePath}: ${err.message ?? err}`,
    };
  }
}

export async function listDirectory(relPath: string = '.'): Promise<ListResult> {
  try {
    const wsFolder = getWorkspaceFolder();
    if (!wsFolder) return { success: false, entries: [], output: 'No workspace folder open.' };

    const validation = validateFilePath(relPath === '' ? '.' : relPath, wsFolder);
    if (!validation.valid) {
      return { success: false, entries: [], output: `Blocked: ${validation.reason}` };
    }

    const items = await vscode.workspace.fs.readDirectory(validation.uri);
    const entries = items.map(([name, type]) => ({
      name,
      type: (type === vscode.FileType.Directory ? 'directory' : 'file') as 'file' | 'directory',
    }));
    return {
      success: true,
      entries,
      output: `Listed ${relPath} (${entries.length} entries)`,
    };
  } catch (err: any) {
    return {
      success: false,
      entries: [],
      output: `Failed to list ${relPath}: ${err.message ?? err}`,
    };
  }
}

export async function runCommand(command: string): Promise<CommandResult> {
  const denied = isCommandDenied(command);
  if (denied) {
    return {
      success: false,
      stdout: '',
      stderr: `Blocked by deny list: "${denied}"`,
      exitCode: null,
      output: `Blocked by deny list: "${denied}"`,
    };
  }

  const wsFolder = getWorkspaceFolder();
  const cwd = wsFolder?.uri.fsPath ?? process.cwd();
  const isWin = process.platform === 'win32';
  const shellPath = isWin ? (process.env.ComSpec || 'cmd.exe') : '/bin/bash';
  const shellArgs = isWin ? ['/d', '/s', '/c', command] : ['-c', command];

  return new Promise<CommandResult>((resolve) => {
    const child = spawn(shellPath, shellArgs, { cwd });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, COMMAND_TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.length > MAX_OUTPUT_BYTES * 2) {
        stdout = stdout.slice(0, MAX_OUTPUT_BYTES * 2);
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > MAX_OUTPUT_BYTES * 2) {
        stderr = stderr.slice(0, MAX_OUTPUT_BYTES * 2);
      }
    });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = truncate(stdout);
      const errOut = truncate(stderr);
      const success = !timedOut && exitCode === 0;
      const parts = [
        out && `--- stdout ---\n${out}`,
        errOut && `--- stderr ---\n${errOut}`,
        timedOut ? `--- killed: timeout after ${COMMAND_TIMEOUT_MS}ms ---` : `--- exit: ${exitCode} ---`,
      ].filter(Boolean);
      resolve({
        success,
        stdout: out,
        stderr: errOut,
        exitCode,
        output: parts.join('\n') || '(no output)',
      });
    };

    child.on('close', (code) => finish(code));
    child.on('error', (err) => {
      stderr += String(err.message ?? err);
      finish(null);
    });
  });
}
