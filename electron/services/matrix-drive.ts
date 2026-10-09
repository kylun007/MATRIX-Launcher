import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm, stat, statfs, rename } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { open as openZip, openEntryReadStream, walkEntriesGenerator } from '@xmcl/unzip';
import { ZipFile } from 'yazl';
import { z } from 'zod';
import type { Vault } from './auth.ts';
import { noLinks, safePath } from './security.ts';
import type { MatrixDriveBackup, MatrixDriveState } from '../../shared/matrix-account.ts';
import { sendOAuthCallbackPage } from './oauth-callback-page.ts';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const MAX_FILES = 20_000;
const MAX_BYTES = 30 * 1024 ** 3;
const CHUNK_BYTES = 8 * 1024 ** 2;
const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), expires_in: z.number().positive(), scope: z.string().optional() }).passthrough();
const sessionSchema = tokenSchema.extend({ refresh_token: z.string().min(1), expires_at: z.number().int() });
const driveFileSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{5,200}$/), name: z.string().max(240), size: z.string().optional(), createdTime: z.string().optional(), mimeType: z.string().optional() }).passthrough();
type Session = z.infer<typeof sessionSchema>;
type Progress = (label: string, bytes: number, total: number, speed: number) => void;
type VaultLike = Pick<Vault, 'getSecureValue' | 'setSecureValue' | 'remove'>;
type BackupSource = { path: string; name: string; size: number; mtimeMs: number };

function safeZipSegment(value: string): string {
  const safe = value.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/g, '_').trim();
  if (!safe || safe === '.' || safe === '..') return '_';
  return safe.slice(0, 180);
}

export class MatrixDriveService {
  private readonly sessionKey = 'matrix-drive-session';
  private readonly folderKey = 'matrix-drive-backup-folder';
  private session?: Session;
  private readonly clientId: string;

  constructor(config: { googleDriveClientId?: string }, private readonly vault: VaultLike, private readonly openExternal: (url: string) => Promise<unknown>, private readonly tempRoot = tmpdir(), private readonly fetcher: typeof fetch = fetch, private readonly exchangeToken?: (values: Record<string, string>) => Promise<Response>) {
    this.clientId = (config.googleDriveClientId ?? '').trim();
  }

  state(): MatrixDriveState { return { configured: this.clientId.endsWith('.apps.googleusercontent.com') && !!this.exchangeToken, connected: !!this.session }; }

  async restoreSession(): Promise<MatrixDriveState> {
    if (!this.state().configured) return this.state();
    const saved = await this.vault.getSecureValue<Session>(this.sessionKey);
    const parsed = sessionSchema.safeParse(saved);
    if (parsed.success) this.session = parsed.data;
    else if (saved) await this.vault.remove(this.sessionKey);
    return this.state();
  }

