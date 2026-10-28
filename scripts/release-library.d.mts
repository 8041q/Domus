export function listFiles(root: string, prefix?: string): Promise<string[]>;
export function validateLibrary(root: string): Promise<any>;
export function prepareRelease(workspace: string, destination: string, serverBundle: string): Promise<void>;
export function validateRelease(root: string): Promise<any>;
