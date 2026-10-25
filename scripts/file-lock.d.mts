export function withFileLock<T>(filename: string, action: () => Promise<T>, waitMs?: number): Promise<T>;
