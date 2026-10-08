import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icons';

export type TourStep = { page: 'home' | 'installations' | 'modcenter' | 'smart' | 'skin'; target: string; title: string; text: string };
export const welcomeTour: TourStep[] = [
  { page: 'home', target: '[data-tour="home-play"]', title: 'Início e botão Jogar', text: 'Aqui você confere a conta, a instalação selecionada e inicia o Minecraft quando estiver pronto.' },
  { page: 'installations', target: '[data-page="installations"]', title: 'Instalações', text: 'Cada perfil mantém versão, loader e arquivos de jogo separados. Mundos e configurações ficam na pasta daquela instância.' },
  { page: 'modcenter', target: '[data-page="modcenter"]', title: 'MATRIX Mod Center', text: 'Escolha uma instância para pesquisar projetos reais no Modrinth e gerenciar conteúdo compatível.' },
  { page: 'smart', target: '[data-page="smart"]', title: 'Smart Install', text: 'Monte perfis otimizados pelo fluxo existente. A disponibilidade atual dos presets é Minecraft 1.21.1 com Fabric.' },
  { page: 'skin', target: '[data-page="skin"]', title: 'Skin Studio', text: 'Crie e edite skins localmente com ferramentas 2D e prévia 3D.' },
];

export function WelcomeTour({ index, close, move }: { index: number; close: () => void; move: (index: number) => void }) {
  const [rect, setRect] = useState<DOMRect>(); const step = welcomeTour[index];
  useEffect(() => {
    let observer: ResizeObserver | undefined; let target: Element | null;
    const measure = () => { target = document.querySelector(step.target); if (!target) { setRect(undefined); return; } target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }); const box = target.getBoundingClientRect(); setRect(box); observer?.disconnect(); observer = new ResizeObserver(() => setRect(target!.getBoundingClientRect())); observer.observe(target); };
    const frame = requestAnimationFrame(measure); window.addEventListener('resize', measure); window.addEventListener('scroll', measure, true);
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [step]);
  const left = rect ? Math.min(Math.max(18, rect.left), window.innerWidth - 370) : Math.max(18, window.innerWidth / 2 - 170);
  const top = rect ? Math.min(Math.max(18, rect.bottom + 14), window.innerHeight - 230) : window.innerHeight / 2 - 60;
  const shade = rect ? { top: rect.top - 5, left: rect.left - 5, right: window.innerWidth - rect.right - 5, bottom: window.innerHeight - rect.bottom - 5 } : undefined;
  return createPortal(<div className="tour-layer" aria-label="Tour guiado">{shade ? <><div className="tour-shade" style={{ top: 0, left: 0, right: 0, height: Math.max(0, shade.top) }}/><div className="tour-shade" style={{ top: rect!.top - 5, left: 0, width: Math.max(0, shade.left), height: rect!.height + 10 }}/><div className="tour-shade" style={{ top: rect!.top - 5, left: rect!.right + 5, right: 0, height: rect!.height + 10 }}/><div className="tour-shade" style={{ top: rect!.bottom + 5, left: 0, right: 0, bottom: 0 }}/><div className="tour-spotlight" style={{ top: rect!.top - 5, left: rect!.left - 5, width: rect!.width + 10, height: rect!.height + 10 }} aria-hidden="true"/></> : <div className="tour-shade" style={{ inset: 0 }}/>}<section className="tour-card" style={{ top, left }} role="dialog" aria-modal="true" aria-labelledby="tour-title"><div className="tour-card-heading"><span className="eyebrow">GUIA · {index + 1} DE {welcomeTour.length}</span><button className="icon-button" onClick={close} aria-label="Pular tour"><Icon name="close" size={16}/></button></div><h2 id="tour-title">{step.title}</h2><p>{rect ? step.text : 'Esta seção ainda não está disponível neste momento. Você pode continuar o tour ou encerrar.'}</p><footer><button className="text-link" onClick={close}>Pular</button><div><button className="button" disabled={index === 0} onClick={() => move(index - 1)}>Voltar</button><button className="button primary" onClick={() => index === welcomeTour.length - 1 ? close() : move(index + 1)}>{index === welcomeTour.length - 1 ? 'Concluir' : 'Próximo'} <Icon name="arrow" size={14}/></button></div></footer></section></div>, document.body);
}
