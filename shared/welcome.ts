export type WelcomeStatus = 'notStarted' | 'inProgress' | 'skipped' | 'completed';
export type WelcomeProgress = { version: 1; status: WelcomeStatus; step: number; contextualTips: boolean; animations: boolean; tipsSeen: string[] };
export const welcomeDefaults: WelcomeProgress = { version: 1, status: 'notStarted', step: 0, contextualTips: true, animations: true, tipsSeen: [] };

export function parseWelcomeProgress(raw: string | null): WelcomeProgress {
  if (!raw) return { ...welcomeDefaults };
  try {
    const value = JSON.parse(raw) as Partial<WelcomeProgress>;
    if (value.version !== 1 || !['notStarted', 'inProgress', 'skipped', 'completed'].includes(value.status ?? '') || !Number.isInteger(value.step) || (value.step ?? -1) < 0 || (value.step ?? 0) > 5) return { ...welcomeDefaults };
    if (value.contextualTips !== undefined && typeof value.contextualTips !== 'boolean' || value.animations !== undefined && typeof value.animations !== 'boolean' || value.tipsSeen !== undefined && (!Array.isArray(value.tipsSeen) || value.tipsSeen.length > 30 || value.tipsSeen.some(x => typeof x !== 'string' || x.length > 40))) return { ...welcomeDefaults };
    return { ...welcomeDefaults, ...value } as WelcomeProgress;
  } catch { return { ...welcomeDefaults }; }
}

/** Legacy users keep their existing account/instance flow; no migration touches those records. */
export function shouldAutoWelcome(progress: WelcomeProgress, hasExistingSetup: boolean): boolean {
  return !hasExistingSetup && (progress.status === 'notStarted' || progress.status === 'inProgress');
}
