import { useEffect, useState } from 'react';

/** Only local pixel data travels over IPC. No account tokens or arbitrary paths. */
export function SkinAvatar({ projectId, large = false }: { projectId: string; large?: boolean }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let active = true;
    window.matrix?.invoke('skin.open', projectId).then(project => {
      if (!active) return;
      const pixels = Uint8ClampedArray.from(atob(project.pixels), c => c.charCodeAt(0));
      const texture = document.createElement('canvas'); texture.width = texture.height = 64;
      texture.getContext('2d')!.putImageData(new ImageData(pixels, 64, 64), 0, 0);
      const head = document.createElement('canvas'); head.width = head.height = 8;
      const context = head.getContext('2d')!; context.imageSmoothingEnabled = false;
      context.drawImage(texture, 8, 8, 8, 8, 0, 0, 8, 8);
      context.drawImage(texture, 40, 8, 8, 8, 0, 0, 8, 8); setUrl(head.toDataURL('image/png'));
    }).catch(() => { if (active) setUrl(''); });
    return () => { active = false; };
  }, [projectId]);
  return <span className={`avatar ${large ? 'large' : ''}`} title="Skin local do perfil" style={url ? { backgroundImage: `url(${url})`, backgroundSize: '100% 100%', imageRendering: 'pixelated' } : undefined}>{url ? '' : 'SK'}</span>;
}
