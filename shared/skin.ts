import { z } from 'zod';

export const skinModel = z.enum(['classic', 'slim']);
export type SkinModel = z.infer<typeof skinModel>;
export type BodyPart = 'head' | 'body' | 'rightArm' | 'leftArm' | 'rightLeg' | 'leftLeg';
export type SkinLayer = 'base' | 'outer';
export const skinCameraSchema = z.object({
  rotateSensitivity: z.number().min(0.25).max(2.5), panSensitivity: z.number().min(0.25).max(2.5),
  zoomSensitivity: z.number().min(0.25).max(2.5), zoomToCursor: z.boolean(), smooth: z.boolean(),
  invertRotation: z.boolean(), showGizmo: z.boolean(),
}).strict().default({ rotateSensitivity: 1, panSensitivity: 1, zoomSensitivity: 1, zoomToCursor: true, smooth: true, invertRotation: false, showGizmo: true });
export type SkinCameraSettings = z.infer<typeof skinCameraSchema>;
export const skinDocumentSchema = z.object({
  name: z.string().trim().min(1).max(80), model: skinModel,
  pixels: z.string().regex(/^[A-Za-z0-9+/]{21846}==$/, 'Textura RGBA 64×64 inválida'),
  palette: z.array(z.string().regex(/^#[a-fA-F0-9]{6}$/)).max(64),
}).strict();
export const skinProjectSchema = skinDocumentSchema.extend({
  schemaVersion: z.literal(1), id: z.string().uuid(), revision: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
}).strict();
export type SkinDocument = z.infer<typeof skinDocumentSchema>;
export type SkinProject = z.infer<typeof skinProjectSchema>;
export type SkinEntry = Omit<SkinProject, 'pixels'> & { thumbnail: string };
export const skinSaveSchema = z.object({ document: skinDocumentSchema, id: z.string().uuid().optional(), revision: z.number().int().nonnegative().optional() }).strict();
export type SkinSave = z.infer<typeof skinSaveSchema>;
export const skinDraftSchema = z.object({ document: skinDocumentSchema, projectId: z.string().uuid().optional(), revision: z.number().int().nonnegative().optional(), savedAt: z.number().int().nonnegative() }).strict();
export type SkinDraft = z.infer<typeof skinDraftSchema>;
export const skinCommands = {
  'skin.camera': skinCameraSchema,
  'skin.editor.active': z.boolean(), 'skin.editor.close': z.undefined(),
  'skin.list': z.undefined(), 'skin.open': z.string().uuid(), 'skin.save': skinSaveSchema,
  'skin.rename': z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(80) }).strict(),
  'skin.duplicate': z.string().uuid(), 'skin.delete': z.string().uuid(),
  'skin.import': z.undefined(), 'skin.project.import': z.undefined(),
  'skin.export': z.object({ document: skinDocumentSchema, format: z.enum(['png', 'project']) }).strict(),
  'skin.preview.export': z.object({ png: z.string().max(6_000_000) }).strict(),
  'skin.draft.get': z.undefined(), 'skin.draft.save': skinDraftSchema, 'skin.draft.clear': z.undefined(),
  'skin.account.import': z.string().uuid(),
  'skin.account.assign': z.object({ accountId: z.string().uuid(), projectId: z.string().uuid() }).strict(),
  'skin.account.apply': z.object({ accountId: z.string().uuid(), document: skinDocumentSchema }).strict(),
} as const;
export type SkinResults = {
  'skin.camera': SkinCameraSettings;
  'skin.editor.active': void; 'skin.editor.close': void;
  'skin.list': SkinEntry[]; 'skin.open': SkinProject; 'skin.save': SkinProject;
  'skin.rename': SkinProject; 'skin.duplicate': SkinProject; 'skin.delete': void;
  'skin.import': SkinDocument | undefined; 'skin.project.import': SkinDocument | undefined;
  'skin.export': string | undefined; 'skin.preview.export': string | undefined;
  'skin.draft.get': SkinDraft | undefined; 'skin.draft.save': void; 'skin.draft.clear': void;
  'skin.account.import': SkinDocument; 'skin.account.assign': void; 'skin.account.apply': boolean;
};
