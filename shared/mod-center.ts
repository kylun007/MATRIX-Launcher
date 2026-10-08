import { z } from 'zod';
import type { ContentFile } from './smart.ts';

export const modTypeSchema = z.enum(['mod', 'shader', 'resourcepack', 'modpack']);
export const modSearchSchema = z.object({
  query: z.string().trim().max(100), type: modTypeSchema.default('mod'),
  minecraft: z.string().regex(/^\d+(?:\.\d+){1,2}$/),
  loader: z.enum(['vanilla', 'fabric', 'forge', 'neoforge']),
  compatibleOnly: z.boolean().default(true), index: z.enum(['relevance', 'downloads', 'follows', 'newest', 'updated']).default('relevance'),
  offset: z.number().int().min(0).max(10000).default(0), limit: z.number().int().min(1).max(30).default(12),
}).strict();
export type ModSearch = z.infer<typeof modSearchSchema>;
export type ModProject = { id: string; slug: string; title: string; description: string; author: string; downloads: number; license: string; categories: string[]; icon?: string; gallery: string[]; sourceUrl: string; compatible: boolean; versions: string[]; reason?: string };
export type ModPage = { projects: ModProject[]; offset: number; limit: number; total: number };
export type ModPlan = { id: string; instanceId: string; projectId: string; files: ContentFile[]; replacements?: ContentFile[]; totalBytes: number; warnings: string[] };
export type ManagedMod = { filename: string; title: string; version?: string; projectId?: string; enabled: boolean; managed: boolean; source: 'mod-center' | 'smart' | 'manual'; status: 'ok' | 'modified' | 'missing' | 'manual' };
export type ModResults = {
  'mod.search': ModPage; 'mod.details': ModProject; 'mod.plan': ModPlan; 'mod.install': void;
  'mod.list': ManagedMod[]; 'mod.toggle': void; 'mod.remove': void; 'mod.favorite': void; 'mod.favorites': string[];
};
export const modCommands = {
  'mod.search': modSearchSchema,
  'mod.details': z.object({ projectId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), minecraft: z.string().regex(/^\d+(?:\.\d+){1,2}$/), loader: z.enum(['vanilla', 'fabric', 'forge', 'neoforge']) }).strict(),
  'mod.plan': z.object({ instanceId: z.string().uuid(), projectId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }).strict(),
  'mod.install': z.string().uuid(), 'mod.list': z.string().uuid(),
  'mod.toggle': z.object({ instanceId: z.string().uuid(), filename: z.string().min(1).max(240), enabled: z.boolean() }).strict(),
  'mod.remove': z.object({ instanceId: z.string().uuid(), filename: z.string().min(1).max(240) }).strict(),
  'mod.favorite': z.object({ projectId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), favorite: z.boolean() }).strict(),
  'mod.favorites': z.undefined(),
} as const;
