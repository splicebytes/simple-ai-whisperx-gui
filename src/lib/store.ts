import { load, Store } from '@tauri-apps/plugin-store';

export interface AppConfig {
  hfToken: string;
  condaPath: string;
  condaEnv: string;
  ffmpegPath: string;
  whisperxCmd: string;
  device: string;
  computeType: string;
  defaultLanguage: string;
  defaultModel: string;
  diarize: boolean;
  normalizeAudio: boolean;
  autoSaveFiles: boolean;
  lastOutputDir: string;
  // LLM
  llmEnabled: boolean;
  llmProvider: string;
  llmEndpoint: string;
  llmModel: string;
  selectedPromptId: string;
  llmTimeout: number;
}

export interface PromptTemplate {
  id: string;
  name: string;
  content: string;
  isDefault: boolean;
}

const DEFAULT_CONFIG: AppConfig = {
  hfToken: '',
  condaPath: '',
  condaEnv: 'base',
  ffmpegPath: '',
  whisperxCmd: 'whisperx',
  device: 'cuda',
  computeType: 'int8',
  defaultLanguage: 'en',
  defaultModel: 'large-v3',
  diarize: true,
  normalizeAudio: true,
  autoSaveFiles: false,
  lastOutputDir: '',
  llmEnabled: false,
  llmProvider: 'ollama',
  llmEndpoint: 'http://localhost:11434',
  llmModel: '',
  selectedPromptId: 'situational-joke',
  llmTimeout: 3600,
};

const DEFAULT_PROMPTS: PromptTemplate[] = [
  {
    id: 'situational-joke',
    name: 'Situational Joke',
    content:
      'First, silently detect the language of the transcription below. Then write a short, witty joke inspired by the main topic or a funny nuance in that transcription. CRITICAL: Your entire response must be written in the SAME language as the transcription — if the transcription is in Polish, respond in Polish; if in English, respond in English; if in German, respond in German; and so on. Output ONLY the joke itself, no introduction or explanation.',
    isDefault: true,
  },
  {
    id: 'universal-summary',
    name: 'Universal Summary',
    content:
      'First, silently detect the language of the transcription below. Then write a concise summary highlighting the key points, main takeaways, and context. Use markdown with headers and bullet points. CRITICAL: Your entire response — every word, heading, and bullet — must be written in the SAME language as the transcription. Do not translate. Do not switch languages.',
    isDefault: true,
  },
  {
    id: 'action-items',
    name: 'Action Items & Decisions',
    content:
      'First, silently detect the language of the transcription below. Then extract every specific action item, task, and decision from the conversation. For each item, note the responsible person and deadline if mentioned. If one sentence overrides everything else, highlight it at the very top. CRITICAL: Your entire response must be written in the SAME language as the transcription — do not translate or switch to any other language.',
    isDefault: true,
  },
  {
    id: 'brainstorm-organizer',
    name: 'Raw Thoughts Organizer',
    content:
      'First, silently detect the language of the transcription below. The transcription may contain raw, unorganized thoughts. Structure them into a coherent mind-map style summary: group related ideas and provide a logical flow. CRITICAL: Your entire response must be written in the SAME language as the transcription — do not translate, do not switch languages.',
    isDefault: true,
  },
  {
    id: 'essential-insight',
    name: 'The Essential Insight',
    content:
      "First, silently detect the language of the transcription below. Then ignore the filler and identify the single most critical insight, decision, or piece of information — the 'Gold Nugget' — that makes the conversation worthwhile. Explain briefly why it matters. CRITICAL: Your entire response must be written in the SAME language as the transcription — do not translate, do not use English unless the transcription itself is in English.",
    isDefault: true,
  },
];

// Bump this version whenever DEFAULT_PROMPTS content changes.
// On load, if the stored version differs, default prompts are refreshed
// while custom (non-default) prompts created by the user are preserved.
const PROMPTS_VERSION = 2;

let storeInstance: Store | null = null;

async function getStore(): Promise<Store> {
  if (!storeInstance) {
    storeInstance = await load('whisperx-config.json', { autoSave: true, defaults: {} });
  }
  return storeInstance;
}

export async function loadConfig(): Promise<AppConfig> {
  try {
    const store = await getStore();
    const config = await store.get<AppConfig>('config');
    return { ...DEFAULT_CONFIG, ...config };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export const updateStoreConfig = async (updates: Partial<AppConfig>) => {
  const current = await loadConfig(); // zawsze wczytaj świerze przed odświeżeniem
  const latestResult = { ...current, ...updates }; // nadpisz tyko te zmienione, pozostaw inne
  const store = await getStore();
  await store.set('config', latestResult);
  await store.save();
  return latestResult;
};

export async function loadPrompts(): Promise<PromptTemplate[]> {
  try {
    const store = await getStore();
    const prompts = await store.get<PromptTemplate[]>('prompts');
    const storedVersion = await store.get<number>('promptsVersion');

    // First run or outdated defaults: refresh default prompts, keep custom ones
    if (!prompts || prompts.length === 0 || storedVersion !== PROMPTS_VERSION) {
      const customPrompts = (prompts ?? []).filter((p) => !p.isDefault);
      const merged = [...DEFAULT_PROMPTS, ...customPrompts];
      await store.set('prompts', merged);
      await store.set('promptsVersion', PROMPTS_VERSION);
      await store.save();
      return merged;
    }

    return prompts;
  } catch {
    return [...DEFAULT_PROMPTS];
  }
}

export async function savePrompts(prompts: PromptTemplate[]): Promise<void> {
  const store = await getStore();
  await store.set('prompts', prompts);
  await store.save();
}
