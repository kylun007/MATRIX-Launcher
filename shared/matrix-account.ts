export type MatrixIdentity = { id: string; email?: string; displayName: string; avatarUrl?: string; providers: string[]; createdAt?: string };
export type MatrixAuthState = { configured: boolean; signedIn: boolean; identity?: MatrixIdentity; error?: string };
export type MatrixDriveState = { configured: boolean; connected: boolean };
export type MatrixDriveBackup = { id: string; name: string; size: number; createdAt?: string };
