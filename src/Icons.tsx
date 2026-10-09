import type { CSSProperties } from 'react';
export type IconName = 'home' | 'box' | 'user' | 'skin' | 'mods' | 'settings' | 'play' | 'arrow' | 'download' | 'check' | 'close' | 'refresh' | 'folder' | 'globe' | 'shield' | 'log' | 'plus' | 'copy' | 'stop' | 'cloud';
const paths: Record<IconName, string> = {
  home: 'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z',
  box: 'm12 3 9 5-9 5-9-5 9-5Zm-9 5v9l9 5 9-5V8M12 13v9',
  user: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2',
  skin: 'M7 3 12 5l5-2 4 4-3 3v11H6V10L3 7l4-4Zm-1 7h12',
  mods: 'M12 3 3 8l9 5 9-5-9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
  settings: 'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3Zm7 9a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  play: 'm8 4 12 8-12 8V4Z', arrow: 'M5 12h14m-6-6 6 6-6 6', download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  check: 'm5 12 4 4L19 6', close: 'm6 6 12 12M6 18 18 6', refresh: 'M20 8a8 8 0 1 0 0 8M20 3v5h-5',
  folder: 'M3 6h7l2 3h9v11H3V6Z', globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c-5 5-5 13 0 18 5-5 5-13 0-18',
  shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6', log: 'M6 3h9l4 4v14H6V3Zm3 8h7m-7 4h7',
  plus: 'M12 5v14M5 12h14', copy: 'M8 8h13v13H8V8ZM16 8V3H3v13h5', stop: 'M5 5h14v14H5V5Z', cloud: 'M7 18a4 4 0 0 1-.4-8A5.5 5.5 0 0 1 17 8a4 4 0 1 1 0 10Z',
};
export function Icon({ name, size = 18, style }: { name: IconName; size?: number; style?: CSSProperties }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}><path d={paths[name]} /></svg>; }
export function Saturn({ className = '' }: { className?: string }) { return <svg className={className} viewBox="0 0 600 400" fill="none" aria-hidden="true"><defs><linearGradient id="planet" x1="150" y1="70" x2="430" y2="310" gradientUnits="userSpaceOnUse"><stop stopColor="#f3d8a8"/><stop offset=".35" stopColor="#b99264"/><stop offset=".72" stopColor="#624b3b"/><stop offset="1" stopColor="#282327"/></linearGradient><linearGradient id="ring" x1="90" y1="340" x2="500" y2="80" gradientUnits="userSpaceOnUse"><stop stopColor="#c6a878" stopOpacity=".1"/><stop offset=".4" stopColor="#d4b786"/><stop offset="1" stopColor="#796045" stopOpacity=".4"/></linearGradient><clipPath id="disc"><circle cx="300" cy="190" r="112"/></clipPath></defs><g transform="rotate(-24 300 190)"><ellipse cx="300" cy="190" rx="246" ry="65" stroke="url(#ring)" strokeWidth="24"/><ellipse cx="300" cy="190" rx="213" ry="53" stroke="url(#ring)" strokeWidth="4"/><circle cx="300" cy="190" r="112" fill="url(#planet)"/><g clipPath="url(#disc)" opacity=".18" stroke="#fff0d2"><path d="M165 110h290M165 135h290M165 152h290M165 166h290M165 184h290M165 215h290M165 234h290M165 257h290" strokeWidth="8"/></g><path d="M54 190a246 65 0 0 0 492 0" stroke="url(#ring)" strokeWidth="24"/><path d="M87 190a213 53 0 0 0 426 0" stroke="url(#ring)" strokeWidth="4"/></g><circle cx="80" cy="75" r="2" fill="#d4b786"/><circle cx="498" cy="308" r="1.5" fill="#d4b786"/><path d="M485 64v12m-6-6h12" stroke="#d4b786" opacity=".7"/></svg>; }
