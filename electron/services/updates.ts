import { app } from 'electron';
import updater from 'electron-updater';
import type { UpdateState } from '../../shared/contracts.ts';
import { secureUrl, friendlyError } from './security.ts';
const { autoUpdater } = updater;
export class Updates {
  state: UpdateState = { status: 'disabled', message: 'Canal de atualizações ainda não configurado pelo distribuidor' };
  constructor(url: string, publisher: string, private changed: () => void) {
    if (!url || !publisher || !app.isPackaged || process.platform !== 'win32') return;
    const feed = secureUrl(url);
    autoUpdater.netSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
      try { secureUrl(details.url, [feed.hostname]); callback({ cancel: false }); }
      catch { callback({ cancel: true }); }
    });
    autoUpdater.setFeedURL({ provider: 'generic', url });
    autoUpdater.autoDownload = false; autoUpdater.autoInstallOnAppQuit = false; autoUpdater.allowDowngrade = false;
    // Windows updater requires publisherName in the generated app-update.yml and verifies Authenticode.
    this.state = { status: 'idle' };
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking' }));
    autoUpdater.on('update-available', info => {
      try {
        if (!info.files.length) throw new Error('Atualização sem arquivos');
        for (const file of info.files) { secureUrl(new URL(file.url, `${feed.href.replace(/\/$/, '')}/`).href, [feed.hostname]); if (!/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)) throw new Error('Hash de atualização inválido'); }
        this.set({ status: 'available', version: info.version });
      } catch (e) { this.set({ status: 'error', message: friendlyError(e) }); }
    });
    autoUpdater.on('update-not-available', () => this.set({ status: 'idle', message: 'Você está usando a versão mais recente' }));
    autoUpdater.on('download-progress', p => this.set({ status: 'downloading', percent: p.percent }));
    autoUpdater.on('update-downloaded', info => this.set({ status: 'ready', version: info.version }));
    autoUpdater.on('error', error => this.set({ status: 'error', message: friendlyError(error) }));
  }
  private set(state: UpdateState): void { this.state = state; this.changed(); }
  async check(): Promise<void> { if (this.state.status === 'disabled') throw new Error(this.state.message); await autoUpdater.checkForUpdates(); }
  async download(): Promise<void> { if (this.state.status !== 'available') throw new Error('Verifique se há uma atualização disponível'); await autoUpdater.downloadUpdate(); }
  apply(): void { if (this.state.status !== 'ready') throw new Error('Atualização ainda não foi baixada e verificada'); autoUpdater.quitAndInstall(false, true); }
}
