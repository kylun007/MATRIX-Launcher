# Validação

## Testes automatizados

`npm test` executa os testes Node com transformação TypeScript. Os testes cobrem UUID/nickname offline, duplicação/rename/seleção, IPC schemas, limites de RAM, backup/corrupção, traversal/UNC/ADS/dispositivos/junctions, HTTPS/redirects, integridade, cache, cancelamento e retomada por Range, manifestos de modpacks e conflitos pessoais, API, remoção de credenciais de logs, versão Java, OAuth/Minecraft com dependências simuladas e instalação/diagnóstico/ciclo de processo com fixtures.

`npm run build` inclui TypeScript e empacota renderer/main/preload. Os testes são de segurança/comportamento; não afirmam que OAuth externo funcionou com credenciais reais.

## Smoke Electron

```powershell
node scripts/smoke.mjs
```

Executa um único Electron oculto em userData isolado `.smoke/user-data`, com depuração localhost temporária. Verifica renderer sem Node, bridge, validação de argumentos, rejeição de comando desconhecido, criação de perfil, navegação e captura `.smoke/home.png`. Encerra o processo ao terminar. Não habilite depuração remota nas releases normais.

`node scripts/dev-smoke.mjs` repete o smoke contra o servidor Vite real. O desenvolvimento usa um nonce para o preâmbulo React e exclui cookies/cache/artefatos do watcher; a produção não permite scripts inline nem conexão WebSocket de desenvolvimento.

## Teste com downloads reais

```powershell
node --experimental-transform-types scripts/live-smoke.ts --launch
```

Baixa Minecraft 1.20.1 e runtime Java 17 oficiais em `.smoke/live-game` (aproximadamente 1 GB). Confere os hashes, faz diagnóstico e, com `--launch`, inicia o jogo real em modo demo por 25 segundos antes de encerrar. O modo demo evita alegar autenticação/licença de uma conta não fornecida. Resultados são escritos em `validation.json` e `game.log`. Sem `--launch`, só valida downloads/runtime. Os dados de teste são separados do aplicativo e não são empacotados. Esse teste requer rede, espaço, Windows/Linux compatível e suporte gráfico; não deve fazer parte de toda execução de testes.

## Validações externas ainda necessárias

- OAuth real com client ID MATRIX aprovado, conta legítima, renovação, expiração e controles familiares.
- Multiplayer MATRIX, endereço/porta reais, exigência online-mode, Quick Play e fallback com diferentes versões.
- Cada combinação Fabric/Forge/NeoForge escolhida para a comunidade, incluindo processadores, mods, resourcepacks e shaders.
- Manifesto/modpack oficial com licenças e testes de atualização/conflitos/remoção autorizada.
- Atualização assinada entre duas releases, assinatura recusada, hash corrompido e preservação de userData em VM Windows limpa.
- Instalação/desinstalação NSIS, Windows 11 e ambiente sem Java; empacotar não equivale a executar o instalador.
- Linux/AppImage/keyring e runtimes que necessitam de links; macOS/ARM não suportados inicialmente.

O resumo de resultados reais desta sessão fica em `VALIDATION.md`. Não afirme que os itens desta lista foram testados sem realizar esses testes.

`node --experimental-transform-types scripts/loader-smoke.ts` instala Fabric 0.16.14 sobre os recursos 1.20.1 do teste de rede, confere fontes/hashes e faz diagnóstico. Não executa o jogo com mods nem valida outras versões de Fabric.

## Skin Studio

Validação direcionada:

```powershell
node --experimental-transform-types --test tests/skin-pixels.test.ts tests/skins.test.ts tests/skin-uv.test.ts tests/account-skin.test.ts
node scripts/smoke.mjs
```

Os 18 testes cobrem pixels, UV, histórico, conversão, PNG, biblioteca, recuperação, caminhos e integração Microsoft simulada. O smoke no Electron valida pintura 2D/3D com eventos reais, desfazer/refazer, persistência, associação offline e saída/reabertura da aba. O teste usa `.smoke/user-data`, preservando contas e skins reais. Capturas WebGL de uma janela invisível podem depender do compositor Windows e não são necessárias para os testes funcionais.

Aplicação em conta Microsoft legítima, diálogos nativos, todas as ferramentas visualmente, consumo prolongado de RAM/GPU e diferentes drivers continuam dependendo de validação manual. Detalhes e resultados em [SKIN-STUDIO.md](SKIN-STUDIO.md).

Para validar somente o espaçamento e a tela cheia do Skin Studio: `node scripts/smoke.mjs --skin-layout`. Esse teste mede o recuo dos textos e alinhamento da pesquisa e usa eventos reais de mouse/teclado para entrar em tela cheia, verificar o aumento da prévia e sair pelo botão e por Escape.

Versão 0.3.1: TypeScript, build e esse teste direcionado passaram no Windows/Electron. A permissão fullscreen foi liberada exclusivamente para a página local e frame principal do launcher; as demais permissões permanecem bloqueadas.
