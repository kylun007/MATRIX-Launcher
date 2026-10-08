import { appendFile, mkdir, stat, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { redact } from './security.ts';
export class Logs {
  readonly file: string; private queue: Promise<void> = Promise.resolve(); private secrets: string[] = [];
  constructor(readonly directory: string) { this.file = join(directory, 'launcher.log'); }
  protect(secret: string): void { if (secret.length > 4) this.secrets.push(secret); }
  write(message: string): void {
    let safe = redact(message); for (const secret of this.secrets) safe = safe.split(secret).join('[REDACTED]');
    safe = safe.slice(0, 16_000);
    this.queue = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true });
      if (await stat(this.file).then(s => s.size > 5_000_000).catch(() => false)) { await rm(`${this.file}.1`, { force: true }); await rename(this.file, `${this.file}.1`); }
      await appendFile(this.file, `[${new Date().toISOString()}] ${safe}\n`, { mode: 0o600 });
    }).catch(() => {});
  }
  flush(): Promise<void> { return this.queue; }
}
