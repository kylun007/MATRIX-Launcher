import { z } from 'zod';

export const smartPresetSchema = z.enum(['performance', 'balanced', 'ultra']);
export type SmartPreset = z.infer<typeof smartPresetSchema>;
export const smartPreferencesSchema = z.object({
  minMemory: z.number().int().min(512).max(65536), maxMemory: z.number().int().min(1024).max(65536),
  renderDistance: z.number().int().min(2).max(32), simulationDistance: z.number().int().min(5).max(32),
  particles: z.enum(['all', 'decreased', 'minimal']), graphics: z.enum(['fast', 'fancy']),
  maxFps: z.number().int().min(30).max(260),
}).strict().refine(p => p.minMemory <= p.maxMemory, 'RAM mínima deve ser menor que a máxima');
export type SmartPreferences = z.infer<typeof smartPreferencesSchema>;
export type Hardware = {
  cpu: { model: string; cores?: number; threads: number; mhz?: number };
  memory: { total: number; available: number };
  gpus: { name: string; vram?: number; integrated?: boolean }[];
  os: string; arch: string; diskAvailable?: number;
  java: { path: string; major: number }[]; warnings: string[];
};
export const hardwareOverrideSchema = z.object({
  cpuCores: z.number().int().min(1).max(256).optional(), cpuThreads: z.number().int().min(1).max(512).optional(),
  memoryGB: z.number().min(2).max(1024).optional(), gpu: z.enum(['unknown', 'integrated', 'dedicated']).optional(),
  vramGB: z.number().min(0).max(128).optional(),
}).strict();
export type HardwareOverride = z.infer<typeof hardwareOverrideSchema>;
export type Recommendation = { preset: SmartPreset; preferences: SmartPreferences; reasons: string[]; shadersSuggested: boolean; estimated: true };
export const SMART_MODS = ['sodium', 'lithium', 'ferrite-core', 'immediatelyfast', 'entityculling', 'modernfix', 'modmenu', 'iris'] as const;
export const smartRequestSchema = z.object({
  name: z.string().trim().min(1).max(60), preset: smartPresetSchema,
  mods: z.array(z.enum(SMART_MODS)).min(1).max(8), shaderProject: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),
  preferences: smartPreferencesSchema, hardwareOverride: hardwareOverrideSchema.optional(),
}).strict();
export type SmartRequest = z.infer<typeof smartRequestSchema>;
export type ContentProject = {
  id: string; slug: string; title: string; description: string; license: string; sourceUrl: string;
  icon?: string; image?: string; available: boolean; reason?: string;
};
export type ContentFile = {
  projectId: string; slug: string; title: string; versionId: string; version: string;
  kind: 'mod' | 'shader'; filename: string; url: string; hash: string; algorithm: 'sha1' | 'sha256' | 'sha512';
  size: number; license: string; sourceUrl: string; enabled?: boolean; dependencies?: string[];
};
export type SmartPlan = {
  id: string; request: SmartRequest; minecraft: '1.21.1'; fabric: string; files: ContentFile[];
  warnings: string[]; java: { major: 21; component: string; path?: string; installRequired: boolean };
  contentBytes: number; requiredDiskBytes: number; createdAt: number;
};
export const smartStateSchema = z.object({ preset: smartPresetSchema, status: z.enum(['pending', 'installing', 'ready', 'interrupted']), planId: z.string().uuid(), error: z.string().max(800).optional() }).strict();
export type SmartState = z.infer<typeof smartStateSchema>;
export type InstalledContent = { mods: ContentFile[]; shaders: ContentFile[]; activeShader?: string; preferences: SmartPreferences; warnings: string[] };
export type SmartProgress = { stage: string; completedStages: string[]; file?: string; filesDone: number; filesTotal: number };
