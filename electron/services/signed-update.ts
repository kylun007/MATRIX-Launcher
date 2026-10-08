import { createPublicKey, verify } from 'node:crypto';
import { basename } from 'node:path';
import { Provider, parseUpdateInfo, resolveFiles } from 'electron-updater/out/providers/Provider.js';
import type { AppUpdater } from 'electron-updater';
import type { UpdateInfo } from 'electron-updater';
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider.js';

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SIGNATURE_BYTES = 256;
const API = 'https://api.github.com';
type FeedChannel = 'stable' | 'beta';
interface GitHubAsset { name: string; browser_download_url: string }
interface GitHubRelease {
  tag_name: string;
  prerelease: boolean;
  draft: boolean;
  published_at: string;
  body?: string;
  assets: GitHubAsset[];
}
export interface SignedFeedOptions {
  owner: string;
  repo: string;
  channel: FeedChannel;
  publicKey: string;
}
function isDirectReleaseAsset(target: URL, directory: URL): boolean {
  if (target.origin !== directory.origin || !target.pathname.startsWith(directory.pathname)) return false;
  const filename = target.pathname.slice(directory.pathname.length);
  return filename.length > 0 && !filename.includes('/');
}

export function verifySignedManifest(raw: string, signatureText: string, publicKeyPem: string): boolean {
  if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_MANIFEST_BYTES) return false;
  const encoded = signatureText.trim();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(encoded)) return false;
  const signature = Buffer.from(encoded, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== encoded) return false;
  try { return verify(null, Buffer.from(raw, 'utf8'), createPublicKey(publicKeyPem), signature); }
  catch { return false; }
}

export function validateManifestInfo(info: Pick<UpdateInfo, 'version' | 'files'>, tag: string, assetDirectory: URL): void {
  if (!info.version || tag !== `v${info.version}` || !Array.isArray(info.files) || info.files.length === 0) throw new Error('Manifesto assinado não corresponde à versão da release');
  for (const file of info.files) {
    if (typeof file.url !== 'string' || basename(file.url) !== file.url || file.url === '.' || file.url === '..' || file.url.includes('\\') || !file.url.toLowerCase().endsWith('.exe') || !/^[A-Za-z0-9_. -]+$/.test(file.url)) throw new Error('Manifesto contém um caminho de arquivo inválido');
    if (typeof file.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512) || typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size <= 0) throw new Error('Manifesto contém hash ou tamanho inválido');
    const target = new URL(file.url, assetDirectory);
    if (!isDirectReleaseAsset(target, assetDirectory)) throw new Error('Arquivo de atualização fora da release validada');
  }
}

function validAssetUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password) throw new Error('URL de atualização inválida');
  return url;
}

export class GitHubSignedManifestProvider extends Provider<UpdateInfo> {
  private assetDirectory?: URL;
  constructor(private readonly config: SignedFeedOptions, _updater: AppUpdater, runtime: ProviderRuntimeOptions) { super(runtime); }

  private async json<T>(url: URL): Promise<T> {
    const raw = await this.httpRequest(url, { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'MATRIX-Launcher' });
    if (!raw || Buffer.byteLength(raw) > 2_000_000) throw new Error('Resposta inválida do GitHub Releases');
    return JSON.parse(raw) as T;
  }

  private async findRelease(): Promise<GitHubRelease> {
    const { owner, repo, channel } = this.config;
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) throw new Error('Destino do atualizador inválido');
    const endpoint = channel === 'stable'
      ? `${API}/repos/${owner}/${repo}/releases/latest`
      : `${API}/repos/${owner}/${repo}/releases?per_page=100`;
    const response = await this.json<GitHubRelease | GitHubRelease[]>(new URL(endpoint));
    const release = Array.isArray(response)
      ? response.filter(item => item.prerelease && !item.draft && Number.isFinite(Date.parse(item.published_at))).sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0]
      : response;
    if (!release || release.draft || (channel === 'beta' && !release.prerelease) || (channel === 'stable' && release.prerelease)) throw new Error(`Nenhuma versão ${channel} publicada foi encontrada`);
    return release;
  }

  async getLatestVersion(): Promise<UpdateInfo> {
    const release = await this.findRelease();
    const channelFile = this.config.channel === 'stable' ? 'latest.yml' : 'beta.yml';
    const manifestAsset = release.assets.find(asset => asset.name === channelFile);
    const signatureAsset = release.assets.find(asset => asset.name === `${channelFile}.sig`);
    if (!manifestAsset || !signatureAsset) throw new Error('Release não contém o manifesto assinado e sua assinatura');
    const manifestUrl = validAssetUrl(manifestAsset.browser_download_url);
    const signatureUrl = validAssetUrl(signatureAsset.browser_download_url);
    if (manifestUrl.origin !== signatureUrl.origin || manifestUrl.pathname.slice(0, manifestUrl.pathname.lastIndexOf('/') + 1) !== signatureUrl.pathname.slice(0, signatureUrl.pathname.lastIndexOf('/') + 1)) throw new Error('Arquivos de atualização vieram de destinos diferentes');
    const expectedDirectory = `/${this.config.owner}/${this.config.repo}/releases/download/${release.tag_name}/`;
    if (!manifestUrl.pathname.startsWith(expectedDirectory) || !manifestUrl.pathname.endsWith(`/${channelFile}`) || !signatureUrl.pathname.endsWith(`/${channelFile}.sig`)) throw new Error('Manifesto está fora do diretório da tag publicada');
    const [manifest, signature] = await Promise.all([this.httpRequest(manifestUrl), this.httpRequest(signatureUrl)]);
    if (!manifest || !signature || Buffer.byteLength(signature) > MAX_SIGNATURE_BYTES || !verifySignedManifest(manifest, signature, this.config.publicKey)) throw new Error('Assinatura Ed25519 do manifesto inválida; atualização recusada');
    const info = parseUpdateInfo(manifest, channelFile, manifestUrl) as UpdateInfo;
    this.assetDirectory = new URL('.', manifestUrl);
    validateManifestInfo(info, release.tag_name, this.assetDirectory);
    return { ...info, releaseDate: release.published_at, releaseNotes: release.body?.slice(0, 12000) };
  }

  resolveFiles(info: UpdateInfo) {
    if (!this.assetDirectory) throw new Error('Manifesto ainda não foi validado');
    const resolved = resolveFiles(info, this.assetDirectory);
    if (resolved.some(file => !isDirectReleaseAsset(file.url, this.assetDirectory!))) throw new Error('Arquivo de atualização fora da release validada');
    return resolved;
  }
}
