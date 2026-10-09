import { z } from 'zod';
import type { ContentFile } from './smart.ts';

export const libraryModSchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/), file: z.string().regex(/^[a-f0-9]{64}\.jar$/), size: z.number().int().positive(), originalName: z.string().min(1).max(240),
  id: z.string().max(120).optional(), name: z.string().min(1).max(200), version: z.string().max(120).optional(), description: z.string().max(1000).optional(), authors: z.array(z.string().max(120)).max(30).default([]),
  loaders: z.array(z.enum(['fabric', 'forge', 'neoforge'])).max(3).default([]), minecraftVersions: z.array(z.string().regex(/^\d+(?:\.\d+){1,2}$/)).max(50).default([]), minecraftRange: z.string().max(120).optional(),
  dependencies: z.array(z.object({ id: z.string().max(120), range: z.string().max(120).optional(), optional: z.boolean().default(false) }).strict()).max(100).default([]), conflicts: z.array(z.string().max(120)).max(100).default([]), metadata: z.enum(['fabric', 'forge', 'neoforge', 'legacy-forge', 'unknown']),
  source: z.object({ projectId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), versionId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), url: z.string().url(), hash: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{128})$/), algorithm: z.enum(['sha1', 'sha512']) }).strict().optional(), importedAt: z.number().int(),
}).strict();
export type LibraryMod = z.infer<typeof libraryModSchema>;
export type LibraryCompatibility = 'compatible' | 'incompatible' | 'unknown';
export type LibraryModView = LibraryMod & { compatibility: LibraryCompatibility; reason?: string; usedBy: string[]; duplicate?: boolean; valid?: boolean; error?: string };
export type LibraryCollection = { id: string; name: string; description: string; hashes: string[]; createdAt: number; updatedAt: number };
export type LibraryModpack = { id: string; name: string; summary: string; minecraft: string; loader: 'vanilla' | 'fabric' | 'forge' | 'neoforge'; loaderVersion: string; hashes: string[]; createdAt: number; updatedAt: number };
export type LibrarySnapshot = { mods: LibraryModView[]; collections: LibraryCollection[]; modpacks: LibraryModpack[] };
export type LibraryScan = { jobId: string; candidates: LibraryModView[]; rejected: number };
export type LibraryApplyPlan = { planId: string; instanceId: string; files: { hash: string; name: string; size: number }[]; warnings: string[]; totalBytes: number };

export const libraryCommands = {
  'library.list': z.undefined(),
  'library.scan.files': z.undefined(), 'library.scan.folder': z.undefined(),
  'library.import.commit': z.object({ jobId: z.string().uuid(), hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(200) }).strict(),
  'library.collection.create': z.object({ name: z.string().trim().min(1).max(60), description: z.string().trim().max(300), hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(500) }).strict(),
  'library.collection.update': z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(60), description: z.string().trim().max(300), hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(500) }).strict(),
  'library.collection.delete': z.string().uuid(), 'library.delete': z.string().regex(/^[a-f0-9]{64}$/),
  'library.apply.plan': z.object({ instanceId: z.string().uuid(), hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(100), allowUnknown: z.boolean() }).strict(),
  'library.apply': z.string().uuid(),
  'library.instance.remove': z.object({ instanceId: z.string().uuid(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  'library.save.modrinth': z.object({ instanceId: z.string().uuid(), projectId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }).strict(),
  'library.modpack.create': z.object({ instanceId: z.string().uuid(), name: z.string().trim().min(1).max(80), summary: z.string().trim().max(300), hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(100) }).strict(),
  'library.modpack.delete': z.string().uuid(), 'library.modpack.import': z.undefined(),
  'library.modpack.export': z.object({ id: z.string().uuid(), format: z.enum(['matrixpack', 'mrpack']) }).strict(),
} as const;

export type LibraryResults = {
  'library.list': LibrarySnapshot; 'library.scan.files': LibraryScan | undefined; 'library.scan.folder': LibraryScan | undefined;
  'library.import.commit': { imported: number; duplicates: number }; 'library.collection.create': LibraryCollection; 'library.collection.update': LibraryCollection; 'library.collection.delete': void; 'library.delete': void;
  'library.apply.plan': LibraryApplyPlan; 'library.apply': void;
  'library.instance.remove': void;
  'library.save.modrinth': { imported: number; duplicates: number };
  'library.modpack.create': LibraryModpack; 'library.modpack.delete': void; 'library.modpack.import': LibraryModpack | undefined; 'library.modpack.export': void;
};
