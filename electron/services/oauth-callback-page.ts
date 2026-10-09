import type { ServerResponse } from 'node:http';

export type OAuthPageKind = 'matrix' | 'drive';

export function sendOAuthCallbackPage(response: ServerResponse, kind: OAuthPageKind, success: boolean, status = success ? 200 : 400): void {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'" }).end(oauthCallbackHtml(kind, success));
}

export function oauthCallbackHtml(kind: OAuthPageKind, success: boolean): string {
  const product = kind === 'drive' ? 'GOOGLE DRIVE' : 'MATRIX COMMUNITY';
  const title = success ? (kind === 'drive' ? 'Google Drive conectado' : 'Login concluído') : 'Não foi possível concluir';
  const description = success
    ? (kind === 'drive' ? 'Sua conta Google Drive está conectada. Volte ao MATRIX Launcher para continuar.' : 'Sua Conta MATRIX está conectada. Volte ao launcher para continuar.')
    : 'A conexão não foi concluída. Volte ao launcher para conferir a mensagem e tentar novamente.';
  const icon = success
    ? '<path d="m8 12 2.7 2.7L16.5 9"/>'
    : '<path d="m9 9 6 6m0-6-6 6"/>';
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>${success ? 'MATRIX Launcher — conectado' : 'MATRIX Launcher — autorização'}</title>
  <style>
    :root{color-scheme:dark;font-family:Inter,"Segoe UI",system-ui,-apple-system,sans-serif;background:#101011;color:#f2eee8;font-synthesis:none;text-rendering:optimizeLegibility}
    *{box-sizing:border-box}html{height:100%}body{margin:0;width:100%;min-height:100vh;min-height:100svh;display:flex;align-items:center;justify-content:center;padding:24px;background:radial-gradient(ellipse at 50% 0%,#b992651c,transparent 48%),#101011}
    main{width:100%;max-width:480px;margin:auto;padding:36px 32px;text-align:center;overflow-wrap:anywhere;background:linear-gradient(150deg,#1d1b1a,#171718 60%);border:1px solid #b9926540;border-radius:18px;box-shadow:0 22px 65px #0005}
    .brand{display:flex;justify-content:center;align-items:center;gap:10px;margin-bottom:28px;color:#e3c596;font-size:12px;font-weight:700;letter-spacing:.18em}
    .brand svg{width:30px;height:30px;color:#c6a878}
    .status{width:62px;height:62px;margin:0 auto 21px;display:grid;place-items:center;border:1px solid ${success ? '#b9926566' : '#a4776d66'};border-radius:50%;color:${success ? '#e4c797' : '#d69a8f'};background:${success ? '#b9926512' : '#a4776d12'}}
    .status svg{width:30px;height:30px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
    .eyebrow{margin:0 0 10px;color:#bca987;font-size:10px;font-weight:650;letter-spacing:.19em}
    h1{margin:0;font-size:clamp(23px,5vw,28px);font-weight:600;letter-spacing:-.025em;line-height:1.3}
    p{margin:14px auto 0;max-width:350px;color:#aaa5a0;font-size:14px;line-height:1.7}
    .return{margin-top:24px;padding-top:20px;border-top:1px solid #b9926540;color:#e3c596;font-size:13px;font-weight:600}
    footer{margin:14px auto 0;max-width:350px;color:#99938c;font-size:11px;line-height:1.6}
    @media(max-width:420px){main{padding:34px 22px 28px;border-radius:14px}.brand{margin-bottom:29px}}
  </style>
</head>
<body>
  <main>
    <div class="brand"><svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><ellipse cx="20" cy="20" rx="17" ry="5.5" transform="rotate(-24 20 20)" stroke="currentColor" stroke-width="2.3"/><circle cx="20" cy="20" r="8" fill="currentColor"/><path d="M5 25.5a17 5.5 0 0 0 30-13" stroke="currentColor" stroke-width="2.3"/></svg><span>MATRIX LAUNCHER</span></div>
    <div class="status" role="img" aria-label="${success ? 'Concluído' : 'Cancelado'}"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg></div>
    <p class="eyebrow">${product}</p>
    <h1>${title}</h1>
    <p>${description}</p>
    <p class="return">Pode voltar ao MATRIX Launcher</p>
    <footer>Você pode fechar esta aba. Sua senha permanece com o provedor de login.</footer>
  </main>
</body>
</html>`;
}
