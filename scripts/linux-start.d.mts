export function desktopDirectory(env?: { XDG_DATA_HOME?: string }, home?: string): string;
export function desktopEntry(projectRoot: string, executable: string): string;
export function sourceFingerprint(projectRoot: string): Promise<string>;
export function startLinux(): Promise<void>;
