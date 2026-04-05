import { ToolDefinition, ToolCall } from '../api/types';
import {
  writeFile,
  readFile,
  listDirectory,
  runCommand,
} from './actionExecutor';

/**
 * Native tool definitions for the agent loop (OpenAI-compatible function calling).
 * These are sent with every agent-mode request as the `tools` array.
 */
export const AGENT_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read the full contents of a file in the workspace. Returns the file content as a string. Use this to understand existing code before editing.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Workspace-relative file path (e.g. "src/index.ts")',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description:
        'List files and subdirectories at a workspace-relative path. Use this to explore project structure.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Workspace-relative directory path. Defaults to workspace root.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create a new file or completely overwrite an existing file with the given content. Always provide the COMPLETE file content, not a partial snippet. Creates parent directories if needed.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Workspace-relative file path',
          },
          content: {
            type: 'string',
            description: 'Full file content to write',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Execute a shell command in the workspace root. Returns stdout, stderr, and exit code. Use for builds, tests, installs, git operations, greps, etc. The command runs through bash (or cmd on Windows) so pipes, redirects, and env vars work. Timeout: 120s. Dangerous commands are blocked by a deny list.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute',
          },
          explanation: {
            type: 'string',
            description: 'Brief explanation of what this command does and why you are running it',
          },
        },
        required: ['command'],
      },
    },
  },
];

export const READ_ONLY_TOOLS = new Set(['read_file', 'list_directory']);

export type UiActionDescriptor =
  | { type: 'fileEdit'; filePath: string; content: string; language: string; toolCallId: string; readOnly: false }
  | { type: 'bash'; command: string; explanation?: string; toolCallId: string; readOnly: false }
  | { type: 'read'; filePath: string; toolCallId: string; readOnly: true }
  | { type: 'list'; path: string; toolCallId: string; readOnly: true }
  | { type: 'unknown'; name: string; toolCallId: string; readOnly: false };

/**
 * Guess a code-fence language from a file extension for syntax highlighting in the webview.
 */
function inferLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php',
    sh: 'bash', zsh: 'bash', bash: 'bash', json: 'json', yaml: 'yaml',
    yml: 'yaml', toml: 'toml', md: 'markdown', html: 'html', css: 'css',
    scss: 'scss', sql: 'sql', swift: 'swift', kt: 'kotlin',
  };
  return map[ext] ?? 'text';
}

/**
 * Convert a raw ToolCall into the shape the webview expects for inline-action rendering.
 */
export function toUiAction(call: ToolCall): UiActionDescriptor {
  const { name, arguments: argsJson } = call.function;
  let args: any = {};
  try {
    args = JSON.parse(argsJson || '{}');
  } catch {
    args = {};
  }

  switch (name) {
    case 'write_file':
      return {
        type: 'fileEdit',
        filePath: String(args.path ?? ''),
        content: String(args.content ?? ''),
        language: inferLanguage(String(args.path ?? '')),
        toolCallId: call.id,
        readOnly: false,
      };
    case 'run_command':
      return {
        type: 'bash',
        command: String(args.command ?? ''),
        explanation: args.explanation ? String(args.explanation) : undefined,
        toolCallId: call.id,
        readOnly: false,
      };
    case 'read_file':
      return {
        type: 'read',
        filePath: String(args.path ?? ''),
        toolCallId: call.id,
        readOnly: true,
      };
    case 'list_directory':
      return {
        type: 'list',
        path: String(args.path ?? '.'),
        toolCallId: call.id,
        readOnly: true,
      };
    default:
      return { type: 'unknown', name, toolCallId: call.id, readOnly: false };
  }
}

export interface ToolExecutionResult {
  success: boolean;
  /** Display-friendly short summary (shown in the UI). */
  displayOutput: string;
  /** Full content fed back to the model as the tool message. */
  modelOutput: string;
}

/**
 * Execute a single tool call and return both display + model-facing output.
 */
export async function executeToolCall(call: ToolCall): Promise<ToolExecutionResult> {
  const { name, arguments: argsJson } = call.function;
  let args: any;
  try {
    args = JSON.parse(argsJson || '{}');
  } catch (err: any) {
    const msg = `Invalid JSON arguments for ${name}: ${err.message ?? err}`;
    return { success: false, displayOutput: msg, modelOutput: msg };
  }

  switch (name) {
    case 'read_file': {
      const res = await readFile(String(args.path ?? ''));
      return {
        success: res.success,
        displayOutput: res.output,
        modelOutput: res.success
          ? `File: ${args.path}\n\n${res.content}`
          : res.output,
      };
    }
    case 'list_directory': {
      const res = await listDirectory(String(args.path ?? '.'));
      const body = res.success
        ? res.entries
            .map((e) => (e.type === 'directory' ? `${e.name}/` : e.name))
            .join('\n')
        : res.output;
      return {
        success: res.success,
        displayOutput: res.output,
        modelOutput: res.success ? `Directory: ${args.path || '.'}\n\n${body}` : res.output,
      };
    }
    case 'write_file': {
      const res = await writeFile(String(args.path ?? ''), String(args.content ?? ''));
      return {
        success: res.success,
        displayOutput: res.output,
        modelOutput: res.output,
      };
    }
    case 'run_command': {
      const res = await runCommand(String(args.command ?? ''));
      const short = res.success
        ? `exit ${res.exitCode} (${res.stdout.length + res.stderr.length} bytes)`
        : `exit ${res.exitCode}${res.stderr ? ': ' + res.stderr.split('\n')[0].slice(0, 120) : ''}`;
      return {
        success: res.success,
        displayOutput: short,
        modelOutput: res.output,
      };
    }
    default:
      return {
        success: false,
        displayOutput: `Unknown tool: ${name}`,
        modelOutput: `Unknown tool: ${name}`,
      };
  }
}
