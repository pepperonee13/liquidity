import { config } from '../config.js';
import { DemoProvider } from './demo.js';
import { EnableBankingProvider } from './enablebanking.js';
import type { BankProvider } from './types.js';

export type ProviderRegistry = Map<string, BankProvider>;

export function defaultProviders(): ProviderRegistry {
  const map: ProviderRegistry = new Map();
  map.set('enablebanking', new EnableBankingProvider());
  if (config.demoProvider) map.set('demo', new DemoProvider());
  return map;
}
