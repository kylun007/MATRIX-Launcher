import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { Snapshot, Command, Input, CommandResults } from '../shared/contracts';
import type { BodyPart, SkinLayer, SkinModel, SkinDocument, SkinProject, SkinEntry, SkinDraft } from '../shared/skin';
import { PixelEditor, faces, faceAt, createTemplate, encodePixels, decodePixels, type SelectionRect, type PixelClipboard, type Color } from '../shared/skin-pixels';
import { SkinPreview, type SkinPreviewHandle } from './SkinPreview';
import './skin.css';

type Tool = 'pencil' | 'eraser' | 'fill' | 'picker' | 'line' | 'select' | 'lighten' | 'darken';
const toolNames: Record<Tool, string> = { pencil: 'Lápis', eraser: 'Borracha', fill: 'Balde', picker: 'Conta-gotas', line: 'Linha', select: 'Seleção', lighten: 'Clarear', darken: 'Escurecer' };
const partNames: Record<BodyPart, string> = { head: 'Cabeça', body: 'Tronco', rightArm: 'Braço direito', leftArm: 'Braço esquerdo', rightLeg: 'Perna direita', leftLeg: 'Perna esquerda' };
const palettes = { Saturno: ['#d4b486','#ad8957','#72563b','#ece2cc','#333036','#17161b'], Natural: ['#f4c7a1','#c68c65','#724b38','#483223','#58874b','#80baca'], Vibrante: ['#ef6262','#f6c65b','#88bf73','#5ca9da','#9a7bcc','#ef9ab4'] };
const initialPalette = palettes.Saturno;
function documentOf(editor: PixelEditor, name: string, palette: string[]): SkinDocument { return { name: name.trim() || 'Minha skin', model: editor.model, pixels: encodePixels(editor.pixels), palette }; }
function colorOf(hex: string, alpha: number): Color { return [parseInt(hex.slice(1,3),16),parseInt(hex.slice(3,5),16),parseInt(hex.slice(5,7),16),alpha]; }
function colorHex(color: ArrayLike<number>): string { return '#' + [color[0],color[1],color[2]].map(v => v.toString(16).padStart(2,'0')).join(''); }

