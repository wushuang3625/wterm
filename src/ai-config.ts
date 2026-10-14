import { configStorage } from './config-storage';
import { invoke } from '@tauri-apps/api/core';

export type AiProtocol = 'openai' | 'anthropic';

export interface AiProviderPreset {
  id: string;
  label: string;
  protocol: AiProtocol;
  base_url: string;
  /** 仅供提示，实际模型以拉取列表或手动输入为准 */
  hint: string;
}

export const AI_PROVIDERS: AiProviderPreset[] = [
  { id: 'deepseek', label: 'DeepSeek', protocol: 'openai', base_url: 'https://api.deepseek.com/v1', hint: 'deepseek-chat' },
  { id: 'openai', label: 'OpenAI', protocol: 'openai', base_url: 'https://api.openai.com/v1', hint: 'gpt-4o-mini' },
  { id: 'moonshot', label: 'Moonshot (Kimi)', protocol: 'openai', base_url: 'https://api.moonshot.cn/v1', hint: 'kimi-k2-0905-preview' },
  { id: 'qwen', label: '通义千问 (DashScope 兼容模式)', protocol: 'openai', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', hint: 'qwen-plus' },
  { id: 'anthropic', label: 'Anthropic (Claude)', protocol: 'anthropic', base_url: 'https://api.anthropic.com/v1', hint: 'claude-sonnet-4-5' },
  { id: 'ollama', label: 'Ollama (本地，无需 Key)', protocol: 'openai', base_url: 'http://localhost:11434/v1', hint: 'qwen2.5:7b' },
  { id: 'custom', label: '自定义 (OpenAI 兼容)', protocol: 'openai', base_url: '', hint: '' },
];

/** Keychain 中 AI API key 的条目名（service 与其他凭据一致）。 */
export function aiCredentialKey(baseUrl: string, protocol: AiProtocol): string {
  const url = new URL(baseUrl.trim());
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Base URL 必须是无用户名、密码、查询参数的 HTTP(S) 地址');
  }
  return `ai:${protocol}:${url.href.replace(/\/+$/, '')}`;
}

export interface AiConfig {
  provider: string;
  protocol: AiProtocol;
  baseUrl: string;
  models: string[];
  activeModel: string;
}

function readModels(): string[] {
  try {
    const value = JSON.parse(configStorage.getItem('wterm_ai_models') || '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && !!id) : [];
  } catch {
    return [];
  }
}

export function aiConfig(): AiConfig {
  const protocol = configStorage.getItem('wterm_ai_protocol');
  return {
    provider: configStorage.getItem('wterm_ai_provider') || '',
    protocol: protocol === 'anthropic' ? 'anthropic' : 'openai',
    baseUrl: (configStorage.getItem('wterm_ai_base_url') || '').trim(),
    models: readModels(),
    activeModel: configStorage.getItem('wterm_ai_active_model') || '',
  };
}

export function setAiProvider(provider: string): void {
  configStorage.setItem('wterm_ai_provider', provider);
}

export function setAiBaseUrl(baseUrl: string): void {
  configStorage.setItem('wterm_ai_base_url', baseUrl.trim());
}

export function setAiProtocol(protocol: AiProtocol): void {
  configStorage.setItem('wterm_ai_protocol', protocol);
}

export function setAiModels(models: string[]): void {
  configStorage.setItem('wterm_ai_models', JSON.stringify(models));
}

export function setAiActiveModel(model: string): void {
  configStorage.setItem('wterm_ai_active_model', model);
}

/** 添加模型（去重，保持添加顺序）；返回新的模型列表。 */
export function addAiModels(ids: string[]): string[] {
  const models = readModels();
  for (const id of ids) {
    const trimmed = id.trim();
    if (trimmed && !models.includes(trimmed)) models.push(trimmed);
  }
  setAiModels(models);
  return models;
}

export function removeAiModel(id: string): string[] {
  const models = readModels().filter(model => model !== id);
  setAiModels(models);
  if (configStorage.getItem('wterm_ai_active_model') === id) {
    setAiActiveModel(models[0] || '');
  }
  return models;
}

/** 基础配置是否可用：有地址、有模型、且当前模型仍在已保存列表中。 */
export function aiReady(): boolean {
  const config = aiConfig();
  return !!config.baseUrl && config.models.length > 0 && config.models.includes(config.activeModel);
}

export function aiAutoDiagnose(): boolean {
  return configStorage.getItem('wterm_ai_auto_diagnose') === 'true';
}

export async function hasAiKey(baseUrl: string, protocol: AiProtocol): Promise<boolean> {
  if (!baseUrl.trim()) return false;
  return !!(await invoke<string | null>('credential_get', { kind: 'api_key', key: aiCredentialKey(baseUrl, protocol) }));
}

export function saveAiKey(key: string, baseUrl: string, protocol: AiProtocol): Promise<void> {
  return invoke('credential_set', { kind: 'api_key', key: aiCredentialKey(baseUrl, protocol), value: key });
}

export function deleteAiKey(baseUrl: string, protocol: AiProtocol): Promise<void> {
  return invoke('credential_delete', { kind: 'api_key', key: aiCredentialKey(baseUrl, protocol) });
}
