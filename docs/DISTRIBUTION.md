# Build e publicação

## Build local Windows

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run dist:win
```

Use Windows 10/11 x64 e Node 24.19+. O primeiro empacotamento baixa Electron e ferramentas NSIS. Build de interface e processos ficam em `dist/` e `dist-electron/`; artefatos em `release/`. O instalador permite escolher a pasta, cria atalho e preserva userData na desinstalação. Não inclui Minecraft, runtimes ou modpacks dos jogadores.

Para empacotar rapidamente um build já gerado em desenvolvimento, `node scripts/package.mjs --fast` usa armazenamento sem compressão: o instalador fica maior, com o mesmo aplicativo. `npm run dist:win` usa compressão normal. O instalador local final desta sessão foi gerado com `--fast` para evitar repetir a compressão longa após ajustes de empacotamento de licenças.

Build local sem certificado é permitido, com atualizações desativadas e sem alegar autenticidade pública. O executável e o instalador precisam de Authenticode para distribuição pública. Windows pode exibir aviso para artefatos não assinados.

## Release pública assinada

1. Configure `microsoftClientId` autorizado e `publisherName` exatamente como o certificado em `config/distribution.json`.
2. Configure `updateUrl` com uma pasta HTTPS sob controle da MATRIX. Mantenha `modpackAllowedHosts`, API e Discord sob revisão.
3. Forneça `CSC_LINK`/`WIN_CSC_LINK` e `CSC_KEY_PASSWORD`/`WIN_CSC_KEY_PASSWORD` por um cofre de CI ou pelo ambiente. Não os comite.
4. Incremente a versão em package.json, atualize o lockfile e as notas de versão.
5. Execute com `MATRIX_PUBLIC_RELEASE=1`. O script exige client ID e assinatura, e forceCodeSigning impede gerar uma release assinada apenas nominalmente.
6. Valide o certificado com `Get-AuthenticodeSignature` e teste instalar/atualizar em uma VM Windows limpa.
7. Publique o instalador, `.blockmap` e `latest.yml` produzidos pelo builder no canal HTTPS configurado, com versões anteriores preservadas. Configure as credenciais de publicação em CI; este projeto não publica automaticamente.

O updater verifica o hash SHA-512 de electron-builder e a assinatura Authenticode do executável contra o publisher configurado. O canal de metadados é fixado no build, usa HTTPS e não é obtido da API de notícias. TLS autentica os metadados; não há assinatura destacada de `latest.yml` implementada. Instalação de update só ocorre depois do download verificado e da confirmação de reinicialização, com jogo/operações encerrados. Contas e preferências ficam em userData, fora dos arquivos atualizados.

## Compatibilidade XMCL

Versões fixadas: core 2.16.2, installer 6.3.5, user 4.4.2. Foram identificados dois problemas de empacotamento publicados:

- `@xmcl/unzip@2.2.0` usa uma dependência `workspace:` inválida para npm. Um override fixa 2.1.2, compatível com as chamadas usadas.
- installer 6.3.5 importa `@xmcl/core/utils`, subpath omitido no core publicado. `scripts/xmcl-compat.mjs` gera um adaptador mínimo `isNotNull` durante postinstall. O script falha se essas versões forem alteradas, exigindo revisão. O mesmo patch precisa estar presente nas dependências empacotadas.

Essas adaptações são explícitas e locais. Não modificam autenticação, sessões, hashes ou licenças. `npm ci` é a forma reproduzível de instalar. Não atualize XMCL/Tailwind/Vite sem revisar os tipos e os testes relevantes.

## Linux futuro

`npm run dist:linux` prepara AppImage; não foi validado neste Windows. Runtime automático é previsto para Linux x64, mas manifestos com links são recusados: nesse caso use Java manual. safeStorage exige um keyring seguro. Atualização automática do Linux permanece desativada até validar assinatura/fluxo de distribuição desse sistema. macOS/ARM e lojas de aplicativos não são alvos desta entrega.
