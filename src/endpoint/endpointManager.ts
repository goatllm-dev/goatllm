import * as vscode from 'vscode';
import { Endpoint } from '../api/types';

const SECRET_PREFIX = 'goatllm.apiKey.';

/**
 * Manages OpenAI-compatible endpoints (local or remote).
 * Endpoint list lives in VS Code workspace configuration.
 * API keys (when needed) live in SecretStorage keyed by endpoint name.
 */
export class EndpointManager {
  constructor(private secrets: vscode.SecretStorage) {}

  /** Read all configured endpoints */
  list(): Endpoint[] {
    const config = vscode.workspace.getConfiguration('goatllm');
    return config.get<Endpoint[]>('endpoints', []);
  }

  /** Name of the currently-active endpoint */
  getActiveName(): string {
    return vscode.workspace
      .getConfiguration('goatllm')
      .get<string>('activeEndpoint', '');
  }

  /** Resolve the active endpoint, merging API key from SecretStorage */
  async getActive(): Promise<Endpoint | undefined> {
    const name = this.getActiveName();
    const endpoints = this.list();
    const ep = endpoints.find((e) => e.name === name) ?? endpoints[0];
    if (!ep) return undefined;
    const apiKey = (await this.secrets.get(SECRET_PREFIX + ep.name)) || ep.apiKey || '';
    return { ...ep, apiKey };
  }

  /** Synchronous snapshot — uses last-known API key from settings only (not SecretStorage) */
  getActiveSync(): Endpoint | undefined {
    const name = this.getActiveName();
    const endpoints = this.list();
    return endpoints.find((e) => e.name === name) ?? endpoints[0];
  }

  async setActiveName(name: string): Promise<void> {
    await vscode.workspace
      .getConfiguration('goatllm')
      .update('activeEndpoint', name, vscode.ConfigurationTarget.Global);
  }

  async addEndpoint(ep: Endpoint, apiKey?: string): Promise<void> {
    const endpoints = this.list();
    const existing = endpoints.findIndex((e) => e.name === ep.name);
    // Don't persist the api key in settings — use SecretStorage
    const toStore = { name: ep.name, baseUrl: ep.baseUrl, apiKey: '' };
    if (existing >= 0) {
      endpoints[existing] = toStore;
    } else {
      endpoints.push(toStore);
    }
    await vscode.workspace
      .getConfiguration('goatllm')
      .update('endpoints', endpoints, vscode.ConfigurationTarget.Global);
    if (apiKey && apiKey.trim()) {
      await this.secrets.store(SECRET_PREFIX + ep.name, apiKey);
    }
  }

  async removeEndpoint(name: string): Promise<void> {
    const endpoints = this.list().filter((e) => e.name !== name);
    await vscode.workspace
      .getConfiguration('goatllm')
      .update('endpoints', endpoints, vscode.ConfigurationTarget.Global);
    await this.secrets.delete(SECRET_PREFIX + name);
  }

  /** Probe common local server ports to discover running instances */
  async detectLocalServers(): Promise<Endpoint[]> {
    const candidates: Endpoint[] = [
      { name: 'MLX (local)', baseUrl: 'http://localhost:8013/v1' },
      { name: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1' },
      { name: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1' },
      { name: 'llama.cpp (local)', baseUrl: 'http://localhost:8080/v1' },
      { name: 'exo (local)', baseUrl: 'http://localhost:52415/v1' },
      { name: 'vLLM (local)', baseUrl: 'http://localhost:8000/v1' },
    ];

    const checks = candidates.map(async (ep) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1500);
        const res = await fetch(`${ep.baseUrl}/models`, { signal: controller.signal });
        clearTimeout(timeout);
        return res.ok ? ep : null;
      } catch {
        return null;
      }
    });

    const results = await Promise.all(checks);
    return results.filter((e): e is Endpoint => e !== null);
  }
}
