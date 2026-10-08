import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAccountSkin, importAccountSkin, importOfficialAccountSkin, skinTransport } from '../electron/services/account-skin.ts';
import { createTemplate, encodePixels } from '../shared/skin-pixels.ts';
import { decodeSkinPNG, encodeSkinPNG } from '../electron/services/skins.ts';
import type { Account } from '../shared/contracts.ts';
const account: Account = { id:'0197d9f7-6842-47c9-aa8d-18a978cad250', kind:'microsoft', name:'SkinTester',uuid:'123456789012345678901234567890abcf',skin:'https://textures.minecraft.net/texture/abcd' };
const document = {name:'Skin teste',model:'slim' as const,pixels:encodePixels(createTemplate('slim','slim')),palette:[]};
const profile = {id:account.uuid,name:account.name,skins:[{state:'ACTIVE',url:account.skin,variant:'SLIM'}],capes:[]};
test('official skin upload uses refreshed session and real multipart PNG; tokens remain backend-only',async()=>{
  let requests=0;let refreshed=false;
  const fetcher:typeof fetch=async(input,init)=>{
    requests++;assert.equal(new Headers(init?.headers).get('authorization'),'Bearer private-test-token');
    if(String(input).endsWith('/skins')){
      assert.equal(init?.method,'POST');assert.ok(init?.body instanceof Uint8Array);
      const form=await new Request(String(input),{...init,method:'POST'}).formData();
      assert.equal(form.get('variant'),'slim');const file=form.get('file') as File;
      assert.equal(file.type,'image/png');const decoded=decodeSkinPNG(Buffer.from(await file.arrayBuffer()),'slim');assert.equal(decoded.pixels,document.pixels);
    }
    return Response.json(profile);
  };
  const updated=await applyAccountSkin(account,document,{session:async()=>{refreshed=true;return{account,accessToken:'private-test-token'};}},fetcher);
  assert.ok(refreshed);assert.equal(requests,2);assert.equal(updated.skin,account.skin);assert.ok(!JSON.stringify(updated).includes('private-test-token'));
});
test('offline application and credential redirects are blocked; import validates real PNG',async()=>{
  const auth={session:async()=>{throw new Error('must not request a session');}};
  await assert.rejects(applyAccountSkin({...account,kind:'offline'},document,auth,fetch));
  const transport=skinTransport(async()=>new Response(null,{status:302,headers:{location:'https://example.org/stolen'}}));
  await assert.rejects(transport('https://api.minecraftservices.com/minecraft/profile',{headers:{authorization:'Bearer secret'}}));
  await assert.rejects(transport('https://example.org/anything'));
  const imported=await importAccountSkin(account,async()=>new Response(new Uint8Array(encodeSkinPNG(document))));
  assert.equal(imported.name,'SkinTester · cópia');
  const official=await importOfficialAccountSkin(account,{session:async()=>({account,accessToken:'private-test-token'})},async(input)=>String(input).includes('api.minecraftservices.com')?Response.json(profile):new Response(new Uint8Array(encodeSkinPNG(document))));
  assert.equal(official.document.model,'slim');assert.equal(official.document.pixels,document.pixels);
  await assert.rejects(importAccountSkin(account,async()=>new Response('<script>bad image</script>')));
});
