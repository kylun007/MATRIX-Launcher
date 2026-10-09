import { app } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import updater from 'electron-updater';
import distribution from '../../config/distribution.json';
import type { UpdateState } from '../../shared/contracts.ts';
import { friendlyError } from './security.ts';
import { GitHubSignedManifestProvider } from './signed-update.ts';

const { autoUpdater } = updater;
export class Updates {
  state: UpdateState = { status: 'disabled', message: 'Atualizações assinadas ainda não foram configuradas para esta distribuição.' };
  private checking?: Promise<void>;
  private channel: 'stable' | 'beta' = 'stable';

  constructor(private changed: () => void) {
    // Fail closed unless this build ships a pinned Ed25519 key and a public update destination.
    const appImage = process.platform === 'linux' && !!process.env.APPIMAGE;
    if (process.platform === 'linux' && !appImage) this.state = { status: 'disabled', message: 'Atualizações automáticas estão disponíveis apenas na versão AppImage. Atualize pacotes DEB/RPM pelo método de instalação da sua distribuição.' };
    if (!app.isPackaged || (process.platform !== 'win32' && !appImage) || !existsSync(join(process.resourcesPath, 'app-update.yml')) || !distribution.githubOwner || !distribution.githubRepo || !distribution.updateManifestPublicKey) return;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', channel: this.channel }));
    autoUpdater.on('update-available', info => this.set({ status: 'available', version: info.version, channel: this.channel, checkedAt: Date.now(), releaseDate: info.releaseDate, releaseNotes: this.notes(info.releaseNotes) }));
    autoUpdater.on('update-not-available', info => this.set({ status: 'idle', version: info.version, channel: this.channel, checkedAt: Date.now(), message: 'Você está usando a versão mais recente.' }));
    autoUpdater.on('download-progress', progress => this.set({ status: 'downloading', version: this.state.version, channel: this.channel, percent: progress.percent, transferred: progress.transferred, total: progress.total, bytesPerSecond: progress.bytesPerSecond }));
    autoUpdater.on('update-downloaded', info => this.set({ status: 'ready', version: info.version, channel: this.channel, releaseDate: info.releaseDate, releaseNotes: this.notes(info.releaseNotes), percent: 100 }));
    autoUpdater.on('error', error => this.set({ status: 'error', channel: this.channel, checkedAt: Date.now(), message: friendlyError(error) }));
    this.state = { status: 'idle', channel: 'stable' };
  }

  private notes(value: string | Array<{ note?: string | null }> | null | undefined): string | undefined {
    if (typeof value === 'string') return value.slice(0, 12000);
    if (Array.isArray(value)) return value.map(item => item.note ?? '').filter(Boolean).join('\n').slice(0, 12000) || undefined;
    return undefined;
  }
  private set(state: UpdateState): void { this.state = state; this.changed(); }
  confirmRestart(expected: string, installed: string): void {
    this.set(expected === installed
      ? { status: 'idle', checkedAt: Date.now(), message: `Atualização para ${installed} aplicada e iniciada.` }
      : { status: 'error', checkedAt: Date.now(), message: `Não foi possível confirmar a atualização para ${expected}. A versão atual é ${installed}.` });
  }

  async check(channel: 'stable' | 'beta' = 'stable'): Promise<void> {
    if (this.state.status === 'disabled') throw new Error(this.state.message);
    if (this.state.status === 'checking' || this.state.status === 'downloading' || this.state.status === 'ready') return;
    if (this.checking) return this.checking;
    if (this.state.status === 'available' && this.state.channel === channel) return;
    this.channel = channel;
    // Verify the signed manifest before electron-updater receives metadata or downloads a package.
    autoUpdater.setFeedURL({
      provider: 'custom', url: 'https://github.com', channel,
      owner: distribution.githubOwner, repo: distribution.githubRepo,
      publicKey: distribution.updateManifestPublicKey,
      platform: process.platform === 'linux' ? 'linux' : 'windows',
      updateProvider: GitHubSignedManifestProvider,
    } as never);
    autoUpdater.channel = channel === 'stable' ? 'latest' : 'beta';
    autoUpdater.allowPrerelease = channel === 'beta';
    autoUpdater.allowDowngrade = false;
    this.checking = autoUpdater.checkForUpdates().then(() => { if (this.state.status === 'checking') this.set({ status: 'idle', channel, checkedAt: Date.now() }); })
      .catch(error => { this.set({ status: 'error', channel, checkedAt: Date.now(), message: friendlyError(error) }); throw error; })
      .finally(() => { this.checking = undefined; });
    return this.checking;
  }
  async download(): Promise<void> {
    if (this.state.status !== 'available') throw new Error('Verifique se há uma atualização disponível');
    try { await autoUpdater.downloadUpdate(); }
    catch (error) { this.set({ status: 'error', channel: this.channel, message: friendlyError(error) }); throw error; }
  }
  apply(): void {
    if (this.state.status !== 'ready') throw new Error('Atualização ainda não foi baixada e verificada');
    autoUpdater.quitAndInstall(false, true);
  }
}
