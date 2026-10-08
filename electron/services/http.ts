import { request } from 'node:https';
import { Readable } from 'node:stream';

// Native HTTPS avoids sharing an undici dispatcher with third-party launcher libraries.
// Redirect policy, timeouts, host checks and size/hash verification remain in download.ts.
export const nativeHttpsFetch: typeof fetch = async (input, init = {}) => {
  const url = typeof input === 'string' || input instanceof URL ? new URL(input) : new URL(input.url);
  if (url.protocol !== 'https:') throw new Error('Transporte exige HTTPS');
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  headers['accept-encoding'] = 'identity';
  const body = init.body;
  if (body && typeof body !== 'string' && !(body instanceof URLSearchParams) && !(body instanceof Uint8Array)) throw new Error('Formato de corpo HTTP não suportado');
  return new Promise<Response>((ok, reject) => {
    const req = request(url, { method: init.method ?? 'GET', headers, signal: init.signal ?? undefined }, response => {
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
      const status = response.statusCode ?? 500;
      const empty = init.method === 'HEAD' || [204, 205, 304].includes(status);
      if (empty) response.resume();
      const stream = empty ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>;
      ok(new Response(stream, { status, headers: responseHeaders }));
    });
    req.once('error', reject); req.end(body instanceof URLSearchParams ? body.toString() : body || undefined);
  });
};
