import { useEffect, useState, type FormEvent } from 'react';
import type { MatrixAuthState, MatrixDriveBackup, MatrixDriveState } from '../shared/matrix-account';
import { Icon } from './Icons';
import googleLogo from './assets/providers/google.png';
import discordLogo from './assets/providers/discord.svg';
import './matrix-account.css';

function readableSize(size: number): string {
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(1)} GB`;
  if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024).toFixed(0)} KB`;
}

function ProfileImage({ state }: { state: MatrixAuthState }) {
  const [failed, setFailed] = useState(false); const [loaded, setLoaded] = useState(false);
  const identity = state.identity;
  const url = identity?.avatarUrl;
  return <div className="matrix-avatar matrix-avatar-large" role="img" aria-label={identity ? `Avatar de ${identity.displayName}` : 'Conta MATRIX'}>
    {!loaded && <span aria-hidden="true">{identity?.displayName.slice(0, 2).toUpperCase() ?? <Icon name="user" size={25}/>}</span>}
    {url && !failed && <img className={loaded ? 'loaded' : ''} src={url} alt="" referrerPolicy="no-referrer" decoding="async" onLoad={() => setLoaded(true)} onError={() => { setFailed(true); setLoaded(false); }}/>}
  </div>;
}

export function MatrixAccountPage({ state, drive }: { state: MatrixAuthState; drive: MatrixDriveState }) {
  const [busy, setBusy] = useState(false); const [email, setEmail] = useState(''); const [code, setCode] = useState('');
  const [sent, setSent] = useState(false); const [emailExpanded, setEmailExpanded] = useState(false);
  const [message, setMessage] = useState(''); const [error, setError] = useState('');
  const [driveBusy, setDriveBusy] = useState(false); const [driveError, setDriveError] = useState(''); const [driveMessage, setDriveMessage] = useState('');
  const [backups, setBackups] = useState<MatrixDriveBackup[]>([]); const [loadingBackups, setLoadingBackups] = useState(false);

  async function action(work: () => Promise<unknown>, success?: string) {
    setBusy(true); setError(''); setMessage('');
    try { await work(); if (success) setMessage(success); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function loadBackups() {
    setLoadingBackups(true); setDriveError('');
    try { setBackups(await window.matrix!.invoke('matrix.drive.list')); }
    catch (e) { setDriveError((e as Error).message); }
    finally { setLoadingBackups(false); }
  }
  async function driveAction(work: () => Promise<unknown>, success: string, reload = false) {
    setDriveBusy(true); setDriveError(''); setDriveMessage('');
    try { await work(); setDriveMessage(success); if (reload) await loadBackups(); }
    catch (e) { setDriveError((e as Error).message); }
    finally { setDriveBusy(false); }
  }
  useEffect(() => { if (drive.connected) void loadBackups(); else setBackups([]); }, [drive.connected]);
  function requestCode(e: FormEvent) { e.preventDefault(); void action(async () => { await window.matrix!.invoke('matrix.auth.email.request', { email }); setSent(true); }, 'Código enviado. Confira seu e-mail.'); }
  function verifyCode(e: FormEvent) { e.preventDefault(); void action(() => window.matrix!.invoke('matrix.auth.email.verify', { code }), 'Conta MATRIX conectada.'); }
  const providerBusy = busy || driveBusy;

  return <div className="matrix-account-page">
    <section className="matrix-account-hero panel">
      {state.signedIn ? <ProfileImage key={state.identity?.avatarUrl ?? state.identity?.id} state={state}/> : <div className="matrix-account-hero-icon"><Icon name="cloud" size={30}/></div>}
      <div className="matrix-account-hero-copy">
        <span className="eyebrow">SUA IDENTIDADE NA COMUNIDADE</span>
        <h2>{state.signedIn ? `Olá, ${state.identity?.displayName ?? 'jogador'}` : 'Sua comunidade. Seu espaço.'}</h2>
        <p>{state.signedIn ? 'Sua Conta MATRIX está conectada. Gerencie seu perfil e seus backups pessoais em um só lugar.' : 'A Conta MATRIX conecta seus recursos da comunidade. Ela é separada da conta Microsoft do Minecraft e não é necessária para jogar localmente.'}</p>
        {!state.signedIn && <div className="matrix-benefits"><span><Icon name="shield" size={14}/> Login protegido no navegador</span><span><Icon name="cloud" size={14}/> Backups opcionais no seu Drive</span></div>}
      </div>
      {state.signedIn && state.identity && <div className="matrix-profile-meta">
        {state.identity.email && <p>{state.identity.email}</p>}
        <span className="matrix-profile-status">Conta conectada · {state.identity.providers.join(', ') || 'provedor indisponível'}</span>
        <button className="button" disabled={providerBusy} onClick={() => void action(() => window.matrix!.invoke('matrix.auth.logout'), 'Sessão MATRIX encerrada neste computador.')}>{busy ? 'Aguarde…' : 'Sair da Conta MATRIX'}</button>
      </div>}
    </section>

    {!state.configured && <section className="panel settings-section"><div className="settings-heading"><Icon name="shield"/><h3>Conta MATRIX ainda não configurada</h3></div><p>O administrador precisa configurar o Supabase para habilitar login Google, Discord e e-mail. Sua conta Minecraft e seus arquivos locais continuam funcionando sem isso.</p><p className="muted">O launcher nunca pede sua senha Google ou Discord. A autenticação acontece no navegador e a sessão fica no cofre seguro do sistema.</p></section>}

    {!state.signedIn && state.configured && <section className="matrix-login-panel panel">
      <div className="matrix-login-intro"><span className="eyebrow">ENTRE OU CRIE SUA CONTA</span><h3>Escolha como entrar</h3><p>Use um provedor existente ou receba um código no e-mail. A senha permanece com o provedor.</p></div>
      <div className="matrix-login-providers">
        <button className="button matrix-provider-button matrix-google" disabled={providerBusy} onClick={() => void action(() => window.matrix!.invoke('matrix.auth.google'))}><span className="provider-mark" aria-hidden="true"><img src={googleLogo} alt=""/></span><span>Continuar com Google</span><Icon name="arrow" size={16}/></button>
        <button className="button matrix-provider-button matrix-discord" disabled={providerBusy} onClick={() => void action(() => window.matrix!.invoke('matrix.auth.discord'))}><span className="provider-mark discord-mark" aria-hidden="true"><img src={discordLogo} alt=""/></span><span>Continuar com Discord</span><Icon name="arrow" size={16}/></button>
        <button className="text-link matrix-email-toggle" disabled={providerBusy} aria-expanded={emailExpanded} onClick={() => setEmailExpanded(open => !open)}>{emailExpanded ? 'Fechar login por e-mail' : 'Entrar com código por e-mail'} <Icon name="arrow" size={14}/></button>
      </div>
      {emailExpanded && <form className="matrix-email-form" onSubmit={sent ? verifyCode : requestCode}>
        <label className="field"><span>E-mail</span><input type="email" autoComplete="email" maxLength={254} required value={email} disabled={sent || busy} onChange={e => setEmail(e.target.value)}/></label>
        {sent && <label className="field"><span>Código recebido</span><input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6,8}" minLength={6} maxLength={8} required value={code} onChange={e => setCode(e.target.value)}/></label>}
        <div className="inline-actions"><button className="button primary" type="submit" disabled={providerBusy}>{busy ? 'Aguarde…' : sent ? 'Verificar código' : 'Enviar código'}</button>{sent && <button className="button" type="button" disabled={busy} onClick={() => { setSent(false); setCode(''); }}>Usar outro e-mail</button>}</div>
        <p className="muted">A entrega depende do serviço de e-mail e dos limites configurados no Supabase.</p>
      </form>}
      <div className="matrix-login-footnote"><Icon name="shield" size={15}/> A Conta MATRIX é opcional e não substitui a conta Microsoft exigida para jogar em servidores autenticados.</div>
    </section>}

    {error && <p className="matrix-account-message error" role="alert">{error}</p>}{message && <p className="matrix-account-message success" role="status">{message}</p>}

    <section className="matrix-drive-panel panel">
      <header className="matrix-drive-heading"><div className="matrix-drive-mark"><Icon name="cloud" size={22}/></div><div><span className="eyebrow">ARMAZENAMENTO PESSOAL</span><h3>Google Drive</h3><p>Backups manuais salvos diretamente na sua conta Google.</p></div><span className={`matrix-drive-status ${drive.connected ? 'connected' : ''}`}><i/>{drive.connected ? 'Conectado' : 'Desconectado'}</span></header>
      {!drive.configured ? <div className="matrix-drive-empty"><p>O administrador ainda não configurou a integração segura do Google Drive no Supabase.</p></div> : !drive.connected ? <div className="matrix-drive-empty"><p>{state.signedIn ? 'Conecte o Drive somente quando quiser criar ou restaurar backups. O MATRIX solicita acesso limitado aos arquivos criados pelo próprio launcher.' : 'Entre na Conta MATRIX acima para habilitar os backups. Depois, autorize o Google Drive separadamente no navegador.'}</p><button className="button primary" disabled={driveBusy || !state.signedIn} onClick={() => void driveAction(() => window.matrix!.invoke('matrix.drive.connect'), 'Google Drive conectado.')}>{driveBusy ? 'Aguardando autorização…' : 'Conectar Google Drive'}</button></div> : <>
        <div className="matrix-drive-actions"><button className="button primary" disabled={driveBusy || busy} onClick={() => void driveAction(() => window.matrix!.invoke('matrix.drive.backup', 'folder'), 'Backup enviado ao Google Drive.', true)}><Icon name="folder" size={16}/> Backup de uma pasta</button><button className="button" disabled={driveBusy || busy} onClick={() => void driveAction(() => window.matrix!.invoke('matrix.drive.backup', 'files'), 'Backup enviado ao Google Drive.', true)}>Selecionar arquivos</button><button className="button" disabled={driveBusy || busy || loadingBackups} onClick={() => void loadBackups()}><Icon name="refresh" size={15}/> Atualizar lista</button><button className="text-link matrix-drive-disconnect" disabled={driveBusy || busy} onClick={() => void driveAction(() => window.matrix!.invoke('matrix.drive.disconnect'), 'Drive desconectado.')}>Desconectar</button></div>
        <p className="matrix-drive-note">O Minecraft precisa estar fechado para criar ou restaurar um backup. A restauração sempre cria uma pasta nova e não sobrescreve arquivos existentes. Não selecione pastas de credenciais ou tokens.</p>
        {loadingBackups ? <p className="muted">Carregando backups do Drive…</p> : backups.length ? <div className="matrix-backup-list">{backups.map(backup => <article className="matrix-backup-row" key={backup.id}><div className="matrix-backup-icon"><Icon name="folder" size={17}/></div><div className="matrix-backup-info"><strong>{backup.name}</strong><small>{readableSize(backup.size)}{backup.createdAt ? ` · ${new Date(backup.createdAt).toLocaleString()}` : ''}</small></div><button className="button" disabled={driveBusy || busy} onClick={() => void driveAction(() => window.matrix!.invoke('matrix.drive.restore', backup.id), 'Backup restaurado em uma pasta nova.')}>Restaurar cópia</button><button className="text-link matrix-delete-backup" disabled={driveBusy || busy} onClick={() => void driveAction(() => window.matrix!.invoke('matrix.drive.delete', backup.id), 'Backup excluído do Drive.', true)}>Excluir</button></article>)}</div> : !driveError && <div className="matrix-drive-no-backups"><Icon name="cloud" size={22}/><span>Nenhum backup MATRIX encontrado no seu Drive.</span></div>}
      </>}
      {driveError && <p className="matrix-account-message error" role="alert">{driveError}</p>}{driveMessage && <p className="matrix-account-message success" role="status">{driveMessage}</p>}
    </section>
    <p className="matrix-privacy-note">As contas Minecraft, os mundos e os projetos continuam locais até você escolher explicitamente o que enviar ao seu Google Drive. A Conta MATRIX não sincroniza esses dados automaticamente.</p>
  </div>;
}
