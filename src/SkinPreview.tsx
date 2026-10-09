import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { AmbientLight, CanvasTexture, Color, DirectionalLight, Material, Mesh, MOUSE, NearestFilter, PerspectiveCamera, Plane, Quaternion, Raycaster, Scene, SRGBColorSpace, Vector2, Vector3, WebGLRenderer } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PlayerObject, RunningAnimation, WalkingAnimation, type PlayerAnimation } from 'skinview3d';
import type { BodyPart, SkinCameraSettings, SkinLayer, SkinModel } from '../shared/skin';

export interface SkinPreviewProps {
  pixels: Uint8ClampedArray; version: number; model: SkinModel;
  part: BodyPart | 'all'; layer: SkinLayer; outerVisible: boolean; baseVisible: boolean;
  camera: SkinCameraSettings;
  onCameraChange: (camera: SkinCameraSettings) => void;
  onPaint: (x: number, y: number, phase: 'start' | 'move' | 'end' | 'cancel') => void;
}
export interface SkinPreviewHandle { exportPNG: (transparent: boolean) => string }
const parts: BodyPart[] = ['head', 'body', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg'];
const labels: Record<BodyPart, string> = { head: 'Cabeça', body: 'Tronco', rightArm: 'Braço D', leftArm: 'Braço E', rightLeg: 'Perna D', leftLeg: 'Perna E' };
interface PreviewRuntime {
  renderer: WebGLRenderer; scene: Scene; camera: PerspectiveCamera; player: PlayerObject;
  texture: CanvasTexture; textureContext: CanvasRenderingContext2D; controls: OrbitControls;
  light: DirectionalLight; requestRender: () => void; setAnimation: (pose: string, paused: boolean, fps: number) => void;
  endStroke: () => void; focus: (point: Vector3) => void; view: (direction: Vector3) => void; reset: () => void;
}

function CameraSettingsPanel({ camera, onChange }: { camera: SkinCameraSettings; onChange: (changes: Partial<SkinCameraSettings>) => void }) {
  return <details><summary>Camera preferences</summary><div className="skin-camera-settings">
    <label>Órbita <input aria-label="Sensibilidade da órbita" type="range" min="0.25" max="2.5" step="0.05" value={camera.rotateSensitivity} onChange={e=>onChange({rotateSensitivity:Number(e.target.value)})}/></label>
    <label>Pan <input aria-label="Sensibilidade do pan" type="range" min="0.25" max="2.5" step="0.05" value={camera.panSensitivity} onChange={e=>onChange({panSensitivity:Number(e.target.value)})}/></label>
    <label>Zoom <input aria-label="Velocidade do zoom" type="range" min="0.25" max="2.5" step="0.05" value={camera.zoomSensitivity} onChange={e=>onChange({zoomSensitivity:Number(e.target.value)})}/></label>
    <label><input type="checkbox" checked={camera.zoomToCursor} onChange={e=>onChange({zoomToCursor:e.target.checked})}/> Zoom no cursor</label>
    <label><input type="checkbox" checked={camera.smooth} onChange={e=>onChange({smooth:e.target.checked})}/> Movimentos suaves</label>
    <label><input type="checkbox" checked={camera.invertRotation} onChange={e=>onChange({invertRotation:e.target.checked})}/> Inverter órbita</label>
    <label><input type="checkbox" checked={camera.showGizmo} onChange={e=>onChange({showGizmo:e.target.checked})}/> Mostrar gizmo</label>
  </div></details>;
}

/** Both views consume the same RGBA buffer. This component never owns an editing history. */
export const SkinPreview = forwardRef<SkinPreviewHandle, SkinPreviewProps>(function SkinPreview(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const runtime = useRef<PreviewRuntime | undefined>(undefined);
  const latest = useRef(props); latest.current = props;
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(editing); editingRef.current = editing;
  const [pose, setPose] = useState('standing');
  const [paused, setPaused] = useState(true);
  const [fps, setFps] = useState(30);
  const [brightness, setBrightness] = useState(2);
  const [background, setBackground] = useState('#19181b');
  const [hidden, setHidden] = useState<BodyPart[]>([]);
  const [fullscreen, setFullscreen] = useState(false);
  const [axis, setAxis] = useState([0, 0, 0, 1]);
  const [cameraSettings, setCameraSettings] = useState(props.camera);
  useEffect(() => setCameraSettings(props.camera), [props.camera]);
  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === root.current);
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.fullscreenElement !== root.current) return;
      event.preventDefault();
      void document.exitFullscreen().catch(() => setError('Nao foi possavel sair da tela cheia.'));
    };
    document.addEventListener('fullscreenchange', changed);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('fullscreenchange', changed); document.removeEventListener('keydown', escape); };
  }, []);
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement === root.current) await document.exitFullscreen();
      else await root.current?.requestFullscreen();
    } catch { setError('Nao foi possavel alterar a tela cheia da pravia.'); }
  }

  useImperativeHandle(ref, () => ({ exportPNG(transparent) {
    const view = runtime.current;
    if (!view || view.renderer.getContext().isContextLost()) throw new Error('A prévia 3D não está disponível neste computador.');
    const previous = view.scene.background;
    const oldSize = view.renderer.getSize(new Vector2()), oldPixelRatio = view.renderer.getPixelRatio();
    const buffer = view.renderer.getDrawingBufferSize(new Vector2());
    const exportScale = Math.min(1, 2048 / Math.max(buffer.x, buffer.y));
    if (transparent) view.scene.background = null;
    try {
      if (exportScale < 1) {
        view.renderer.setPixelRatio(1);
        view.renderer.setSize(Math.max(1, Math.floor(buffer.x * exportScale)), Math.max(1, Math.floor(buffer.y * exportScale)), false);
      }
      view.renderer.render(view.scene, view.camera); return view.renderer.domElement.toDataURL('image/png');
    } finally {
      if (exportScale < 1) { view.renderer.setPixelRatio(oldPixelRatio); view.renderer.setSize(oldSize.x, oldSize.y, false); }
      view.scene.background = previous; view.requestRender();
    }
  } }), []);

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let renderer: WebGLRenderer;
    try { renderer = new WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'low-power' }); }
    catch { setError('Este computador nao disponibilizou WebGL. A ediaao 2D e a exportaaao da skin continuam disponaveis.'); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.domElement.setAttribute('aria-label', 'Minecraft skin preview');
    renderer.domElement.style.touchAction = 'none';
    renderer.domElement.style.display = 'block'; renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%';
    container.appendChild(renderer.domElement);
    const scene = new Scene(); scene.background = new Color('#19181b');
    const camera = new PerspectiveCamera(38, 1, 0.1, 300);
    camera.position.set(32, 13, 65);
    const player = new PlayerObject();
    player.cape.visible = false; player.elytra.visible = false; player.ears.visible = false;
    scene.add(player);
    scene.add(new AmbientLight(0xffffff, 1.2));
    const light = new DirectionalLight(0xffffff, 2); light.position.set(-30, 50, 60); scene.add(light);
    const textureCanvas = document.createElement('canvas'); textureCanvas.width = textureCanvas.height = 64;
    const textureContext = textureCanvas.getContext('2d')!;
    const texture = new CanvasTexture(textureCanvas);
    texture.magFilter = texture.minFilter = NearestFilter; texture.generateMipmaps = false; texture.colorSpace = SRGBColorSpace;
    player.skin.map = texture;
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0); controls.enableDamping = true; controls.dampingFactor = 0.08; controls.enablePan = true; controls.screenSpacePanning = true;
    controls.minDistance = 6; controls.maxDistance = 110; controls.zoomToCursor = true;
    controls.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.ROTATE, RIGHT: MOUSE.PAN }; controls.update();
    let disposed = false, contextLost = false, frame = 0, resizeFrame = 0, dampingFrames = 0, animation: PlayerAnimation | undefined, animationPose = 'standing', animationPaused = true, maxFps = 30, lastFrame = 0;
    let zoomTarget: number | undefined;
  let targetTween: { from: Vector3; to: Vector3; fromPosition: Vector3; toPosition: Vector3; started: number; duration: number } | undefined;
    const draw = (now: number) => {
      frame = 0;
      if (disposed || document.hidden || contextLost) return;
      const playing = animation && !animationPaused;
      if (lastFrame && now - lastFrame < 1000 / maxFps) { frame = requestAnimationFrame(draw); return; }
      const delta = lastFrame ? Math.min((now - lastFrame) / 1000, 0.1) : 1 / maxFps;
      if (dampingFrames > 0) { controls.update(); dampingFrames--; }
      if (targetTween) {
        const t = Math.min(1, (now - targetTween.started) / targetTween.duration), eased = t * t * (3 - 2 * t);
        controls.target.lerpVectors(targetTween.from, targetTween.to, eased);
        camera.position.lerpVectors(targetTween.fromPosition, targetTween.toPosition, eased);
        if (t >= 1) targetTween = undefined;
        controls.update();
      }
      if (zoomTarget !== undefined) {
        const offset = camera.position.clone().sub(controls.target), distance = offset.length();
        const next = distance + (zoomTarget - distance) * (1 - Math.exp(-18 * delta));
        camera.position.copy(controls.target).add(offset.setLength(Math.abs(zoomTarget - next) < 0.02 ? zoomTarget : next));
        if (Math.abs(zoomTarget - next) < 0.02) zoomTarget = undefined;
        controls.update();
      }
      if (playing) animation!.update(player, delta);
      renderer.render(scene, camera); lastFrame = now;
      if ((playing || zoomTarget !== undefined || targetTween || dampingFrames > 0) && !frame) frame = requestAnimationFrame(draw);
    };
    const requestRender = () => { if (!disposed && !contextLost && !frame && !document.hidden) frame = requestAnimationFrame(draw); };
    const scheduleResize = () => { if (!resizeFrame) resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; resize(); }); };
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); event.stopImmediatePropagation();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? container.clientHeight : 1;
      const change = Math.max(-150, Math.min(150, event.deltaY * unit));
      const distance = zoomTarget ?? camera.position.distanceTo(controls.target);
      zoomTarget = Math.max(controls.minDistance, Math.min(controls.maxDistance, distance * Math.exp(change * 0.002 * latest.current.camera.zoomSensitivity)));
      if (latest.current.camera.zoomToCursor) {
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
        camera.updateMatrixWorld(true); raycaster.setFromCamera(pointer, camera);
        const normal = camera.getWorldDirection(new Vector3()), plane = new Plane().setFromNormalAndCoplanarPoint(normal, controls.target);
        const point = raycaster.ray.intersectPlane(plane, new Vector3());
        if (point) {
          const amount = 1 - zoomTarget / distance;
          const from = controls.target.clone(), to = from.clone().add(point.sub(from).multiplyScalar(amount)), translation = to.clone().sub(from);
          targetTween = { from, to, fromPosition: camera.position.clone(), toPosition: camera.position.clone().add(translation), started: performance.now(), duration: latest.current.camera.smooth ? 160 : 1 };
        }
      }
      requestRender();
    };
    const lost = (event: Event) => { event.preventDefault(); contextLost = true; cancelAnimationFrame(frame); frame = 0; setError('The 3D preview lost access to the graphics card. 2D editing is still available.'); };
    const restored = () => { contextLost = false; texture.needsUpdate = true; lastFrame = 0; setError(''); requestRender(); };
    const visibility = () => { if (document.hidden) { cancelAnimationFrame(frame); frame = 0; } else { lastFrame = 0; requestRender(); } };
    const resize = () => {
      const rect = container.getBoundingClientRect(), width = Math.floor(rect.width), height = Math.floor(rect.height);
      if (width < 1 || height < 1) return;
      // CSS owns the visible size; WebGL owns only the drawing-buffer resolution.
      renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); requestRender();
    };
    const observer = new ResizeObserver(scheduleResize); observer.observe(container); if (root.current) observer.observe(root.current);
    window.addEventListener('resize', scheduleResize); document.addEventListener('fullscreenchange', scheduleResize);
    const controlsChanged = () => { setAxis([camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w]); requestRender(); };
    controls.addEventListener('change', controlsChanged);
    controls.addEventListener('start', () => { dampingFrames = latest.current.camera.smooth ? 90 : 0; requestRender(); });
    controls.addEventListener('end', () => { dampingFrames = latest.current.camera.smooth ? 24 : 0; requestRender(); });
    document.addEventListener('visibilitychange', visibility);
    const raycaster = new Raycaster(); const pointer = new Vector2();
    let stroke: number | undefined, lastPixel: [number, number] = [0, 0], strokeStart: [number, number] = [0, 0], dragged = false;
    let pendingClick: { pixel: [number, number]; timer: ReturnType<typeof setTimeout>; at: number } | undefined, ignoredPointer: number | undefined;
    const endStroke = () => {
      if (pendingClick) { clearTimeout(pendingClick.timer); const pixel = pendingClick.pixel; pendingClick = undefined; latest.current.onPaint(...pixel, 'end'); }
      if (stroke !== undefined) { stroke = undefined; latest.current.onPaint(...lastPixel, 'end'); }
    };
    const lostCapture = () => { if (stroke !== undefined) endStroke(); };
    const hit = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      scene.updateMatrixWorld(true); camera.updateMatrixWorld(true); raycaster.setFromCamera(pointer, camera);
      const p = latest.current;
      // Raycaster does not account for transparent texels, so an invisible outer
      // layer can otherwise intercept clicks intended for the base layer.
      const targets = parts.filter(part => player.skin[part].visible && (p.part === 'all' || p.part === part))
        .map(part => p.layer === 'base' ? player.skin[part].innerLayer : player.skin[part].outerLayer)
        .filter(target => target.visible);
      const intersection = raycaster.intersectObjects(targets, true)[0];
      if (!intersection) return;
      return { pixel: intersection.uv ? [Math.min(63, Math.max(0, Math.floor(intersection.uv.x * 64))), Math.min(63, Math.max(0, Math.floor((1 - intersection.uv.y) * 64)))] as [number, number] : undefined, point: intersection.point.clone() };
    };
    const cameraFocus = (point: Vector3) => {
      const offset = camera.position.clone().sub(controls.target), direction = offset.length() ? offset.normalize() : new Vector3(0, 0, 1);
      const from = controls.target.clone(), to = point.clone(), fromPosition = camera.position.clone();
      const distance = Math.min(camera.position.distanceTo(controls.target), 20);
      targetTween = { from, to, fromPosition, toPosition: to.clone().add(direction.multiplyScalar(distance)), started: performance.now(), duration: latest.current.camera.smooth ? 360 : 1 };
      zoomTarget = undefined;
      dampingFrames = 0; requestRender();
    };
    const setView = (direction: Vector3) => {
      const distance = camera.position.distanceTo(controls.target);
      camera.position.copy(controls.target).add(direction.normalize().multiplyScalar(distance));
      camera.up.set(0, Math.abs(direction.y) > 0.98 ? 0 : 1, Math.abs(direction.y) > 0.98 ? (direction.y > 0 ? -1 : 1) : 0);
      controls.update(); requestRender();
    };
    const resetCamera = () => { targetTween = undefined; zoomTarget = undefined; controls.target.set(0, 0, 0); camera.position.set(32, 13, 65); camera.up.set(0, 1, 0); controls.update(); requestRender(); };
    const keyboard = (event: KeyboardEvent) => {
      if (/INPUT|TEXTAREA|SELECT/.test((event.target as HTMLElement)?.tagName ?? '') || (event.target as HTMLElement)?.isContentEditable) return;
      if (event.code === 'Home') { event.preventDefault(); resetCamera(); return; }
      const presets: Record<string, Vector3> = { Numpad1: new Vector3(0,0,1), Numpad3: new Vector3(1,0,0), Numpad7: new Vector3(0,1,0) };
      const preset = presets[event.code]; if (preset) { event.preventDefault(); setView(event.ctrlKey ? preset.negate() : preset); }
    };
    document.addEventListener('keydown', keyboard);
    const focusAtPointer = (event: MouseEvent | PointerEvent) => {
      const result = hit(event as PointerEvent); if (result) cameraFocus(result.point);
    };
    const down = (event: PointerEvent) => {
      if (event.button === 1) controls.mouseButtons.MIDDLE = event.shiftKey ? MOUSE.PAN : MOUSE.ROTATE;
      if (!editingRef.current || event.button !== 0) return;
      if (pendingClick && performance.now() - pendingClick.at < 450) {
        event.preventDefault(); event.stopPropagation(); clearTimeout(pendingClick.timer);
        const previous = pendingClick.pixel; pendingClick = undefined; latest.current.onPaint(...previous, 'cancel');
        ignoredPointer = event.pointerId; const result = hit(event); if (result) cameraFocus(result.point); return;
      }
      event.preventDefault(); event.stopPropagation();
      const result = hit(event), pixel = result?.pixel; if (!pixel) return;
      stroke = event.pointerId; lastPixel = pixel; strokeStart = [event.clientX, event.clientY]; dragged = false;
      renderer.domElement.setPointerCapture(event.pointerId); latest.current.onPaint(...pixel, 'start');
    };
    const move = (event: PointerEvent) => {
      if (stroke === event.pointerId && Math.hypot(event.clientX - strokeStart[0], event.clientY - strokeStart[1]) > 3) dragged = true;
      if (stroke !== event.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      const pixel = hit(event)?.pixel; if (pixel) { lastPixel = pixel; latest.current.onPaint(...pixel, 'move'); }
    };
    const up = (event: PointerEvent) => {
      if (event.button === 1) controls.mouseButtons.MIDDLE = MOUSE.ROTATE;
      if (ignoredPointer === event.pointerId) { ignoredPointer = undefined; return; }
      if (stroke !== event.pointerId) return;
      event.stopPropagation(); stroke = undefined;
      if (event.type === 'pointercancel' || dragged) latest.current.onPaint(...lastPixel, 'end');
      else {
        const pixel = lastPixel, at = performance.now();
        const timer = setTimeout(() => { pendingClick = undefined; latest.current.onPaint(...pixel, 'end'); }, 450);
        pendingClick = { pixel, timer, at };
      }
      if (renderer.domElement.hasPointerCapture(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId);
    };
    const doubleClick = (event: MouseEvent) => { event.preventDefault(); event.stopImmediatePropagation(); if (pendingClick) { clearTimeout(pendingClick.timer); latest.current.onPaint(...pendingClick.pixel, 'cancel'); pendingClick = undefined; } focusAtPointer(event); };
    const navigationDown = (event: PointerEvent) => { if (event.button === 1) controls.mouseButtons.MIDDLE = event.shiftKey ? MOUSE.PAN : MOUSE.ROTATE; };
    const canvas = renderer.domElement;
    canvas.addEventListener('wheel', wheel, { capture: true, passive: false });
    canvas.addEventListener('webglcontextlost', lost); canvas.addEventListener('webglcontextrestored', restored);
    canvas.addEventListener('pointerdown', navigationDown, true); canvas.addEventListener('pointerdown', down, true); canvas.addEventListener('pointermove', move, true);
    canvas.addEventListener('pointerup', up, true); canvas.addEventListener('pointercancel', up, true);
    canvas.addEventListener('dblclick', doubleClick, true);
    canvas.addEventListener('lostpointercapture', lostCapture);
    runtime.current = { renderer, scene, camera, player, texture, textureContext, controls, light, requestRender, endStroke, focus: cameraFocus, view: setView, reset: resetCamera,
      setAnimation(newPose, newPaused, newFps) {
        endStroke();
        if (animationPose !== newPose) {
          player.resetJoints(); animationPose = newPose;
          animation = newPose === 'walk' ? new WalkingAnimation() : newPose === 'run' ? new RunningAnimation() : undefined;
          if (newPose === 'greeting') { player.skin.rightArm.rotation.x = -0.9; player.skin.rightArm.rotation.z = 1.7; player.skin.head.rotation.z = -0.12; }
          if (animation && newPaused) animation.update(player, 0.2);
        }
        animationPaused = newPaused; maxFps = newFps;
        lastFrame = 0; cancelAnimationFrame(frame); frame = 0; requestRender();
      },
    };
    resize();
    return () => {
      endStroke(); disposed = true; cancelAnimationFrame(frame); cancelAnimationFrame(resizeFrame); observer.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('keydown', keyboard);
      window.removeEventListener('resize', scheduleResize); document.removeEventListener('fullscreenchange', scheduleResize);
      canvas.removeEventListener('wheel', wheel, true);
      canvas.removeEventListener('webglcontextlost', lost); canvas.removeEventListener('webglcontextrestored', restored);
      canvas.removeEventListener('pointerdown', navigationDown, true); canvas.removeEventListener('pointerdown', down, true); canvas.removeEventListener('pointermove', move, true);
      canvas.removeEventListener('pointerup', up, true); canvas.removeEventListener('pointercancel', up, true); canvas.removeEventListener('lostpointercapture', lostCapture);
      canvas.removeEventListener('dblclick', doubleClick, true);
      controls.removeEventListener('change', controlsChanged); controls.dispose();
      const materials = new Set<Material>();
      player.traverse(object => { if (object instanceof Mesh) { object.geometry.dispose(); for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material); } });
      materials.forEach(material => material.dispose()); texture.dispose(); renderer.dispose(); renderer.forceContextLoss(); canvas.remove(); runtime.current = undefined;
    };
  }, []);

  useEffect(() => {
    const view = runtime.current; if (!view) return;
    const copy = new Uint8ClampedArray(props.pixels);
    view.textureContext.putImageData(new ImageData(copy, 64, 64), 0, 0);
    view.texture.needsUpdate = true; view.player.skin.modelType = props.model === 'slim' ? 'slim' : 'default'; view.requestRender();
  }, [props.pixels, props.version, props.model]);
  useEffect(() => {
    const view = runtime.current; if (!view) return;
    view.player.skin.setInnerLayerVisible(props.baseVisible); view.player.skin.setOuterLayerVisible(props.outerVisible);
    parts.forEach(part => { view.player.skin[part].visible = !hidden.includes(part) && (props.part === 'all' || props.part === part); });
    view.requestRender();
  }, [props.baseVisible, props.outerVisible, props.part, hidden]);
  useEffect(() => { const view = runtime.current; if (view) { view.endStroke(); view.controls.mouseButtons.LEFT = editing ? undefined : MOUSE.ROTATE; view.controls.mouseButtons.MIDDLE = MOUSE.ROTATE; view.controls.mouseButtons.RIGHT = MOUSE.PAN; } }, [editing]);
  useEffect(() => {
    const view = runtime.current; if (!view) return;
    view.controls.rotateSpeed = cameraSettings.rotateSensitivity * (cameraSettings.invertRotation ? -1 : 1);
    view.controls.panSpeed = cameraSettings.panSensitivity; view.controls.zoomSpeed = cameraSettings.zoomSensitivity;
    view.controls.enableDamping = cameraSettings.smooth; view.controls.zoomToCursor = cameraSettings.zoomToCursor; view.requestRender();
  }, [cameraSettings]);
  useEffect(() => { runtime.current?.setAnimation(pose, paused, fps); }, [pose, paused, fps]);
  useEffect(() => { const view = runtime.current; if (view) { view.light.intensity = brightness; view.scene.background = new Color(background); view.requestRender(); } }, [brightness, background]);
  const angle = (direction: 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom') => {
    const vectors = { front: new Vector3(0,0,1), back: new Vector3(0,0,-1), left: new Vector3(-1,0,0), right: new Vector3(1,0,0), top: new Vector3(0,1,0), bottom: new Vector3(0,-1,0) };
    runtime.current?.view(vectors[direction]);
  };
  const updateCamera = (changes: Partial<SkinCameraSettings>) => { const next = { ...cameraSettings, ...changes }; setCameraSettings(next); props.onCameraChange(next); };
  const inverse = new Quaternion(axis[0], axis[1], axis[2], axis[3]).invert();
  const directions = [
    { name: 'X', sign: 1, vector: new Vector3(1,0,0) }, { name: 'X', sign: -1, vector: new Vector3(-1,0,0) },
    { name: 'Y', sign: 1, vector: new Vector3(0,1,0) }, { name: 'Y', sign: -1, vector: new Vector3(0,-1,0) },
    { name: 'Z', sign: 1, vector: new Vector3(0,0,1) }, { name: 'Z', sign: -1, vector: new Vector3(0,0,-1) },
  ];
  return <section className="skin-preview" ref={root}>
    <div className="skin-preview-toolbar"><strong>Prévia 3D</strong><button type="button" aria-pressed={fullscreen} onClick={() => void toggleFullscreen()}>{fullscreen ? 'Sair da tela cheia' : 'Tela cheia'}</button></div>
    <div className="skin-preview-viewport" ref={host}>{error && <p role="alert">{error}</p>}{cameraSettings.showGizmo&&<svg className="skin-camera-gizmo" viewBox="0 0 92 92" aria-label="Orientação da câmera" role="group">{directions.map(({name,sign,vector})=>{const local=vector.clone().applyQuaternion(inverse),x=46+local.x*28,y=46-local.y*28;return <g key={`${name}${sign}`} role="button" tabIndex={0} aria-label={`Vista ${name} ${sign>0?'positiva':'negativa'}`} opacity={local.z<0?.45:1} onClick={()=>runtime.current?.view(vector)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();runtime.current?.view(vector);}}}><line x1="46" y1="46" x2={x} y2={y} stroke={name==='X'?'#d97866':name==='Y'?'#79b77b':'#7598df'} strokeWidth="2"/><circle cx={x} cy={y} r="9" fill="#211f23" stroke={name==='X'?'#d97866':name==='Y'?'#79b77b':'#7598df'}/><text x={x} y={y+3} textAnchor="middle" fontSize="8" fill="#eee">{name}{sign>0?'+':'−'}</text></g>;})}</svg>}</div>
    <div className="skin-preview-controls">
      <div className="skin-row"><button type="button" aria-pressed={!editing} onClick={() => setEditing(false)}>Girar</button><button type="button" aria-pressed={editing} onClick={() => { setEditing(true); setPaused(true); }}>Pintar em 3D</button></div>
      <p className="muted">Arraste com o botão do meio para orbitar; Shift + meio desloca a câmera. Botão direito também desloca. Role para aproximar; o zoom acompanha o cursor. Duplo clique foca uma parte; Home restaura. Numpad 1, 3 e 7: frente, lado e topo (Ctrl mostra o oposto).{editing ? ' Clique pinta; a navegação continua disponível.' : ''}</p>
      <div className="skin-row"><button type="button" onClick={() => angle('front')}>Frente</button><button type="button" onClick={() => angle('back')}>Costas</button><button type="button" onClick={() => angle('left')}>Esquerda</button><button type="button" onClick={() => angle('right')}>Direita</button><button type="button" onClick={() => angle('top')}>Topo</button><button type="button" onClick={() => angle('bottom')}>Base</button><button type="button" onClick={() => runtime.current?.reset()}>Restaurar câmera</button></div>
      <div className="skin-row"><label>Pose <select value={pose} onChange={event => setPose(event.target.value)}><option value="standing">Em pé</option><option value="greeting">Acenando</option><option value="walk">Caminhada</option><option value="run">Corrida</option></select></label><button type="button" disabled={pose === 'standing' || pose === 'greeting' || editing} onClick={() => setPaused(value => !value)}>{paused ? 'Animar' : 'Pausar'}</button><label>FPS <select value={fps} onChange={event => setFps(Number(event.target.value))}><option>15</option><option>30</option><option>60</option></select></label></div>
      <div className="skin-row"><label>Luz <input aria-label="Intensidade da luz" type="range" min="0" max="4" step="0.1" value={brightness} onChange={event => setBrightness(Number(event.target.value))}/></label><label>Fundo <input type="color" value={background} onChange={event => setBackground(event.target.value)}/></label></div>
      <CameraSettingsPanel camera={cameraSettings} onChange={updateCamera}/>
      <details><summary>Partes visíveis</summary><div className="skin-part-toggles">{parts.map(part => <label key={part}><input type="checkbox" checked={!hidden.includes(part)} onChange={() => setHidden(current => current.includes(part) ? current.filter(value => value !== part) : [...current, part])}/>{labels[part]}</label>)}</div></details>
    </div>
  </section>;
});
