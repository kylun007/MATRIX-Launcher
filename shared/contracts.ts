import { z } from 'zod';
import { skinCommands, skinCameraSchema, type SkinResults } from './skin.ts';
import { hardwareOverrideSchema, smartPreferencesSchema, smartRequestSchema, smartStateSchema, type Hardware, type Recommendation, type ContentProject, type SmartPlan, type InstalledContent, type SmartProgress } from './smart.ts';
import { modCommands, type ModResults } from './mod-center.ts';

export const nickname = z.string().regex(/^[A-Za-z0-9_]{3,16}$/, 'Use de 3 a 16 letras, números ou _');
export const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/);
export const httpsUrl = z.string().url().refine(s => { try { const u = new URL(s); return u.protocol === 'https:' && !u.username && !u.password && !u.hash; } catch { return false; } }, 'Use um endereço HTTPS');
export const settingsSchema = z.object({
  minMemory: z.number().int().min(512).max(65536), maxMemory: z.number().int().min(1024).max(65536),
  width: z.number().int().min(640).max(7680), height: z.number().int().min(480).max(4320),
  gameDirectory: z.string().min(1).max(1024), javaPath: z.string().max(1024),
  jvmArgs: z.array(z.string().min(1).max(2048)).max(40), concurrency: z.number().int().min(1).max(16),
  serverHost: z.string().max(253).refine(s => s === '' || /^(?:[a-zA-Z0-9.-]+|[a-fA-F0-9:]+)$/.test(s)),
  serverPort: z.number().int().min(1).max(65535), serverOnlineMode: z.boolean(),
  communityApi: z.union([httpsUrl, z.literal('')]), discordUrl: z.union([httpsUrl, z.literal('')]),
  theme: z.enum(['dark', 'light']), checkUpdates: z.boolean(), skinCamera: skinCameraSchema,
}).strict().refine(s => s.minMemory <= s.maxMemory, 'RAM mínima deve ser menor ou igual à máxima');
export type Settings = z.infer<typeof settingsSchema>;
export const accountSchema = z.object({ id: z.string().uuid(), kind: z.enum(['offline', 'microsoft']), name: nickname, uuid: z.string().regex(/^[a-f0-9]{32}$/i), skin: z.union([httpsUrl, z.literal('')]).default(''), expiresAt: z.number().optional(), skinProjectId: z.string().uuid().optional() }).strict();
export type Account = z.infer<typeof accountSchema>;
export const instanceInput = z.object({ name: z.string().trim().min(1).max(60), minecraft: identifier, loader: z.enum(['vanilla', 'fabric', 'forge', 'neoforge']), loaderVersion: z.string().regex(/^[A-Za-z0-9._+-]{0,80}$/) }).strict().refine(i => i.loader === 'vanilla' || i.loaderVersion.length > 0, 'Informe a versão do loader');
export const instanceSchema = instanceInput.safeExtend({ id: z.string().uuid(), versionId: identifier.optional(), installed: z.boolean(), lastPlayed: z.number().optional(), modpackVersion: z.string().optional(), smart: smartStateSchema.optional(), launch: z.object({ minMemory: z.number().int().min(512).max(65536), maxMemory: z.number().int().min(1024).max(65536), javaPath: z.string().max(1024).optional() }).strict().refine(p => p.minMemory <= p.maxMemory).optional() });
export type Instance = z.infer<typeof instanceSchema>;
export const storeSchema = z.object({ schemaVersion: z.literal(1), settings: settingsSchema, accounts: z.array(accountSchema).max(100), instances: z.array(instanceSchema).max(100), selectedAccount: z.string().uuid().optional(), selectedInstance: z.string().uuid().optional(), modFavorites: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).max(500).default([]) }).strict();
export type StoreData = z.infer<typeof storeSchema>;
export type Operation = { kind: 'minecraft' | 'java' | 'modpack' | 'auth' | 'smart' | 'mods'; label: string; bytes: number; total: number; speed: number; cancellable: boolean; smart?: SmartProgress };
export type GameState = { status: 'idle' | 'starting' | 'running'; instanceId?: string; exitCode?: number | null; stoppedByUser?: boolean };
export type UpdateState = { status: 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'; version?: string; percent?: number; message?: string };
export type News = { title: string; body: string; date: string; url?: string };
export const communitySchema = z.object({
  schemaVersion: z.literal(1), news: z.array(z.object({ title: z.string().max(120), body: z.string().max(2000), date: z.string().datetime(), url: httpsUrl.optional() })).max(20),
  maintenance: z.string().max(500).optional(), recommendedVersion: identifier.optional(),
  server: z.object({ host: z.string().regex(/^[a-zA-Z0-9.-]+$/).max(253), port: z.number().int().min(1).max(65535), onlineMode: z.boolean() }).optional(),
  modpack: z.object({ url: httpsUrl, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
});
export type Community = z.infer<typeof communitySchema>;
export type ServerStatus = { status: 'unconfigured' | 'online' | 'offline'; online?: number; max?: number; latency?: number; message?: string };
export type JavaState = { status: 'unknown' | 'ready' | 'missing' | 'incompatible'; required?: number; major?: number };
export type Snapshot = StoreData & { operation?: Operation; game: GameState; java: JavaState; update: UpdateState; server: ServerStatus; community?: Community; communityError?: string; authCode?: { code: string; url: string; expiresAt: number }; error?: string; appVersion: string; microsoftConfigured: boolean };
export type Release = { id: string; releaseTime: string };
export const manifestSchema = z.object({
  schemaVersion: z.literal(1), id: identifier, version: identifier, minecraft: identifier,
  loader: z.object({ type: z.enum(['vanilla', 'fabric', 'forge', 'neoforge']), version: z.string().regex(/^[A-Za-z0-9._+-]{0,80}$/) }),
  allowedHosts: z.array(z.string().regex(/^[a-zA-Z0-9.-]+$/)).min(1).max(20),
  files: z.array(z.object({ path: z.string().min(1).max(500), url: httpsUrl, sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().min(0).max(2_000_000_000), license: z.string().min(1).max(200) }).strict()).max(2000),
  removalPolicy: z.literal('preserve').or(z.literal('managed-only')),
}).strict();
export type ModpackManifest = z.infer<typeof manifestSchema>;
export const commandSchemas = {
  ...modCommands,
  ...skinCommands,
  snapshot: z.undefined(), releases: z.undefined(),
  settings: settingsSchema,
  'account.create': z.object({ name: nickname }).strict(),
  'account.rename': z.object({ id: z.string().uuid(), name: nickname }).strict(),
  'account.select': z.string().uuid(), 'account.delete': z.string().uuid(),
  'auth.login': z.undefined(),
  'instance.create': instanceInput, 'instance.select': z.string().uuid(), 'instance.delete': z.string().uuid(),
  'instance.install': z.string().uuid(), 'instance.open': z.string().uuid(), 'instance.inspect': z.string().uuid(),
  'instance.discover': z.undefined(),
  'instance.rename': z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(60) }).strict(),
  'smart.hardware': z.undefined(), 'smart.recommend': hardwareOverrideSchema,
  'smart.catalog': z.undefined(), 'smart.plan': smartRequestSchema,
  'smart.install': z.object({ planId: z.string().uuid(), allowJavaInstall: z.boolean() }).strict(),
  'smart.resume': z.object({ id: z.string().uuid(), allowJavaInstall: z.boolean() }).strict(),
  'smart.content': z.string().uuid(),
  'smart.configure': z.object({ id: z.string().uuid(), preferences: smartPreferencesSchema }).strict(),
  'smart.update': z.string().uuid(),
  'smart.mod.toggle': z.object({ id: z.string().uuid(), projectId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), enabled: z.boolean() }).strict(),
  'shader.search': z.object({ query: z.string().trim().max(100) }).strict(),
  'shader.install': z.object({ id: z.string().uuid(), projectId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }).strict(),
  'shader.plan': z.object({ id: z.string().uuid(), projectId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }).strict(),
  'shader.select': z.object({ id: z.string().uuid(), filename: z.string().max(200).optional() }).strict(),
  'shader.delete': z.object({ id: z.string().uuid(), filename: z.string().min(1).max(200) }).strict(),
  'game.play': z.object({ id: z.string().uuid(), connect: z.boolean() }).strict(),
  'game.stop': z.undefined(), cancel: z.undefined(),
  'java.detect': z.undefined(), 'java.choose': z.undefined(), 'java.install': z.string().uuid(),
  'directory.choose': z.undefined(), 'logs.open': z.undefined(), 'logs.export': z.undefined(),
  'community.refresh': z.undefined(), 'server.copy': z.undefined(),
  'link.open': httpsUrl,
  'modpack.sync': z.object({ id: z.string().uuid(), url: httpsUrl, sha256: z.string().regex(/^[a-f0-9]{64}$/), allowRemove: z.boolean() }).strict(),
  'update.check': z.undefined(), 'update.download': z.undefined(), 'update.apply': z.undefined(),
} as const;
export type Command = keyof typeof commandSchemas;
export type Input<C extends Command> = z.infer<(typeof commandSchemas)[C]>;
export type CommandResults = SkinResults & ModResults & {
  snapshot: Snapshot; releases: Release[]; settings: void;
  'account.create': void; 'account.rename': void; 'account.select': void; 'account.delete': void;
  'auth.login': void; 'instance.create': void; 'instance.select': void; 'instance.delete': void;
  'instance.install': void; 'instance.open': void; 'instance.inspect': { valid: boolean; message: string };
  'instance.discover': string[];
  'instance.rename': void;
  'smart.hardware': Hardware; 'smart.recommend': Recommendation; 'smart.catalog': ContentProject[];
  'smart.plan': SmartPlan; 'smart.install': string; 'smart.resume': void; 'smart.content': InstalledContent;
  'smart.configure': void; 'smart.update': SmartPlan; 'smart.mod.toggle': void;
  'shader.search': ContentProject[]; 'shader.install': void; 'shader.plan': SmartPlan; 'shader.select': void; 'shader.delete': void;
  'game.play': void; 'game.stop': void; cancel: void;
  'java.detect': { path: string; major: number }[]; 'java.choose': string | undefined; 'java.install': void;
  'directory.choose': string | undefined; 'logs.open': void; 'logs.export': string | undefined;
  'community.refresh': void; 'server.copy': void; 'link.open': void; 'modpack.sync': void;
  'update.check': void; 'update.download': void; 'update.apply': void;
};
export type Reply<T> = { ok: true; value: T } | { ok: false; error: string };
export interface MatrixBridge {
  onSkinClose(listener: () => void): () => void;
  invoke<C extends Command>(command: C, input?: Input<C>): Promise<CommandResults[C]>;
  subscribe(listener: (snapshot: Snapshot) => void): () => void;
}
