import { createConnection } from 'node:net';
import { communitySchema, type Community, type Settings, type ServerStatus } from '../../shared/contracts.ts';
import { jsonFetch } from './download.ts';

export async function fetchCommunity(settings: Settings): Promise<Community | undefined> {
  if (!settings.communityApi) return undefined;
  return communitySchema.parse(await jsonFetch(settings.communityApi, AbortSignal.timeout(8000), undefined, 100_000));
}
function varint(value: number): Buffer { const bytes: number[] = []; do { let b = value & 127; value >>>= 7; if (value) b |= 128; bytes.push(b); } while (value); return Buffer.from(bytes); }
function string(value: string): Buffer { const bytes = Buffer.from(value); return Buffer.concat([varint(bytes.length), bytes]); }
function packet(bytes: Buffer): Buffer { return Buffer.concat([varint(bytes.length), bytes]); }
function readVarint(buffer: Buffer, offset = 0): { value: number; next: number } | undefined {
  let value = 0;
  for (let i = 0; i < 5; i++) { if (offset + i >= buffer.length) return undefined; const b = buffer[offset + i]; value |= (b & 127) << (7 * i); if (!(b & 128)) return { value, next: offset + i + 1 }; }
  throw new Error('Pacote do servidor inválido');
}
export function serverStatus(host: string, port: number): Promise<ServerStatus> {
  if (!host) return Promise.resolve({ status: 'unconfigured' });
  return new Promise(resolve => {
    const started = Date.now(); const socket = createConnection({ host, port }); let buffer = Buffer.alloc(0); let settled = false;
    const finish = (status: ServerStatus) => { if (settled) return; settled = true; socket.destroy(); resolve(status); };
    socket.setTimeout(6000); socket.on('timeout', () => finish({ status: 'offline', message: 'Servidor não respondeu' }));
    socket.on('error', () => finish({ status: 'offline', message: 'Servidor indisponível' }));
    socket.on('close', () => finish({ status: 'offline', message: 'Conexão encerrada' }));
    socket.on('connect', () => { const portBytes = Buffer.alloc(2); portBytes.writeUInt16BE(port); socket.write(Buffer.concat([packet(Buffer.concat([varint(0), varint(760), string(host), portBytes, varint(1)])), packet(varint(0))])); });
    socket.on('data', chunk => {
      try {
        buffer = Buffer.concat([buffer, chunk]); if (buffer.length > 256_000) throw new Error('Resposta excede limite');
        const length = readVarint(buffer); if (!length) return; if (length.value < 1 || length.value > 256_000) throw new Error('Pacote inválido');
        if (buffer.length < length.next + length.value) return;
        const id = readVarint(buffer, length.next); if (!id || id.value !== 0) throw new Error('Resposta inválida');
        const textLength = readVarint(buffer, id.next); if (!textLength || textLength.value < 0 || textLength.next + textLength.value > length.next + length.value) throw new Error('Resposta inválida');
        const json = JSON.parse(buffer.subarray(textLength.next, textLength.next + textLength.value).toString('utf8'));
        const online = Number(json.players?.online); const max = Number(json.players?.max);
        finish({ status: 'online', online: Number.isSafeInteger(online) && online >= 0 ? online : undefined, max: Number.isSafeInteger(max) && max >= 0 ? max : undefined, latency: Date.now() - started });
      } catch { finish({ status: 'offline', message: 'Resposta do servidor inválida' }); }
    });
  });
}
