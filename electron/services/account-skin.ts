import { MojangClient } from '@xmcl/user';
import type { Account } from '../../shared/contracts.ts';
import type { SkinDocument, SkinModel } from '../../shared/skin.ts';
import type { MicrosoftAuth } from './auth.ts';
import { httpsFetch } from './download.ts';
import { decodeSkinPNG, encodeSkinPNG } from './skins.ts';

// XMCL builds multipart uploads. Serialize using the platform encoder, then use
// the launcher's restricted HTTPS transport; no tokens ever reach the renderer.
export function skinTransport(fetcher: typeof fetch): typeof fetch {
  return async (input, init = {}) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    if (new URL(url).origin !== 'https://api.minecraftservices.com') throw new Error('Destino de conta não autorizado');
    let request = init;
    if (init.body instanceof FormData) {
      const encoded = new Request(url, init);
      const body = Buffer.from(await encoded.arrayBuffer());
      if (body.length > 1_100_000) throw new Error('Upload de skin muito grande');
      request = { ...init, body, headers: encoded.headers };
    }
    return httpsFetch(url, request, ['api.minecraftservices.com'], fetcher);
  };
}
function clientFor(fetcher: typeof fetch): MojangClient {
  return new MojangClient({ fetch: skinTransport(fetcher) as unknown as NonNullable<ConstructorParameters<typeof MojangClient>[0]>['fetch'], FormData: globalThis.FormData as unknown as NonNullable<ConstructorParameters<typeof MojangClient>[0]>['FormData'], File: globalThis.File });
}
export async function importAccountSkin(account: Account, fetcher: typeof fetch, model: SkinModel = 'classic'): Promise<SkinDocument> {
  if (account.kind !== 'microsoft' || !account.skin) throw new Error('Esta conta não tem uma skin oficial disponível');
  const response = await httpsFetch(account.skin, {}, ['textures.minecraft.net'], fetcher);
  if (!response.ok || !response.body) throw new Error('Não foi possível obter a skin oficial');
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 1_000_000) { await response.body.cancel().catch(() => {}); throw new Error('Skin oficial excede o limite permitido'); }
    chunks.push(chunk);
  }
  return { ...decodeSkinPNG(Buffer.concat(chunks), model), name: `${account.name} · cópia` };
}
export async function importOfficialAccountSkin(account: Account, auth: Pick<MicrosoftAuth, 'session'>, fetcher: typeof fetch): Promise<{account:Account;document:SkinDocument}> {
  if(account.kind !== 'microsoft') throw new Error('Selecione uma conta Microsoft');
  const session=await auth.session(account);
  const profile=await clientFor(fetcher).getProfile(session.accessToken,AbortSignal.timeout(60000));
  const skin=profile.skins.find(s=>s.state==='ACTIVE');
  if(profile.id!==account.uuid || !skin)throw new Error('Skin oficial indisponível para esta conta');
  const updated={...session.account,skin:skin.url.replace(/^http:/,'https:')};
  const document=await importAccountSkin(updated,fetcher,skin.variant==='SLIM'?'slim':'classic');
  return {account:updated,document};
}
export async function applyAccountSkin(account: Account, document: SkinDocument, auth: Pick<MicrosoftAuth, 'session'>, fetcher: typeof fetch): Promise<Account> {
  if (account.kind !== 'microsoft') throw new Error('Aplicação oficial exige uma conta Microsoft proprietária do Minecraft');
  const session = await auth.session(account);
  const client = clientFor(fetcher);
  try {
    await client.setSkin('matrix-skin.png', encodeSkinPNG(document), document.model, session.accessToken, AbortSignal.timeout(60000));
    const profile = await client.getProfile(session.accessToken, AbortSignal.timeout(60000));
    if (profile.id !== account.uuid) throw new Error('Identidade da conta não corresponde à sessão');
    const active = profile.skins.find(s => s.state === 'ACTIVE');
    if (!active || new URL(active.url.replace(/^http:/, 'https:')).hostname !== 'textures.minecraft.net') throw new Error('Resposta de skin oficial inválida');
    return { ...session.account, skin: active.url.replace(/^http:/, 'https:') };
  } catch { throw new Error('A Microsoft não confirmou a atualização da skin. Verifique conexão, sessão e permissões do aplicativo; você também pode exportar o PNG para o site oficial.'); }
}
