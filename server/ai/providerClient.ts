import { Type } from '@google/genai';
import {
  AdapterCallError,
  AdapterCompletionParams,
  callProviderWithAdapter,
  DetailedTestConnectionResult,
  DiscoveredModel,
  extractJsonFromLlmText,
  fetchModelsWithAdapter,
  inferModelCapabilities,
  ModelCapabilities,
  testProviderConnectionWithAdapter,
} from './adapters.ts';
import { ClientVaultSnapshot, StoredAiProvider } from './keyVault.ts';

export type {
  DetailedTestConnectionResult,
  DiscoveredModel,
  ModelCapabilities,
};

export {
  AdapterCallError,
  extractJsonFromLlmText,
  inferModelCapabilities,
};

export async function fetchModelsFromProvider(
  providerId: string,
  snapshot?: ClientVaultSnapshot | null
): Promise<{
  models: DiscoveredModel[];
  supportsModelListing: boolean;
  message?: string;
}> {
  return fetchModelsWithAdapter(providerId, snapshot);
}

export async function testProviderConnection(
  providerId: string,
  snapshot?: ClientVaultSnapshot | null
): Promise<DetailedTestConnectionResult> {
  return testProviderConnectionWithAdapter(providerId, snapshot);
}

export async function callProviderTextCompletion(params: {
  provider: StoredAiProvider;
  apiKey: string;
  modelOverride?: string;
  systemInstruction: string;
  userPrompt: string;
  expectJson?: boolean;
  audioInline?: { mimeType: string; base64Data: string };
  signal?: AbortSignal;
}): Promise<string> {
  return callProviderWithAdapter(params as AdapterCompletionParams);
}

export { Type };