export function SkinStudio({ state, registerExit }: { state: Snapshot; registerExit: (guard: (() => Promise<boolean>) | undefined) => void }) {
  const [entries, setEntries] = useState<SkinEntry[]>([]); const [query, setQuery] = useState('');
  const [renameEntry, setRenameEntry] = useState<{id:string;name:string}>();
  const [editing, setEditing] = useState(false); const [project, setProject] = useState<SkinProject>();
  const [name, setName] = useState('Minha skin'); const [palette, setPalette] = useState<string[]>([...initialPalette]);
  const [color, setColor] = useState('#d4b486'); const [alpha, setAlpha] = useState(255); const [recent, setRecent] = useState<string[]>([]);
  const [hexText, setHexText] = useState(color);
  useEffect(()=>setHexText(color),[color]);
  function applyHex() { if(/^#[a-fA-F0-9]{6}$/.test(hexText)){setColor(hexText.toLowerCase());setError('');}else setError('Informe uma cor HEX com # e seis caracteres, por exemplo #d4b486.'); }
  const [tool, setTool] = useState<Tool>('pencil'); const [part, setPart] = useState<BodyPart | 'all'>('all');
  const [layer, setLayer] = useState<SkinLayer>('base'); const [outerVisible,setOuterVisible] = useState(true); const [baseVisible,setBaseVisible] = useState(true);
  const [zoom,setZoom] = useState(5); const [grid,setGrid] = useState(true); const [mirror,setMirror] = useState(false);
  const [selection,setSelection] = useState<SelectionRect>(); const [pasteMode,setPasteMode] = useState(false);
  const clipboard = useRef<PixelClipboard | undefined>(undefined); const engine = useRef(new PixelEditor(createTemplate('clothes','classic'),'classic'));
  const [version,setVersion] = useState(0); const [dirty,setDirty] = useState(false); const [status,setStatus] = useState('');
  const [error,setError] = useState(''); const [busy,setBusy] = useState(false); const [draft,setDraft] = useState<SkinDraft>();
  const [transparentPreview,setTransparentPreview] = useState(true); const [targetAccount,setTargetAccount] = useState(state.selectedAccount ?? '');
  const [compare,setCompare] = useState(false); const original = useRef<Uint8ClampedArray>(engine.current.pixels.slice());
  const canvas = useRef<HTMLCanvasElement>(null); const preview = useRef<SkinPreviewHandle>(null);
  const stroke = useRef<{x:number;y:number;lastX:number;lastY:number} | undefined>(undefined);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined); const draftQueue = useRef(Promise.resolve());
  const cameraSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined); const pendingCamera = useRef(state.settings.skinCamera);
  const actionPending = useRef(false);
  const alive = useRef(true); const current = useRef({ editing, project, name, palette, dirty }); current.current = {editing,project,name,palette,dirty};
  const account = state.accounts.find(a => a.id === targetAccount);
  async function invoke<C extends Command>(command: C, input?: Input<C>): Promise<CommandResults[C]> { return window.matrix!.invoke(command,input); }
  async function action(work: () => Promise<void>) { if(actionPending.current)return; actionPending.current=true;setBusy(true); setError(''); try { await work(); } catch(e) { setError((e as Error).message); } finally { actionPending.current=false;if(alive.current) setBusy(false); } }
  async function refresh() { setEntries(await invoke('skin.list')); }
  function changed() { current.current={...current.current,dirty:true}; setVersion(v=>v+1); setDirty(true); setStatus('Alterações não salvas'); }
  function queueDraft(): Promise<void> {
    const c = current.current;
    if (!c.editing || !c.dirty) return draftQueue.current;
    const data: SkinDraft = {document:documentOf(engine.current,c.name,c.palette),projectId:c.project?.id,revision:c.project?.revision,savedAt:Date.now()};
    const next = draftQueue.current.catch(()=>{}).then(()=>invoke('skin.draft.save',data)); draftQueue.current=next; return next;
  }
  async function canLeave(): Promise<boolean> {
    if (stroke.current) { if(engine.current.commit())changed(); stroke.current=undefined; }
    if (draftTimer.current) clearTimeout(draftTimer.current);
    if (current.current.dirty) {
      try { await queueDraft(); }
      catch(e) { setError((e as Error).message); if(!window.confirm('Não foi possível criar a recuperação. Sair e descartar alterações não salvas?')) return false; }
    }
    await invoke('skin.editor.active',false); return true;
  }
  const exitRef = useRef(canLeave); exitRef.current=canLeave;
  useEffect(()=>{
    alive.current=true; registerExit(()=>exitRef.current());
    const off = window.matrix!.onSkinClose(()=>{ void (async()=>{ if(await exitRef.current()) await invoke('skin.editor.close'); })(); });
    void action(async()=>{ await refresh(); setDraft(await invoke('skin.draft.get')); });
    return ()=>{ alive.current=false; off(); registerExit(undefined); if(draftTimer.current) clearTimeout(draftTimer.current); };
  },[]);
  useEffect(()=>{
    if(!editing || !dirty) return;
    draftTimer.current=setTimeout(()=>{ void queueDraft().then(()=>{if(alive.current) setStatus('Recuperação automática salva');}).catch(e=>{if(alive.current) setError(`Falha ao salvar recuperação: ${e.message}`);}); },800);
    return ()=>{if(draftTimer.current)clearTimeout(draftTimer.current);};
  },[version,name,palette,editing,dirty]);
  useEffect(()=>{ void invoke('skin.editor.active',editing).catch(e=>setError(e.message)); },[editing]);
  function openDocument(doc: SkinDocument, existing?:SkinProject, recovering=false) {
    if(draft && !editing && !recovering && !window.confirm('Substituir a recuperação pendente pela skin escolhida?'))return;
    setDraft(undefined);
    engine.current=new PixelEditor(decodePixels(doc.pixels),doc.model); original.current=engine.current.pixels.slice();
    setName(doc.name); setPalette(doc.palette); setProject(existing); setDirty(!existing); setEditing(true); setVersion(v=>v+1);
    setSelection(undefined); setPasteMode(false); setCompare(false); setPart('all'); setLayer('base'); setStatus(existing?'Projeto salvo':'Novo projeto');
  }
  async function save(): Promise<SkinProject> {
    const c=current.current;
    if(draftTimer.current)clearTimeout(draftTimer.current); await draftQueue.current.catch(()=>{});
    const captured=documentOf(engine.current,current.current.name,current.current.palette);
    const saved=await invoke('skin.save',{document:captured,id:c.project?.id,revision:c.project?.revision});
    const latest=current.current;
    const unchanged=JSON.stringify(documentOf(engine.current,latest.name,latest.palette))===JSON.stringify(captured);
    setProject(saved); original.current=decodePixels(saved.pixels);
    if(unchanged){setName(saved.name);setDirty(false);setStatus('Projeto salvo');current.current={...latest,project:saved,dirty:false,name:saved.name};await draftQueue.current.catch(()=>{});await invoke('skin.draft.clear');}
    else {setDirty(true);setStatus('Projeto salvo; há novas alterações');current.current={...latest,project:saved,dirty:true};await queueDraft();}
    await refresh(); return saved;
  }
  async function replace(work:()=>Promise<void>) { if(current.current.dirty && !window.confirm('Substituir a edição atual? Uma recuperação será salva antes de continuar.')) return; await queueDraft(); await work(); }
  useEffect(()=>{
    const element=canvas.current; if(!element || !editing) return;
    const ctx=element.getContext('2d')!; ctx.clearRect(0,0,64*zoom,64*zoom); ctx.imageSmoothingEnabled=false;
    const texture=document.createElement('canvas'); texture.width=64;texture.height=64;
    const pixels=compare?original.current:engine.current.pixels;
    texture.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pixels),64,64),0,0);
    for(const f of faces(engine.current.model)) {
      const visible=(part==='all'||f.part===part) && (f.layer==='base'?baseVisible:outerVisible);
      if(visible) {ctx.globalAlpha=f.layer===layer?1:.4;ctx.drawImage(texture,f.x,f.y,f.width,f.height,f.x*zoom,f.y*zoom,f.width*zoom,f.height*zoom);}
    }
    ctx.globalAlpha=1;
    if(grid && zoom>=4){ctx.strokeStyle='#ffffff16';ctx.lineWidth=1;ctx.beginPath();for(let i=0;i<=64;i++){ctx.moveTo(i*zoom+.5,0);ctx.lineTo(i*zoom+.5,64*zoom);ctx.moveTo(0,i*zoom+.5);ctx.lineTo(64*zoom,i*zoom+.5);}ctx.stroke();}
    ctx.strokeStyle='#d4b48666';for(const f of faces(engine.current.model))if(f.layer===layer&&(part==='all'||part===f.part))ctx.strokeRect(f.x*zoom+.5,f.y*zoom+.5,f.width*zoom-1,f.height*zoom-1);
    if(selection){ctx.strokeStyle='#fff';ctx.setLineDash([3,3]);ctx.strokeRect(selection.x*zoom+.5,selection.y*zoom+.5,selection.width*zoom-1,selection.height*zoom-1);ctx.setLineDash([]);}
  },[version,zoom,grid,part,layer,baseVisible,outerVisible,selection,editing,compare]);
  function usable(x:number,y:number) {const f=faceAt(x,y,engine.current.model);return f&&f.layer===layer&&(part==='all'||f.part===part)&&(layer==='base'?baseVisible:outerVisible);}
  function paintOne(x:number,y:number){
    if(!usable(x,y) || compare) return;
    const e=engine.current; const rgba=colorOf(color,layer==='base'?255:alpha);
    if(tool==='picker'){setColor(colorHex(e.pixels.slice((y*64+x)*4,(y*64+x)*4+4)));setAlpha(e.pixels[(y*64+x)*4+3]);return;}
    if(tool==='fill')e.fill(x,y,rgba);
    else if(tool==='lighten'||tool==='darken')e.shade(x,y,tool==='lighten'?16:-16);
    else e.setPixel(x,y,tool==='eraser'?[0,0,0,layer==='outer'?0:255]:rgba);
    if(mirror){const f=faceAt(x,y,e.model)!;const partner={leftArm:'rightArm',rightArm:'leftArm',leftLeg:'rightLeg',rightLeg:'leftLeg',head:'head',body:'body'}[f.part] as BodyPart;
      const oppositeFace=f.face==='left'?'right':f.face==='right'?'left':f.face;
      const other=faces(e.model).find(q=>q.part===partner&&q.layer===f.layer&&q.face===oppositeFace);
      if(other){const mx=other.x+other.width-1-(x-f.x),my=other.y+y-f.y;if(tool==='fill')e.fill(mx,my,rgba);else if(tool==='lighten'||tool==='darken')e.shade(mx,my,tool==='lighten'?16:-16);else e.setPixel(mx,my,tool==='eraser'?[0,0,0,layer==='outer'?0:255]:rgba);}
    }
  }
  function rasterLine(x0:number,y0:number,x1:number,y1:number,visit:(x:number,y:number)=>void){
    const dx=Math.abs(x1-x0),dy=-Math.abs(y1-y0),sx=x0<x1?1:-1,sy=y0<y1?1:-1;let err=dx+dy;
    for(;;){visit(x0,y0);if(x0===x1&&y0===y1)break;const twice=2*err;if(twice>=dy){err+=dy;x0+=sx;}if(twice<=dx){err+=dx;y0+=sy;}}
  }
  function maskedRegion(rect:SelectionRect,gradient=false,restore=false){
    const from=colorOf(color,layer==='base'?255:alpha),to=colorOf('#17161b',layer==='base'?255:alpha);
    for(let y=rect.y;y<rect.y+rect.height;y++)for(let x=rect.x;x<rect.x+rect.width;x++)if(usable(x,y)){
      const offset=(y*64+x)*4,t=gradient&&rect.height>1?(y-rect.y)/(rect.height-1):0;
      const rgba=restore?Array.from(original.current.slice(offset,offset+4)):from.map((v,i)=>Math.round(v+(to[i]-v)*t));
      engine.current.setPixel(x,y,rgba as unknown as Color);
    }
  }
  function maskedPaste(x:number,y:number,data:PixelClipboard){for(let py=0;py<data.height;py++)for(let px=0;px<data.width;px++)if(usable(x+px,y+py)){
    const offset=(py*data.width+px)*4;engine.current.setPixel(x+px,y+py,Array.from(data.pixels.slice(offset,offset+4)) as unknown as Color);
  }}
  function editPixel(x:number,y:number,phase:'start'|'move'|'end'|'cancel',interpolate=false){
    const e=engine.current;
    if(phase==='cancel'){if(stroke.current){e.cancel();stroke.current=undefined;setVersion(v=>v+1);}return;}
    if(phase==='end') {
      const s=stroke.current;if(!s)return;
      if(tool==='line'&&!compare)rasterLine(s.x,s.y,x,y,paintOne);
      const modified=e.commit();stroke.current=undefined;if(modified)changed();return;
    }
    if(phase==='start') {
      if(!usable(x,y)||compare)return;e.begin();stroke.current={x,y,lastX:x,lastY:y};
      if(pasteMode&&clipboard.current){maskedPaste(x,y,clipboard.current);const modified=e.commit();stroke.current=undefined;setPasteMode(false);if(modified)changed();return;}
      if(tool==='select'){setSelection({x,y,width:1,height:1});return;}
      if(tool==='line')return;
      paintOne(x,y);setRecent(values=>[color,...values.filter(c=>c!==color)].slice(0,12));setVersion(v=>v+1);return;
    }
    const s=stroke.current;if(!s)return;const lastX=s.lastX,lastY=s.lastY;s.lastX=x;s.lastY=y;
    if(tool==='select'){setSelection({x:Math.min(s.x,x),y:Math.min(s.y,y),width:Math.abs(x-s.x)+1,height:Math.abs(y-s.y)+1});return;}
    if(tool==='fill'||tool==='picker'||tool==='line')return;
    if(interpolate&&(tool==='pencil'||tool==='eraser'))rasterLine(lastX,lastY,x,y,paintOne);else paintOne(x,y);setVersion(v=>v+1);
  }
  function point(event:PointerEvent<HTMLCanvasElement>){const r=event.currentTarget.getBoundingClientRect();return {x:Math.max(0,Math.min(63,Math.floor((event.clientX-r.left)*64/r.width))),y:Math.max(0,Math.min(63,Math.floor((event.clientY-r.top)*64/r.height)))};}
  function history(redo=false){if((redo?engine.current.redo():engine.current.undo()))changed();}
  useEffect(()=>{
    function key(e:KeyboardEvent){if(!editing||/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName))return;
      if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();history(e.shiftKey);}else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y'){e.preventDefault();history(true);}else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();void action(async()=>{await save();});}
    }window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  },[editing,version,name,palette,project]);
  const mutation=(work:()=>void)=>{if(compare)return;engine.current.begin();try{work();if(engine.current.commit())changed();}catch(e){engine.current.cancel();setError((e as Error).message);}};
  return <section className="skin-studio">
    {renameEntry&&<div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-label="Renomear skin"><h2>Renomear skin</h2><form onSubmit={e=>{e.preventDefault();void action(async()=>{await invoke('skin.rename',renameEntry);setRenameEntry(undefined);await refresh();});}}><label className="field"><span>Nome da skin</span><input autoFocus required minLength={1} maxLength={80} value={renameEntry.name} onChange={e=>setRenameEntry({...renameEntry,name:e.target.value})}/></label><div className="skin-row"><button type="submit" className="button primary" disabled={busy||!renameEntry.name.trim()}>Salvar nome</button><button type="button" className="button" disabled={busy} onClick={()=>setRenameEntry(undefined)}>Cancelar</button></div></form></section></div>}
    <div className="skin-heading"><div><span className="eyebrow">CRIE SUA IDENTIDADE</span><h2>MATRIX Skin Studio</h2><p>Edição local, pixels precisos e prévia 3D em tempo real.</p></div>{editing&&<button className="button" onClick={()=>void action(async()=>{if(await canLeave()){setEditing(false);await refresh();setDraft(await invoke('skin.draft.get'));}})}>Minhas Skins</button>}</div>
    {error&&<div className="skin-message error" role="alert">{error}<button onClick={()=>setError('')}>Fechar</button></div>}
    {!editing?<>
      {draft&&<div className="skin-message"><span>Uma edição foi recuperada: <strong>{draft.document.name}</strong></span><button className="button primary" onClick={()=>void action(async()=>{const p=draft.projectId?await invoke('skin.open',draft.projectId).catch(()=>undefined):undefined;openDocument(draft.document,p,true);setDirty(true);setDraft(undefined);})}>Recuperar</button><button className="button" onClick={()=>void action(async()=>{if(window.confirm('Descartar a recuperação?')){await invoke('skin.draft.clear');setDraft(undefined);}})}>Descartar</button></div>}
      <div className="panel skin-library-actions"><h3>Criar uma skin</h3><div className="skin-row">{(['blank','classic','slim','clothes'] as const).map(kind=><button key={kind} className="button" disabled={busy} onClick={()=>openDocument({name:kind==='blank'?'Minha skin':kind==='slim'?'Modelo de braços finos':'Modelo MATRIX',model:kind==='slim'?'slim':'classic',pixels:encodePixels(createTemplate(kind,kind==='slim'?'slim':'classic')),palette:[...initialPalette]})}>{({blank:'Em branco',classic:'Clássico · Steve',slim:'Braços finos · Alex',clothes:'Roupa simples'})[kind]}</button>)}</div><small>Modelos originais MATRIX, editáveis. Steve e Alex indicam a geometria dos braços.</small><div className="skin-row"><button className="button" disabled={busy} onClick={()=>void action(async()=>{const d=await invoke('skin.import');if(d)openDocument(d);})}>Importar PNG</button><button className="button" disabled={busy} onClick={()=>void action(async()=>{const d=await invoke('skin.project.import');if(d)openDocument(d);})}>Abrir projeto exportado</button></div></div>
      <div className="skin-row skin-library-search"><h3>Minhas Skins <small>{entries.length}</small></h3><input aria-label="Pesquisar skins" placeholder="Pesquisar por nome" value={query} onChange={e=>setQuery(e.target.value)}/></div>
      <div className="skin-library">{entries.filter(e=>e.name.toLowerCase().includes(query.toLowerCase())).map(entry=><article className="panel skin-library-card" key={entry.id}><button className="skin-thumbnail" onClick={()=>void action(async()=>{const p=await invoke('skin.open',entry.id);openDocument(p,p);})}><img src={entry.thumbnail} alt={entry.name}/></button><h3>{entry.name}</h3><p>{entry.model==='slim'?'Alex · braços finos':'Steve · clássico'} · {new Date(entry.updatedAt).toLocaleDateString('pt-BR')}</p><div className="skin-row"><button className="button" disabled={busy} onClick={()=>void action(async()=>{const p=await invoke('skin.open',entry.id);openDocument(p,p);})}>Editar</button><button className="button" disabled={busy} onClick={()=>setRenameEntry({id:entry.id,name:entry.name})}>Renomear</button><button className="button" disabled={busy} onClick={()=>void action(async()=>{await invoke('skin.duplicate',entry.id);await refresh();})}>Duplicar</button><button className="button" disabled={busy} onClick={()=>void action(async()=>{await invoke('skin.delete',entry.id);await refresh();})}>Excluir</button><button className="button" disabled={busy} onClick={()=>void action(async()=>{const p=await invoke('skin.open',entry.id);await invoke('skin.export',{document:{name:p.name,model:p.model,pixels:p.pixels,palette:p.palette},format:'png'});})}>Exportar</button></div></article>)}</div>{entries.length===0&&<p className="skin-empty">Sua biblioteca começa com a primeira skin. Crie um modelo ou importe um PNG 64×64 ou 64×32.</p>}
    </>:<>
      <div className="skin-row skin-project-bar"><input aria-label="Nome da skin" maxLength={80} value={name} onChange={e=>{setName(e.target.value);setDirty(true);}}/><select aria-label="Modelo" value={engine.current.model} onChange={e=>{const m=e.target.value as SkinModel;engine.current=new PixelEditor(engine.current.pixels.slice(),m);setSelection(undefined);changed();}}><option value="classic">Steve · clássico</option><option value="slim">Alex · braços finos</option></select><button className="button primary" disabled={busy} onClick={()=>void action(async()=>{await save();})}>Salvar projeto</button><button className="button" disabled={busy} onClick={()=>void action(async()=>{await invoke('skin.export',{document:documentOf(engine.current,name,palette),format:'png'});})}>Exportar PNG</button><button className="button" disabled={busy} onClick={()=>void action(async()=>{await invoke('skin.export',{document:documentOf(engine.current,name,palette),format:'project'});})}>Exportar projeto</button><span className={dirty?'muted':'success'} role="status">{status}</span></div>
      <div className="skin-workspace">
        <aside className="panel skin-tools"><h3>Ferramentas</h3><div className="skin-tool-grid">{Object.entries(toolNames).map(([id,label])=><button key={id} className={tool===id?'active':''} onClick={()=>{setTool(id as Tool);setPasteMode(false);}}>{label}</button>)}</div><div className="skin-row"><button className="button" disabled={!engine.current.canUndo} onClick={()=>history()}>Desfazer</button><button className="button" disabled={!engine.current.canRedo} onClick={()=>history(true)}>Refazer</button></div>
          <label className="field"><span>Cor HEX</span><div className="skin-row"><input aria-label="Selecionar cor" type="color" value={color} onChange={e=>setColor(e.target.value)}/><input aria-label="Código HEX" value={hexText} maxLength={7} onChange={e=>setHexText(e.target.value)} onBlur={applyHex} onKeyDown={e=>{if(e.key==='Enter')applyHex();}}/></div></label>
          <div className="skin-rgb">{['R','G','B'].map((label,i)=><label key={label}>{label}<input type="number" min={0} max={255} value={parseInt(color.slice(1+i*2,3+i*2),16)} onChange={e=>{const rgb=[...colorOf(color,255)] as number[];rgb[i]=Math.max(0,Math.min(255,Number(e.target.value)||0));setColor(colorHex(rgb));}}/></label>)}</div>
          <label className="field"><span>Transparência · {layer==='base'?'base opaca':`${Math.round(alpha/255*100)}%`}</span><input aria-label="Opacidade" type="range" min={0} max={255} disabled={layer==='base'} value={layer==='base'?255:alpha} onChange={e=>setAlpha(+e.target.value)}/></label><small>Borracha na base pinta preto; somente a camada externa aceita transparência.</small>
          <h4>Paletas</h4><select aria-label="Paleta pronta" onChange={e=>{setPalette([...palettes[e.target.value as keyof typeof palettes]]);setDirty(true);}} defaultValue="Saturno">{Object.keys(palettes).map(p=><option key={p}>{p}</option>)}</select><div className="skin-swatches">{palette.map((c,i)=><button key={c+i} title={c} style={{background:c}} onClick={()=>setColor(c)} onContextMenu={e=>{e.preventDefault();setPalette(p=>p.filter((_,n)=>n!==i));setDirty(true);}}/>)}</div><button className="button" disabled={palette.length>=64} onClick={()=>{setPalette(p=>p.includes(color)?p:[...p,color]);setDirty(true);}}>Favoritar cor</button><small>Clique direito remove uma favorita.</small><div className="skin-swatches">{recent.map(c=><button key={c} title={c} style={{background:c}} onClick={()=>setColor(c)}/>)}</div>
          <details><summary>Assistente de cores</summary><button className="button" onClick={()=>{const rgb=colorOf(color,255);setPalette([-48,-24,0,24,48].map(d=>colorHex(rgb.slice(0,3).map(v=>Math.max(0,Math.min(255,v+d))))));setDirty(true);}}>Gerar tons de sombra</button><button className="button" onClick={()=>{const count=new Map<string,number>();for(let i=0;i<engine.current.pixels.length;i+=4)if(engine.current.pixels[i+3]){const c=colorHex(engine.current.pixels.slice(i,i+4));count.set(c,(count.get(c)||0)+1);}setPalette([...count.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12).map(e=>e[0]));setDirty(true);}}>Cores predominantes</button></details>
        </aside>
        <section className="panel skin-editor"><div className="skin-row"><h3>Mapa de pixels</h3><label>Zoom <input aria-label="Zoom 2D" type="range" min={3} max={16} value={zoom} onChange={e=>setZoom(+e.target.value)}/>{zoom}×</label></div><div className="skin-row"><select aria-label="Parte do corpo" value={part} onChange={e=>setPart(e.target.value as BodyPart|'all')}><option value="all">Todas as partes</option>{Object.entries(partNames).map(([id,n])=><option key={id} value={id}>{n}</option>)}</select><select aria-label="Camada ativa" value={layer} onChange={e=>setLayer(e.target.value as SkinLayer)}><option value="base">Camada principal</option><option value="outer">Camada externa</option></select></div><div className="skin-row"><label><input type="checkbox" checked={grid} onChange={e=>setGrid(e.target.checked)}/> Grade</label><label><input type="checkbox" checked={baseVisible} onChange={e=>setBaseVisible(e.target.checked)}/> Base</label><label><input type="checkbox" checked={outerVisible} onChange={e=>setOuterVisible(e.target.checked)}/> Externa</label><label><input type="checkbox" checked={mirror} onChange={e=>setMirror(e.target.checked)}/> Simetria</label></div>
          <div className="skin-canvas-scroll"><canvas ref={canvas} className="skin-pixel-canvas" aria-label="Editor de pixels 64 por 64" width={64*zoom} height={64*zoom} onPointerDown={e=>{if(e.button!==0)return;const p=point(e);e.currentTarget.setPointerCapture(e.pointerId);editPixel(p.x,p.y,'start',true);}} onPointerMove={e=>{if(!stroke.current)return;const p=point(e);editPixel(p.x,p.y,'move',true);}} onPointerUp={e=>{const p=point(e);editPixel(p.x,p.y,'end',true);if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}} onPointerCancel={()=>{engine.current.cancel();stroke.current=undefined;setVersion(v=>v+1);}}/></div><p className="muted">64×64 · contornos UV · {pasteMode?'Clique no mapa para colar':compare?'Visualizando original':'Clique e arraste para editar'}</p>
          <div className="skin-row"><button className="button" disabled={!selection} onClick={()=>{clipboard.current=engine.current.copy(selection!);setStatus('Região copiada');}}>Copiar região</button><button className="button" disabled={!clipboard.current} onClick={()=>setPasteMode(true)}>Colar</button><button className="button" disabled={!selection} onClick={()=>mutation(()=>maskedRegion(selection!))}>Preencher</button><button className="button" disabled={!selection} onClick={()=>mutation(()=>maskedRegion(selection!,true))}>Gradiente</button></div><div className="skin-row"><button className="button" disabled={part==='all'} onClick={()=>mutation(()=>engine.current.mirror(part as BodyPart,layer))}>Espelhar parte</button><button className="button" disabled={!['leftArm','rightArm','leftLeg','rightLeg'].includes(part)} onClick={()=>mutation(()=>engine.current.copyPart(part as BodyPart,({leftArm:'rightArm',rightArm:'leftArm',leftLeg:'rightLeg',rightLeg:'leftLeg'} as Record<string,BodyPart>)[part],layer))}>Copiar para lado oposto</button><button className="button" onClick={()=>setCompare(c=>!c)}>{compare?'Voltar à edição':'Comparar original'}</button><button className="button" disabled={!selection} onClick={()=>mutation(()=>maskedRegion(selection!,false,true))}>Restaurar região</button></div>
        </section>
        <section className="panel skin-3d"><h3>Prévia e edição 3D</h3><SkinPreview ref={preview} pixels={compare?original.current:engine.current.pixels} version={version} model={engine.current.model} part={part} layer={layer} baseVisible={baseVisible} outerVisible={outerVisible} camera={state.settings.skinCamera} onCameraChange={camera=>{pendingCamera.current=camera;if(cameraSaveTimer.current)clearTimeout(cameraSaveTimer.current);cameraSaveTimer.current=setTimeout(()=>{cameraSaveTimer.current=undefined;void invoke('skin.camera',camera).catch(e=>setError((e as Error).message));},250);}} onPaint={editPixel}/><div className="skin-row"><label><input type="checkbox" checked={transparentPreview} onChange={e=>setTransparentPreview(e.target.checked)}/> Fundo transparente</label><button className="button" disabled={busy} onClick={()=>void action(async()=>{await invoke('skin.preview.export',{png:preview.current!.exportPNG(transparentPreview)});})}>Exportar prévia</button></div></section>
      </div>
      <section className="panel skin-account"><h3>Usar esta skin</h3><div className="skin-row"><select aria-label="Conta da skin" value={targetAccount} onChange={e=>setTargetAccount(e.target.value)}><option value="">Selecione uma conta</option>{state.accounts.map(a=><option key={a.id} value={a.id}>{a.name} · {a.kind==='offline'?'offline':'Microsoft'}</option>)}</select><button className="button" disabled={busy||!account||(account.kind==='offline'?!account.skinProjectId:!account.skin)} onClick={()=>void action(async()=>{await replace(async()=>openDocument(await invoke('skin.account.import',account!.id)));})}>Importar skin da conta</button>{account?.kind==='offline'?<button className="button primary" disabled={busy} onClick={()=>void action(async()=>{const p=await save();await invoke('skin.account.assign',{accountId:account.id,projectId:p.id});setStatus('Skin associada ao perfil local');})}>Associar ao perfil offline</button>:<button className="button primary" disabled={busy||!account||!state.microsoftConfigured||state.game.status!=='idle'||!!state.operation} onClick={()=>void action(async()=>{const applied=await invoke('skin.account.apply',{accountId:account!.id,document:documentOf(engine.current,name,palette)});setStatus(applied?'Skin oficial atualizada':'Aplicação cancelada');})}>Aplicar na conta Microsoft</button>}</div><p className="muted">{account?.kind==='offline'?'A associação é local ao launcher. Minecraft vanilla offline não carrega automaticamente esta skin e servidores podem exigir um mod próprio.':'A aplicação oficial exige uma conta proprietária do Minecraft e o aplicativo Microsoft configurado. Você pode sempre exportar o PNG.'}</p></section>
    </>}
  </section>;
}