  async connect(): Promise<void> {
    if (!this.state().configured) throw new Error('Google Drive ainda não foi configurado. Confira o OAuth Desktop e publique a função matrix-drive-token no Supabase.');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(32).toString('base64url');
    // Google Desktop OAuth uses the loopback IP redirect; the unpredictable state protects the callback.
    const callbackPath = '/';
    let server: Server | undefined;
    let callbackResponse: ServerResponse | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolveCode, reject) => {
        let completed = false;
        server = createServer((request, response) => {
          const port = (server!.address() as { port: number }).port;
          const host = request.headers.host;
          let target: URL;
          try { target = new URL(request.url ?? '/', `http://${host ?? 'invalid'}`); }
          catch { response.writeHead(400).end(); return; }
          if (completed || host !== `127.0.0.1:${port}` || target.pathname !== callbackPath) { response.writeHead(404).end(); return; }
          const received = Buffer.from(target.searchParams.get('state') ?? ''); const expected = Buffer.from(state);
          if (received.length !== expected.length || !timingSafeEqual(received, expected)) { response.writeHead(400).end('Retorno Google inválido.'); reject(new Error('Validação de segurança do login Drive falhou. Tente novamente.')); return; }
          completed = true;
          const providerError = target.searchParams.get('error'); const code = target.searchParams.get('code');
          callbackResponse = response;
          if (providerError || !code || code.length >= 4096) sendOAuthCallbackPage(response, 'drive', false);
          if (providerError) reject(new Error('A autorização do Google Drive foi cancelada ou recusada.'));
          else if (code && code.length < 4096) resolveCode({ code, redirectUri: `http://127.0.0.1:${port}` });
          else reject(new Error('Google não retornou um código de autorização válido.'));
        });
        server.on('error', reject);
        server.listen(0, '127.0.0.1', async () => {
          const port = (server!.address() as { port: number }).port;
          const redirectUri = `http://127.0.0.1:${port}`;
          const authorize = new URL('https://accounts.google.com/o/oauth2/v2/auth');
          for (const [key, value] of Object.entries({ client_id: this.clientId, redirect_uri: redirectUri, response_type: 'code', scope: DRIVE_SCOPE, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', code_challenge: challenge, code_challenge_method: 'S256', state })) authorize.searchParams.set(key, value);
          timer = setTimeout(() => reject(new Error('A autorização Google Drive expirou. Inicie novamente.')), 180_000); timer.unref();
          try { await this.openExternal(authorize.toString()); } catch { reject(new Error('Não foi possível abrir o navegador padrão.')); }
        });
      });
      const token = await this.tokenRequest({ client_id: this.clientId, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri });
      if (!token.refresh_token) throw new Error('Google não devolveu um token de renovação. Revogue a autorização do MATRIX nas permissões da Conta Google e tente conectar novamente.');
      if (token.scope && !token.scope.split(' ').includes(DRIVE_SCOPE)) throw new Error('A autorização não concedeu o acesso Drive limitado solicitado.');
      const session = { ...token, refresh_token: token.refresh_token, expires_at: Date.now() + token.expires_in * 1000 };
      await this.vault.setSecureValue(this.sessionKey, session); this.session = session;
      if (callbackResponse) sendOAuthCallbackPage(callbackResponse, 'drive', true);
    } catch (error) {
      if (callbackResponse) sendOAuthCallbackPage(callbackResponse, 'drive', false);
      throw error;
    } finally { if (timer) clearTimeout(timer); server?.close(); }
  }

  async disconnect(): Promise<void> {
    this.session = undefined;
    await this.vault.remove(this.sessionKey);
    await this.vault.remove(this.folderKey);
  }

