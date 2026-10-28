import type { ProductDefinition } from '../src/core/types';
export const modelId: RegExp;
export function sha256(bytes: Uint8Array): string;
export function safePath(root: string, relative: string): Promise<string>;
export function readSafe(root: string, relative: string): Promise<Buffer>;
export function validateGLB(bytes: Buffer): Record<string, any>;
export function publicProduct(product: ProductDefinition): ProductDefinition;
export function publicDisplayGLB(bytes: Uint8Array, options?: { preserveNames?: boolean }): Buffer;
