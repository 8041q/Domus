import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/core/id.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { createId } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('IDs stay unique and retain UUID format on HTTP where randomUUID is unavailable', () => {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
  try {
    const ids = Array.from({ length: 1000 }, createId);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally {
    if (descriptor) Object.defineProperty(crypto, 'randomUUID', descriptor);
    else delete crypto.randomUUID;
  }
});
