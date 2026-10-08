# Build e distribuição

## Build local

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run dist:win
```

Use Windows 10/11 x64 e Node 24.19+. `release/` contém o instalador NSIS. Não é necessário comprar certificado Authenticode para gerar o instalador nem para o mecanismo de atualização. Sem Authenticode, o Windows ainda pode exibir aviso do SmartScreen, e dispositivos com Smart App Control podem bloquear executáveis sem assinatura de código. O NSIS preserva `userData` na desinstalação (`deleteAppDataOnUninstall: false`); contas, mundos, instâncias, mods e projetos ficam fora dos arquivos substituíveis do aplicativo.

## Atualizações por GitHub Releases

O destino é explícito em `config/distribution.json`: `githubOwner` e `githubRepo` (`kylun007/MATRIX-Launcher`). O repositório de releases precisa ser público para os usuários baixarem sem credenciais. O cliente não contém tokens GitHub. electron-builder 26.15.3 gera o instalador e o manifesto; electron-updater 6.8.9 baixa o pacote e verifica seu SHA-512. Antes disso, um provedor MATRIX confere a assinatura Ed25519 destacada de `latest.yml` (Stable) ou `beta.yml` (Beta), usando a chave pública fixada no aplicativo. Metadados ausentes ou assinatura inválida fazem a atualização falhar de forma fechada.

### Configurar a chave Ed25519 (uma vez)

1. Execute localmente `node scripts/generate-update-key.mjs`. Isso cria `release-secrets/update-signing-key.pem` (ignorado pelo Git) e grava somente a chave pública em `config/distribution.json`.
2. Revise e envie `config/distribution.json` ao repositório antes de criar o primeiro instalador que habilita atualizações.
3. Cadastre o conteúdo de `release-secrets/update-signing-key.pem` nas configurações do GitHub como Actions Secret `MATRIX_UPDATE_SIGNING_KEY`. Nunca faça commit dessa chave, não a inclua no instalador nem em logs.
4. Deixe o repositório de distribuição público e mantenha `GITHUB_TOKEN` com permissão mínima `contents: write`; o workflow usa o token efêmero fornecido pelo GitHub. O client ID Microsoft também precisa estar autorizado para o aplicativo de produção.

O workflow assina o manifesto YAML exato com Ed25519. A assinatura autentica a lista de arquivos e hashes; o atualizador verifica o SHA-512 do instalador baixado antes de instalá-lo. A chave privada não é usada pelo launcher. Uma vez distribuído um instalador com a chave pública, futuras releases precisam da chave privada correspondente. Perder essa chave exige preparar uma migração de confiança por uma versão intermediária ou pedir instalação manual; não substitua silenciosamente a chave pública. Faça backup seguro dela, separado do repositório.

Essa assinatura própria protege atualizações autenticadas, mas não é uma assinatura Authenticode do executável e não remove avisos do SmartScreen. Ela também não torna seguro executar o instalador inicial obtido de uma fonte não confiável. Builds locais e o instalador inicial podem ser baixados manualmente, mas as atualizações só são habilitadas quando a chave pública e os metadados assinados estiverem configurados.

O workflow `.github/workflows/release.yml` só dispara com tag `v*`, confere a versão do `package.json`, executa testes e typecheck, gera o instalador, assina e valida o manifesto e só então publica a release. Proteja as tags no GitHub para que somente responsáveis autorizados publiquem. Tags sem sufixo publicam Stable; versões SemVer com sufixo (por exemplo `0.4.0-beta.1`) publicam Beta. A troca de Beta para Stable não permite downgrade automático; quando Stable estiver atrás, instale uma versão Stable manualmente.

Antes da primeira publicação, confirme que o repositório é público, que o secret corresponde à chave pública configurada, que a tag e o canal estão corretos e que as notas descrevem o build. O fluxo A→B entre dois instaladores empacotados ainda precisa ser testado em um release de teste; esta implementação não publicou uma release.

## Dados e recuperação

Configurações estão em `app.getPath('userData')/settings.json`; a migração versionada v1→v2 faz cópia `.bak` antes da troca atômica. Tokens ficam no cofre protegido por `safeStorage`, em `credentials.bin`. Instâncias/jogos e Skin Studio também residem sob `userData`, fora do diretório de instalação. A atualização substitui somente os arquivos do app. Desinstalar preserva `userData`.

## Compatibilidade XMCL

Versões fixadas: core 2.16.2, installer 6.3.5, user 4.4.2. Foram identificados dois problemas de empacotamento publicados:

- `@xmcl/unzip@2.2.0` usa uma dependência `workspace:` inválida para npm. Um override fixa 2.1.2, compatível com as chamadas usadas.
- installer 6.3.5 importa `@xmcl/core/utils`, subpath omitido no core publicado. `scripts/xmcl-compat.mjs` gera um adaptador mínimo `isNotNull` durante postinstall. O script falha se essas versões forem alteradas, exigindo revisão. O mesmo patch precisa estar presente nas dependências empacotadas.

Essas adaptações são explícitas e locais; não modificam autenticação, sessões, hashes ou licenças. `npm ci` é a forma reproduzível de instalar.

## Linux futuro

`npm run dist:linux` prepara AppImage; não foi validado neste Windows. Atualização automática Linux está desativada até haver e validar um provedor e integridade próprios para esse formato. macOS/ARM e lojas de aplicativos não são alvos desta entrega.
