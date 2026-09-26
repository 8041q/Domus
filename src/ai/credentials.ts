import type { AiProviderId } from './types';

const DATABASE_NAME = 'domus-ai-experimental';
const DATABASE_VERSION = 1;
const DEVICE_KEY_ID = 'device-key-v1';

type StoredCredential = {
  provider: AiProviderId;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
  lastFour: string;
  updatedAt: number;
};

export type CredentialMetadata = Pick<StoredCredential, 'provider' | 'lastFour' | 'updatedAt'>;

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('keys')) database.createObjectStore('keys');
      if (!database.objectStoreNames.contains('credentials')) database.createObjectStore('credentials', { keyPath: 'provider' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the AI credential store.'));
  });
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('AI credential storage failed.'));
  });
}

async function deviceKey(database: IDBDatabase) {
  const existing = await requestResult(database.transaction('keys').objectStore('keys').get(DEVICE_KEY_ID)) as CryptoKey | undefined;
  if (existing) return existing;
  const generated = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await requestResult(database.transaction('keys', 'readwrite').objectStore('keys').put(generated, DEVICE_KEY_ID));
  return generated;
}

export async function saveAiCredential(provider: Exclude<AiProviderId, 'ollama'>, credential: string) {
  const value = credential.trim();
  if (!value) throw new Error('Enter an API key first.');
  const database = await openDatabase();
  try {
    const key = await deviceKey(database);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value));
    const record: StoredCredential = {
      provider,
      iv: iv.buffer,
      ciphertext,
      lastFour: value.slice(-4),
      updatedAt: Date.now()
    };
    await requestResult(database.transaction('credentials', 'readwrite').objectStore('credentials').put(record));
    return { provider, lastFour: record.lastFour, updatedAt: record.updatedAt } satisfies CredentialMetadata;
  } finally {
    database.close();
  }
}

export async function loadAiCredential(provider: Exclude<AiProviderId, 'ollama'>) {
  const database = await openDatabase();
  try {
    const record = await requestResult(database.transaction('credentials').objectStore('credentials').get(provider)) as StoredCredential | undefined;
    if (!record) return null;
    const key = await deviceKey(database);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(record.iv) }, key, record.ciphertext);
    return new TextDecoder().decode(plaintext);
  } finally {
    database.close();
  }
}

export async function getAiCredentialMetadata(provider: Exclude<AiProviderId, 'ollama'>) {
  const database = await openDatabase();
  try {
    const record = await requestResult(database.transaction('credentials').objectStore('credentials').get(provider)) as StoredCredential | undefined;
    return record
      ? { provider: record.provider, lastFour: record.lastFour, updatedAt: record.updatedAt } satisfies CredentialMetadata
      : null;
  } finally {
    database.close();
  }
}

export async function removeAiCredential(provider: Exclude<AiProviderId, 'ollama'>) {
  const database = await openDatabase();
  try {
    await requestResult(database.transaction('credentials', 'readwrite').objectStore('credentials').delete(provider));
  } finally {
    database.close();
  }
}
