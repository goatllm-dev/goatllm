import { ModelInfo } from './types';

/**
 * Curated list of open-source LLMs commonly served locally.
 * This is a fallback — GoatLLM prefers to list models dynamically from the
 * active endpoint's /v1/models. This static list is used when the endpoint
 * doesn't expose a models list (rare) or to surface memory estimates.
 */
export interface LocalModelCard extends ModelInfo {
  id: string;
  name: string;
  /** Approx unified-memory footprint in GB for inference */
  ramGb?: number;
  /** Common tags: mlx, gguf, ollama, reasoning, coder, vision */
  tags?: string[];
}

export const KNOWN_LOCAL_MODELS: LocalModelCard[] = [
  // Gemma
  { id: 'mlx-community/gemma-4-31b-8bit', name: 'Gemma 4 31B (8-bit MLX)', ramGb: 33, contextLength: 128000, tags: ['mlx', 'gemma'] },
  { id: 'mlx-community/gemma-4-31b-it-4bit', name: 'Gemma 4 31B (4-bit MLX)', ramGb: 17, contextLength: 128000, tags: ['mlx', 'gemma'] },
  { id: 'mlx-community/gemma-2-27b-it-4bit', name: 'Gemma 2 27B (4-bit MLX)', ramGb: 15, contextLength: 8192, tags: ['mlx', 'gemma'] },
  { id: 'mlx-community/gemma-2-9b-it-4bit', name: 'Gemma 2 9B (4-bit MLX)', ramGb: 6, contextLength: 8192, tags: ['mlx', 'gemma'] },

  // Qwen
  { id: 'mlx-community/Qwen2.5-Coder-32B-Instruct-4bit', name: 'Qwen 2.5 Coder 32B (4-bit MLX)', ramGb: 18, contextLength: 131072, tags: ['mlx', 'qwen', 'coder'] },
  { id: 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit', name: 'Qwen 2.5 Coder 7B (4-bit MLX)', ramGb: 5, contextLength: 131072, tags: ['mlx', 'qwen', 'coder'] },
  { id: 'mlx-community/Qwen2.5-72B-Instruct-4bit', name: 'Qwen 2.5 72B (4-bit MLX)', ramGb: 40, contextLength: 131072, tags: ['mlx', 'qwen'] },

  // Llama
  { id: 'mlx-community/Llama-3.3-70B-Instruct-4bit', name: 'Llama 3.3 70B (4-bit MLX)', ramGb: 40, contextLength: 131072, tags: ['mlx', 'llama'] },
  { id: 'mlx-community/Meta-Llama-3.1-8B-Instruct-4bit', name: 'Llama 3.1 8B (4-bit MLX)', ramGb: 5, contextLength: 131072, tags: ['mlx', 'llama'] },

  // DeepSeek
  { id: 'mlx-community/DeepSeek-R1-Distill-Qwen-32B-4bit', name: 'DeepSeek R1 Distill Qwen 32B (4-bit MLX)', ramGb: 18, contextLength: 131072, tags: ['mlx', 'deepseek', 'reasoning'] },
  { id: 'mlx-community/DeepSeek-V3-4bit', name: 'DeepSeek V3 (4-bit MLX)', ramGb: 340, contextLength: 131072, tags: ['mlx', 'deepseek', 'moe'] },

  // Mistral
  { id: 'mlx-community/Mistral-Nemo-Instruct-2407-4bit', name: 'Mistral Nemo 12B (4-bit MLX)', ramGb: 7, contextLength: 131072, tags: ['mlx', 'mistral'] },

  // Ollama naming (when connected to Ollama server)
  { id: 'qwen2.5-coder:32b', name: 'Qwen 2.5 Coder 32B (Ollama)', ramGb: 20, contextLength: 131072, tags: ['ollama', 'qwen', 'coder'] },
  { id: 'qwen2.5-coder:7b', name: 'Qwen 2.5 Coder 7B (Ollama)', ramGb: 5, contextLength: 131072, tags: ['ollama', 'qwen', 'coder'] },
  { id: 'llama3.3:70b', name: 'Llama 3.3 70B (Ollama)', ramGb: 43, contextLength: 131072, tags: ['ollama', 'llama'] },
  { id: 'deepseek-r1:32b', name: 'DeepSeek R1 32B (Ollama)', ramGb: 20, contextLength: 131072, tags: ['ollama', 'deepseek', 'reasoning'] },
  { id: 'gemma2:27b', name: 'Gemma 2 27B (Ollama)', ramGb: 16, contextLength: 8192, tags: ['ollama', 'gemma'] },
];

export function findKnownModel(id: string): LocalModelCard | undefined {
  return KNOWN_LOCAL_MODELS.find((m) => m.id === id);
}

export function enrichModelInfo(m: ModelInfo): LocalModelCard {
  const known = findKnownModel(m.id);
  if (known) return { ...known, ...m, name: known.name };
  return { id: m.id, name: m.name ?? m.id, contextLength: m.contextLength };
}