  private async tokenRequest(values: Record<string, string>): Promise<z.infer<typeof tokenSchema>> {
    if (!this.exchangeToken) throw new Error('O backend seguro do Google Drive ainda não foi configurado.');
    const response = await this.exchangeToken(values);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const details = z.object({ error: z.string().regex(/^[a-z_]{1,50}$/).optional(), error_description: z.string().max(2000).optional() }).safeParse(payload);
      const code = details.success ? details.data.error : undefined;
      const hints: Record<string, string> = {
        matrix_login_required: 'Entre novamente na Conta MATRIX antes de conectar o Drive.',
        drive_server_not_configured: 'Cadastre GOOGLE_DRIVE_CLIENT_ID e GOOGLE_DRIVE_CLIENT_SECRET nos Secrets do Supabase.',
        rate_limited: 'Muitas tentativas. Aguarde um minuto antes de tentar novamente.',
        service_unavailable: 'O serviço de autorização está indisponível. Tente novamente em alguns instantes.',
        auth_unavailable: 'A autenticação MATRIX está temporariamente indisponível.',
        invalid_grant: 'O código expirou ou o retorno não corresponde ao cliente. Inicie uma nova autorização.',
        invalid_client: 'O Google não reconheceu este cliente OAuth. O administrador precisa conferir o cliente Desktop.',
        access_denied: 'Acesso recusado. Confira o consentimento e os usuários de teste no Google Cloud.',
        redirect_uri_mismatch: 'O cliente deve ser do tipo Desktop, com retorno local autorizado.',
      };
      const missingClientAuth = details.success && /client_secret.*(?:missing|required)|(?:missing|required).*client_secret/i.test(details.data.error_description ?? '');
      const hint = response.status === 404 ? 'Publique a Edge Function matrix-drive-token no projeto Supabase configurado.' : missingClientAuth ? 'O Google exige autenticação adicional deste cliente OAuth. O administrador precisa revisar a integração do Drive.' : hints[code ?? ''] ?? 'Não foi possível concluir a autorização. Tente novamente; se persistir, informe este código ao administrador.';
      throw new Error(`Google Drive: ${code ?? 'erro de autorização'} (HTTP ${response.status}). ${hint}`);
    }
    return tokenSchema.parse(payload);
  }

  private async accessToken(): Promise<string> {
    if (!this.session) throw new Error('Conecte o Google Drive antes de continuar.');
    if (this.session.expires_at > Date.now() + 60_000) return this.session.access_token;
    const renewed = await this.tokenRequest({ client_id: this.clientId, refresh_token: this.session.refresh_token, grant_type: 'refresh_token' });
    this.session = { ...renewed, refresh_token: renewed.refresh_token ?? this.session.refresh_token, expires_at: Date.now() + renewed.expires_in * 1000 };
    await this.vault.setSecureValue(this.sessionKey, this.session);
    return this.session.access_token;
  }

  private async authorizedFetch(url: string | URL, init: RequestInit = {}, retry = true): Promise<Response> {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.hostname !== 'www.googleapis.com' || target.username || target.password) throw new Error('Destino Google Drive não autorizado.');
    const token = await this.accessToken();
    const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${token}`);
    const response = await this.fetcher(target, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(60_000), redirect: 'manual' });
    if (response.status === 401 && retry && this.session) {
      this.session.expires_at = 0;
      return this.authorizedFetch(target, init, false);
    }
    return response;
  }

  private async apiJson<T>(url: string | URL, init: RequestInit = {}): Promise<T> {
    const response = await this.authorizedFetch(url, init);
    if (!response.ok) throw new Error(`Google Drive falhou ao processar a solicitação (HTTP ${response.status}).`);
    return await response.json() as T;
  }

  private async backupFolder(): Promise<string> {
    const stored = await this.vault.getSecureValue<string>(this.folderKey);
    if (stored && /^[A-Za-z0-9_-]{5,200}$/.test(stored)) return stored;
    const query = new URLSearchParams({ q: "name = 'MATRIX Launcher Backups' and mimeType = 'application/vnd.google-apps.folder' and trashed = false", pageSize: '10', fields: 'files(id,name,mimeType)' });
    const found = await this.apiJson<{ files?: unknown[] }>(`https://www.googleapis.com/drive/v3/files?${query}`);
    const existing = (found.files ?? []).map(item => driveFileSchema.safeParse(item)).find(result => result.success && result.data.mimeType === 'application/vnd.google-apps.folder');
    if (existing?.success) { await this.vault.setSecureValue(this.folderKey, existing.data.id); return existing.data.id; }
    const created = driveFileSchema.parse(await this.apiJson('https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'MATRIX Launcher Backups', mimeType: 'application/vnd.google-apps.folder' }) }));
    await this.vault.setSecureValue(this.folderKey, created.id);
    return created.id;
  }

  async list(): Promise<MatrixDriveBackup[]> {
    const folder = await this.backupFolder();
    const query = new URLSearchParams({ q: `'${folder}' in parents and trashed = false`, pageSize: '1000', orderBy: 'createdTime desc', fields: 'files(id,name,size,createdTime,mimeType)' });
    const result = await this.apiJson<{ files?: unknown[] }>(`https://www.googleapis.com/drive/v3/files?${query}`);
    return (result.files ?? []).map(item => driveFileSchema.parse(item)).filter(file => file.mimeType === 'application/zip' && file.name.startsWith('MATRIX Backup ')).map(file => ({ id: file.id, name: file.name, size: Number(file.size ?? 0), ...(file.createdTime ? { createdAt: file.createdTime } : {}) }));
  }

  private async scanSources(paths: string[]): Promise<BackupSource[]> {
    if (!paths.length || paths.length > 50) throw new Error('Selecione entre 1 e 50 arquivos ou pastas para o backup.');
    const output: BackupSource[] = []; let bytes = 0;
    const names = new Set<string>();
    const addFile = async (path: string, archiveName: string): Promise<void> => {
      const info = await lstat(path);
      if (info.isSymbolicLink()) return;
      if (!info.isFile()) return;
      if (info.size > MAX_BYTES || bytes + info.size > MAX_BYTES) throw new Error('O backup excede o limite local de 30 GiB. Escolha menos arquivos.');
      const pathName = archiveName.split('/').map(safeZipSegment).join('/');
      if (names.has(pathName)) throw new Error('Dois arquivos selecionados resultam no mesmo nome dentro do backup. Selecione pastas separadas.');
      names.add(pathName); bytes += info.size; output.push({ path, name: pathName, size: info.size, mtimeMs: info.mtimeMs });
      if (output.length > MAX_FILES) throw new Error('O backup contém mais de 20.000 arquivos. Escolha uma pasta menor.');
    };
    const visit = async (path: string, archiveName: string, depth: number): Promise<void> => {
      if (depth > 64) throw new Error('A pasta selecionada é profunda demais para criar um backup seguro.');
      const info = await lstat(path);
      if (info.isSymbolicLink()) return;
      if (info.isFile()) { await addFile(path, archiveName); return; }
      if (!info.isDirectory()) return;
      for (const child of await readdir(path, { withFileTypes: true })) {
        if (child.isSymbolicLink()) continue;
        await visit(join(path, child.name), `${archiveName}/${child.name}`, depth + 1);
      }
    };
    for (let i = 0; i < paths.length; i++) {
      const input = paths[i]!; const rootInfo = await lstat(input);
      if (rootInfo.isSymbolicLink()) throw new Error('Pastas ou arquivos vinculados não entram em backups.');
      const canonical = await realpath(input); const info = await lstat(canonical);
      if (!info.isFile() && !info.isDirectory()) continue;
      const rootName = safeZipSegment(basename(canonical) || `seleção-${i + 1}`);
      const prefix = paths.length > 1 ? `${String(i + 1).padStart(2, '0')}-${rootName}` : rootName;
      if (info.isDirectory()) await visit(canonical, prefix, 0); else await addFile(canonical, prefix);
    }
    if (!output.length) throw new Error('Não encontrei arquivos regulares nos itens selecionados.');
    return output;
  }

  private async makeArchive(paths: string[], signal: AbortSignal): Promise<{ file: string; size: number }> {
    const sources = await this.scanSources(paths); signal.throwIfAborted();
    await mkdir(this.tempRoot, { recursive: true });
    const available = await statfs(this.tempRoot).then(s => s.bavail * s.bsize).catch(() => Number.MAX_SAFE_INTEGER);
    const totalInput = sources.reduce((sum, file) => sum + file.size, 0);
    if (available < totalInput + 128 * 1024 ** 2) throw new Error('Não há espaço livre suficiente para preparar o backup compactado.');
    for (const source of sources) {
      signal.throwIfAborted();
      const info = await lstat(source.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== source.size || info.mtimeMs !== source.mtimeMs) throw new Error(`O arquivo ${basename(source.path)} mudou durante a preparação do backup.`);
    }
    const file = join(this.tempRoot, `matrix-backup-${randomUUID()}.zip`);
    const zip = new ZipFile(); const output = createWriteStream(file, { flags: 'wx' });
    const manifestName = `__matrix_backup_${randomUUID()}.json`;
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString(), roots: [...new Set(sources.map(source => source.name.split('/')[0]))] }), 'utf8');
    try {
      await new Promise<void>((resolveOutput, rejectOutput) => {
        let finished = false;
        const fail = (error: Error) => { if (!finished) { finished = true; output.destroy(); rejectOutput(error); } };
        output.once('error', fail); zip.outputStream.once('error', fail);
        output.once('close', () => { if (!finished) { finished = true; resolveOutput(); } });
        zip.outputStream.pipe(output);
        for (const source of sources) zip.addFile(source.path, source.name, { compress: true });
        zip.addBuffer(manifest, manifestName, { compress: true });
        zip.end({ forceZip64Format: true });
      });
      const info = await stat(file); if (info.size > MAX_BYTES) throw new Error('O arquivo compactado excedeu o limite de 30 GiB.');
      return { file, size: info.size };
    } catch (error) { zip.outputStream.destroy(); await rm(file, { force: true }); throw error; }
  }

  async createBackup(paths: string[], signal: AbortSignal, progress: Progress): Promise<MatrixDriveBackup> {
    const archive = await this.makeArchive(paths, signal);
    try {
      const folder = await this.backupFolder(); signal.throwIfAborted();
      const filename = `MATRIX Backup ${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
      const start = await this.authorizedFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,createdTime,mimeType', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/zip', 'X-Upload-Content-Length': String(archive.size) }, body: JSON.stringify({ name: filename, mimeType: 'application/zip', parents: [folder], description: 'Backup manual criado pelo MATRIX Launcher.' }) });
      if (!start.ok) throw new Error(`Google Drive não iniciou o upload (HTTP ${start.status}).`);
      const location = start.headers.get('location');
      if (!location) throw new Error('Google Drive não forneceu uma sessão segura de upload.');
      const uploadUrl = new URL(location);
      if (uploadUrl.protocol !== 'https:' || uploadUrl.hostname !== 'www.googleapis.com') throw new Error('Destino do upload Google inválido.');
      const fileHandle = await open(archive.file, 'r'); let offset = 0; let final: unknown;
      const startedAt = Date.now();
      try {
        while (offset < archive.size) {
          signal.throwIfAborted();
          const length = Math.min(CHUNK_BYTES, archive.size - offset); const chunk = Buffer.allocUnsafe(length);
          const { bytesRead } = await fileHandle.read(chunk, 0, length, offset);
          if (bytesRead !== length) throw new Error('O arquivo de backup mudou durante o envio.');
          const end = offset + length - 1;
          const response = await this.authorizedFetch(uploadUrl, { method: 'PUT', redirect: 'manual', signal, headers: { 'Content-Type': 'application/zip', 'Content-Length': String(length), 'Content-Range': `bytes ${offset}-${end}/${archive.size}` }, body: chunk });
          if (response.status === 308) {
            const range = response.headers.get('range');
            if (range && !range.endsWith(`-${end}`)) throw new Error('Google Drive confirmou um intervalo inesperado no upload.');
            offset += length; progress('Enviando backup ao Google Drive', offset, archive.size, offset / Math.max((Date.now() - startedAt) / 1000, 1));
            continue;
          }
          if (!response.ok || offset + length !== archive.size) throw new Error(`Falha no envio do backup ao Google Drive (HTTP ${response.status}).`);
          final = await response.json(); offset += length; progress('Backup enviado ao Google Drive', offset, archive.size, offset / Math.max((Date.now() - startedAt) / 1000, 1));
        }
      } finally { await fileHandle.close(); }
      const created = driveFileSchema.parse(final);
      return { id: created.id, name: created.name, size: Number(created.size ?? archive.size), ...(created.createdTime ? { createdAt: created.createdTime } : {}) };
    } finally { await rm(archive.file, { force: true }); }
  }

  private async downloadBackup(id: string, destination: string, signal: AbortSignal): Promise<string> {
    const target = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`);
    const response = await this.authorizedFetch(target, { signal });
    if (!response.ok || !response.body) throw new Error(`Não foi possível baixar o backup (HTTP ${response.status}).`);
    const expected = Number(response.headers.get('content-length') ?? 0);
    if (expected > MAX_BYTES) throw new Error('O backup excede o limite seguro de 30 GiB.');
    let total = 0;
    const limiter = new Transform({ transform(chunk: Buffer, _encoding, done) { total += chunk.length; if (total > MAX_BYTES) done(new Error('O backup excede o limite seguro de 30 GiB.')); else done(null, chunk); } });
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>), limiter, createWriteStream(destination, { flags: 'wx' }), { signal });
    return destination;
  }

  async restoreBackup(id: string, destination: string, signal: AbortSignal, progress: Progress): Promise<void> {
    if (!/^[A-Za-z0-9_-]{5,200}$/.test(id)) throw new Error('Identificador de backup inválido.');
    const listed = await this.list(); if (!listed.some(backup => backup.id === id)) throw new Error('Backup não encontrado na pasta MATRIX do seu Google Drive.');
    await mkdir(this.tempRoot, { recursive: true });
    const zipPath = join(this.tempRoot, `matrix-restore-${randomUUID()}.zip`);
    let zip: Awaited<ReturnType<typeof openZip>> | undefined; let restored: string | undefined;
    try {
      await this.downloadBackup(id, zipPath, signal);
      const folder = resolve(destination); await mkdir(folder, { recursive: true });
      restored = join(folder, `MATRIX-Restaurado-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
      await mkdir(restored, { recursive: true }); await noLinks(restored, restored);
      zip = await openZip(zipPath, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true });
      if (zip.entryCount > MAX_FILES + 1) throw new Error('O backup tem entradas demais para restaurar com segurança.');
      let bytes = 0; let count = 0;
      for await (const entry of walkEntriesGenerator(zip)) {
        signal.throwIfAborted(); count++;
        if (count > MAX_FILES + 1) throw new Error('O backup excedeu o limite seguro de arquivos.');
        const name = entry.fileName;
        if (!name || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || /[\x00-\x1f]/.test(name)) throw new Error('O backup contém um caminho inválido.');
        const trimmed = name.endsWith('/') ? name.slice(0, -1) : name;
        if (!trimmed) continue;
        const target = safePath(restored, trimmed);
        const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (mode === 0xa000) throw new Error('Backups que contenham links simbólicos não podem ser restaurados.');
        if (name.startsWith('__matrix_backup_') && name.endsWith('.json')) continue;
        if (name.endsWith('/')) { await mkdir(target, { recursive: true }); await noLinks(restored, target); continue; }
        if (entry.uncompressedSize > MAX_BYTES || bytes + entry.uncompressedSize > MAX_BYTES || (entry.uncompressedSize > 1_000_000 && entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > 500)) throw new Error('O backup excede os limites seguros de descompactação.');
        bytes += entry.uncompressedSize; await mkdir(dirname(target), { recursive: true }); await noLinks(restored, target);
        const temp = `${target}.${randomUUID()}.tmp`; const stream = await openEntryReadStream(zip, entry);
        await pipeline(stream, createWriteStream(temp, { flags: 'wx' }), { signal }); await rename(temp, target);
        progress('Restaurando backup com segurança', bytes, 0, 0);
      }
    } catch (error) { if (restored) await rm(restored, { recursive: true, force: true }); throw error; }
    finally { zip?.close(); await rm(zipPath, { force: true }); }
  }

  async deleteBackup(id: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{5,200}$/.test(id)) throw new Error('Identificador de backup inválido.');
    if (!(await this.list()).some(backup => backup.id === id)) throw new Error('Backup não encontrado na pasta MATRIX do seu Google Drive.');
    const response = await this.authorizedFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 204) throw new Error(`Não foi possível excluir o backup (HTTP ${response.status}).`);
  }
}
