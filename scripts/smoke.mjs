import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import electron from 'electron';
import { PNG } from 'pngjs';
import { PlayerObject } from 'skinview3d';
import { PerspectiveCamera, Vector3 } from 'three';
await mkdir('.smoke', { recursive: true });
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.', '--matrix-smoke', '--remote-debugging-port=9223', '--remote-debugging-address=127.0.0.1'], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; child.stdout.on('data', d => { logs = (logs + d).slice(-12000); }); child.stderr.on('data', d => { logs = (logs + d).slice(-12000); });
let ws;
try {
  let target;
  for (let i = 0; i < 120; i++) { try { target = (await (await fetch('http://127.0.0.1:9223/json')).json()).find(t => t.type === 'page'); if (target) break; } catch {} await delay(250); }
  if (!target) throw new Error(`Electron não iniciou: ${logs}`);
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let id = 0; const pending = new Map(); ws.onmessage = event => { const message = JSON.parse(event.data); if (message.id && pending.has(message.id)) { const { ok, fail } = pending.get(message.id); pending.delete(message.id); message.error ? fail(new Error(message.error.message)) : ok(message.result); } };
  const send = (method, params = {}) => new Promise((ok, fail) => { const next = ++id; const timer=setTimeout(()=>{pending.delete(next);fail(new Error(`CDP timeout: ${method}`));},15000);pending.set(next,{ok:value=>{clearTimeout(timer);ok(value);},fail:error=>{clearTimeout(timer);fail(error);}});ws.send(JSON.stringify({ id: next, method, params })); });
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  for (let i = 0; i < 40; i++) { if (await evaluate('!!window.matrix && !!document.querySelector(".hero")')) break; await delay(150); }
  assert.equal(await evaluate('typeof require'), 'undefined'); assert.equal(await evaluate('typeof process'), 'undefined');
  const initial = await evaluate('window.matrix.invoke("snapshot")'); assert.equal(initial.schemaVersion, 1);
  assert.ok(await evaluate('window.matrix.invoke("account.create", { name: "invalid nickname" }).then(() => false, () => true)'));
  let account = initial.accounts.find(a => a.name === 'SmokePlayer');
  if (!account) await evaluate('window.matrix.invoke("account.create", { name: "SmokePlayer" })');
  const snapshot = await evaluate('window.matrix.invoke("snapshot")'); assert.ok(snapshot.accounts.some(a => a.name === 'SmokePlayer' && a.kind === 'offline'));
  assert.ok(await evaluate('window.matrix.invoke("unknown-command").then(() => false, () => true)'));
  await evaluate('document.querySelector("[data-page=accounts]").click()'); await delay(300); assert.ok(await evaluate('document.body.innerText.includes("SmokePlayer")'));
  await evaluate('document.querySelector("[data-page=home]").click()'); await delay(300);
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".sidebar-navigation [data-page]"), element => element.dataset.page)'), ['home', 'installations', 'smart', 'modcenter', 'skin', 'accounts', 'settings']);
  assert.ok(await evaluate('document.body.innerText.includes("Sua próxima aventura") && document.body.innerText.includes("começa aqui.")'));
  const screenshot = await send('Page.captureScreenshot', { format: 'png' }); await writeFile('.smoke/home.png', Buffer.from(screenshot.data, 'base64'));
  await evaluate('document.querySelector("[data-page=smart]").click()'); await delay(300);
  assert.ok(await evaluate('document.body.innerText.includes("MATRIX Smart Install") && !!document.querySelector(".smart-welcome")'));
  assert.ok(await evaluate('window.matrix.invoke("smart.install", {planId:"../../outside",allowJavaInstall:true}).then(()=>false,()=>true)'));
  const smartScreenshot = await send('Page.captureScreenshot', { format: 'png' }); await writeFile('.smoke/smart.png', Buffer.from(smartScreenshot.data, 'base64'));
  assert.equal(await evaluate('document.querySelectorAll(".skin-preview-viewport canvas").length'),0);
  if(process.argv.includes('--skin-layout'))await evaluate("window.matrix.invoke('skin.draft.clear')");
  await evaluate('document.querySelector("[data-page=skin]").click()');
  for(let i=0;i<80;i++){if(await evaluate('!!document.querySelector(".skin-library-actions")'))break;await delay(150);}
  assert.ok(await evaluate('document.body.innerText.includes("MATRIX Skin Studio")'));
  if(process.argv.includes('--skin-layout')) {
    const padding=await evaluate("parseFloat(getComputedStyle(document.querySelector('.skin-library-actions')).paddingLeft)");
    assert.ok(padding>=20,'library text must be inset from card borders');
    const alignment=await evaluate("(()=>{const row=document.querySelector('.skin-library-search');const h=row.querySelector('h3').getBoundingClientRect();const i=row.querySelector('input').getBoundingClientRect();return Math.abs(h.y+h.height/2-i.y-i.height/2);})()");
    assert.ok(alignment<2,'search and title should align on the same row');
    for(let i=0;i<60;i++){if(await evaluate("[...document.querySelectorAll('.skin-studio button')].some(b=>b.textContent.trim()==='Roupa simples'&&!b.disabled)"))break;await delay(100);}
    await evaluate("[...document.querySelectorAll('.skin-studio button')].find(b=>b.textContent.trim()==='Roupa simples'&&!b.disabled).click()");
    for(let i=0;i<60;i++){if(await evaluate("!!document.querySelector('.skin-preview-viewport canvas')"))break;await delay(100);}
    assert.ok(await evaluate("!!document.querySelector('.skin-preview-viewport canvas')"),'preview must initialize before testing fullscreen');
    const size=await evaluate("document.querySelector('.skin-preview-viewport').clientHeight");
    const clickFullscreen=async()=>{
      const rect=await evaluate("(()=>{const b=document.querySelector('.skin-preview-toolbar button');b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()");
      await send('Input.dispatchMouseEvent',{type:'mousePressed',...rect,button:'left',clickCount:1});
      await send('Input.dispatchMouseEvent',{type:'mouseReleased',...rect,button:'left',clickCount:1});
    };
    await clickFullscreen();
    for(let i=0;i<30;i++){if(await evaluate('!!document.fullscreenElement'))break;await delay(100);}
    assert.ok(await evaluate("document.fullscreenElement === document.querySelector('.skin-preview')"),'3D fullscreen request must be allowed');
    assert.ok(await evaluate(`document.querySelector('.skin-preview-viewport').clientHeight>${size}`),'3D viewport should grow in fullscreen');
    const assertCanvasFits=async()=>{const box=await evaluate("(()=>{const c=document.querySelector('.skin-preview-viewport canvas'),r=c.getBoundingClientRect(),v=document.querySelector('.skin-preview-viewport').getBoundingClientRect(),d=Math.min(window.devicePixelRatio,1.5);return {cssWidth:c.style.width,cssHeight:c.style.height,dx:Math.abs(r.width-v.width),dy:Math.abs(r.height-v.height),ratioError:Math.abs(c.width/c.height-r.width/r.height),pixelRatio:c.width/r.width/d};})()");assert.equal(box.cssWidth,'100%');assert.equal(box.cssHeight,'100%');assert.ok(box.dx<2&&box.dy<2,'WebGL canvas must match the viewport after fullscreen resize');assert.ok(box.ratioError<0.02,'camera canvas aspect must follow the viewport');assert.ok(Math.abs(box.pixelRatio-1)<0.08,'drawing buffer must use the renderer pixel ratio');};
    await delay(200);await assertCanvasFits();
    const bgChanged=await evaluate(`(()=>{const i=document.querySelector('.skin-preview-controls input[type=color]');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,'#385f86');i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new Event('change',{bubbles:true}));return i.value;})()`);assert.equal(bgChanged,'#385f86');await delay(200);
    for(let i=0;i<30;i++){if(await evaluate("document.querySelector('.skin-preview-toolbar button').textContent==='Sair da tela cheia'"))break;await delay(100);}
    assert.equal(await evaluate("document.querySelector('.skin-preview-toolbar button').textContent"),'Sair da tela cheia');
    await clickFullscreen();
    for(let i=0;i<30;i++){if(await evaluate('!document.fullscreenElement'))break;await delay(100);}
    assert.ok(await evaluate('!document.fullscreenElement'),'fullscreen button must exit');
    await delay(200);await assertCanvasFits();
    await clickFullscreen();for(let i=0;i<30;i++){if(await evaluate('!!document.fullscreenElement'))break;await delay(100);}await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    for(let i=0;i<30;i++){if(await evaluate('!document.fullscreenElement'))break;await delay(100);}
    assert.ok(await evaluate('!document.fullscreenElement'),'Escape must exit fullscreen');
    for(let i=0;i<30;i++){if(await evaluate("document.querySelector('.skin-preview-toolbar button').textContent==='Tela cheia'"))break;await delay(100);}
    assert.equal(await evaluate("document.querySelector('.skin-preview-toolbar button').textContent"),'Tela cheia');
    await evaluate("document.querySelector('[data-page=home]').click()");await delay(300);
    console.log('Skin layout smoke OK: card padding, title/search alignment, native fullscreen resizing, button and Escape exit.');
  } else {
  const clickText = async text => { assert.ok(await evaluate(`(()=>{const b=[...document.querySelectorAll('.skin-studio button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)return false;b.click();return true;})()`),`Missing button: ${text}`); await delay(250); };
  await clickText('Em branco');
  for(let i=0;i<40;i++){if(await evaluate('!!document.querySelector(".skin-preview-viewport canvas")'))break;await delay(150);}
  assert.equal(await evaluate('document.querySelectorAll(".skin-preview-viewport canvas").length'),1);
  assert.ok(await evaluate('!document.querySelector(".skin-preview [role=alert]")'));
  const canvasPoint=await evaluate(`(()=>{const c=document.querySelector('.skin-pixel-canvas');c.scrollIntoView({block:'center'});const r=c.getBoundingClientRect();return{x:r.x+10.5*r.width/64,y:r.y+13.5*r.height/64};})()`);
  const mouse=async(x,y)=>{await send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});await delay(250);};
  const pixel=async()=>evaluate(`(()=>{const c=document.querySelector('.skin-pixel-canvas');const z=c.width/64;return [...c.getContext('2d').getImageData(10*z+z/2,13*z+z/2,1,1).data];})()`);
  await mouse(canvasPoint.x,canvasPoint.y); assert.deepEqual(await pixel(),[212,180,134,255]);
  console.log('Skin smoke: 2D painting OK');
  await clickText('Desfazer');assert.deepEqual(await pixel(),[0,0,0,255]);
  await clickText('Refazer');assert.deepEqual(await pixel(),[212,180,134,255]);
  await clickText('Salvar projeto');
  console.log('Skin smoke: undo/redo/save OK');
  let saved=await evaluate('window.matrix.invoke("skin.list")'); const entry=saved.find(e=>e.name==='Minha skin');assert.ok(entry);
  const project=await evaluate(`window.matrix.invoke('skin.open',${JSON.stringify(entry.id)})`);
  assert.deepEqual([...Buffer.from(project.pixels,'base64').subarray((13*64+10)*4,(13*64+10)*4+4)],[212,180,134,255]);
  // Use the real geometry and the preview camera to project a face point into the
  // renderer; CDP dispatches actual pointer events, not mocked painting callbacks.
  await clickText('Frente');await clickText('Pintar em 3D');
  const rgbaColor=await evaluate(`(()=>{const i=document.querySelector('input[aria-label="Selecionar cor"]');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(i,'#e64f52');i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new Event('change',{bubbles:true}));return i.value;})()`);assert.equal(rgbaColor,'#e64f52');
  const player=new PlayerObject();player.updateMatrixWorld(true);
  const modelPoint=player.skin.head.innerLayer.localToWorld(new Vector3(-1.5,-1.5,4));
  const camera=new PerspectiveCamera(38,1,.1,300);camera.position.set(0,0,Math.sqrt(32**2+13**2+65**2));camera.lookAt(0,0,0);camera.updateMatrixWorld(true);
  const rect=await evaluate(`(()=>{const c=document.querySelector('.skin-preview-viewport canvas');c.scrollIntoView({block:'center'});const r=c.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};})()`);
  camera.aspect=rect.width/rect.height;camera.updateProjectionMatrix();const projected=modelPoint.project(camera);
  await mouse(rect.x+(projected.x+1)*rect.width/2,rect.y+(1-projected.y)*rect.height/2);
  await delay(1000);
  const recovery=await evaluate('window.matrix.invoke("skin.draft.get")');assert.ok(recovery);
  const pixels=Buffer.from(recovery.document.pixels,'base64');assert.ok(pixels.includes(Buffer.from([230,79,82,255])),'3D painting must update shared texture');
  console.log('Skin smoke: actual 3D painting OK');
  await clickText('Salvar projeto');
  // WebGL screenshots on an invisible Windows window can wait for the desktop
  // compositor. Keep functional assertions independent of screenshot capture.
  await evaluate('document.querySelector("[data-page=home]").click()');await delay(400);
  assert.equal(await evaluate('document.querySelectorAll(".skin-preview-viewport canvas").length'),0,'renderer removed when leaving editor');
  await evaluate('document.querySelector("[data-page=skin]").click()');await delay(400);
  assert.ok(await evaluate('!!document.querySelector(".skin-library")'),'library survives tab reopen');
  assert.equal(await evaluate('document.querySelectorAll(".skin-preview-viewport canvas").length'),0,'library does not initialize WebGL');
  assert.ok(await evaluate('window.matrix.invoke("skin.open","../../outside").then(()=>false,()=>true)'));
  assert.ok(await evaluate(`window.matrix.invoke('skin.account.assign',{accountId:${JSON.stringify(account?.id??snapshot.accounts.find(a=>a.name==='SmokePlayer').id)},projectId:${JSON.stringify(entry.id)}}).then(()=>true,()=>false)`));
  }
  await writeFile('.smoke/electron.log', logs); console.log('Electron smoke OK: renderer sandboxed, IPC, offline profile, navigation, screenshot.');
} finally { ws?.close(); child.kill(); }
