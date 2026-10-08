# Resultados desta entrega — 07/10/2026

## Smart Install — versão 0.2.0

- 33 testes direcionados distintos aprovados entre hardware, catálogo, Smart Install, instalação/execução e utilitários existentes. Autenticação não foi alterada nem retestada nesta etapa.
- TypeScript e build de produção aprovados; smoke Electron real confirmou navegação da nova área, CSP/sandbox, comandos IPC e textos UTF-8. Captura em `docs/smart-install.png`.
- Hardware real fora sandbox: CPU Celeron N3350, 2 núcleos/threads, Intel HD Graphics500 integrada, Windows10 x64. VRAM não foi inventada; WMI não forneceu fonte confiável.
- Consulta real Modrinth/Fabric; Minecraft1.21.1 oficial (~918MB de arquivos do jogo), Java21 oficial (~99MB), Fabric0.19.5. Versões do loader são consultadas dinamicamente, não fixadas nesses números.
- Dez JARs reais de mods/dependências com SHA512: Sodium0.6.13, Lithium0.15.4, FerriteCore7.0.3, ImmediatelyFast1.6.14, Entity Culling1.11.2, Fabric API0.116.17, ModernFix5.25.1, Mod Menu11.0.5, Placeholder API2.4.2 e Iris1.8.8. Versões específicas desta consulta, sujeitas ao catálogo/compatibilidade.
- Complementary Reimaginedr5.9.3 baixado da fonte do autor, ZIP/hash verificados e seleção gravada em `iris.properties`. Pesquisa real também retornou Complementary Unbound, BSL e Sildur's; esses três não foram baixados/renderizados neste teste.
- A validação detectou Sodium0.8.13/0.8.12 incompatíveis com Iris1.8.8 e selecionou0.6.13 automaticamente; um teste de regressão cobre esse caso. Seleção de módulos aninhados e formatos de prerelease Fabric também foram corrigidos usando os JARs reais.
- Minecraft Fabric em **modo demo** iniciou com a instância e conteúdo reais. Primeiro teste observou processo ativo por40s; teste aprofundado aguardou o primeiro remapeamento e confirmou pelos logs início do cliente/Render thread, Iris e backend LWJGL. Processo foi encerrado pelo launcher. Isso não confirma menu totalmente carregado, mundo aberto, shader visualmente renderizado ou FPS.
- O log registrou um aviso de mixin ModernFix/Lithium, com método ignorado. ModernFix é opcional e não vem selecionado por padrão no assistente. Não houve encerramento inesperado no teste observado; combinações opcionais precisam de avaliação adicional.
- Cancelamento/retomada, SHA512, dependências, configuração/backups, seleção/desativação/exclusão de shaders, ativação Iris/dependências, preservação de mundos/arquivos pessoais e isolamento de instâncias foram cobertos por testes automatizados com dependências externas simuladas. O jogo/conta do teste real é uma demo local, sem Microsoft/online.
- Evidências adicionais: `.smoke/smart/validation.json`, `hardware.json`, `plan.json`, `game.log` e logs próprios da instância. Script reproduzível: `scripts/smart-live-smoke.ts`; `--launch-only` valida o cliente instalado sem reinstalar.
- Boost permanece separado; não foram alterados processos, drivers, serviços ou energia do sistema.

Pendências Smart Install: testes visuais de gameplay/shaders, GPUs variadas, multiplayer com conta licenciada, Linux e instalação/desinstalação em Windows limpo. O instalador continua sem certificado de assinatura digital; a integração Microsoft e o canal de atualizações mantêm as configurações externas descritas abaixo.

## Entrega inicial

- Windows 10 x64, Node 24.19.0, Electron 44.6.0.
- 22 testes automatizados aprovados; sem testes ignorados. Microsoft/Xbox/Minecraft dos testes de autenticação são simulados, sem credenciais reais.
- TypeScript e build Vite/main/preload aprovados.
- Smoke Electron real: interface iniciou, renderer não expôs `require`/`process`, IPC validou argumentos/comandos, perfil offline persistiu, navegação funcionou e a tela inicial foi capturada.
- Smoke de desenvolvimento contra Vite real também aprovado; nonce do React, watcher e IPC funcionando. CSP de produção sem scripts inline de React e sem WebSocket de desenvolvimento.
- Download real de Minecraft 1.20.1: aproximadamente 734 MB de cliente, bibliotecas e assets oficiais, com tamanho/hash verificados. Diagnóstico aprovado.
- Runtime Java 17 oficial Mojang: arquivos verificados e executável real identificado.
- Gerenciador Java final: verificação concorrente dos arquivos existentes e identificação real de versão/arquitetura x64 aprovadas.
- Minecraft real em modo demo: processo iniciou, permaneceu executando por 25 segundos e foi encerrado pelo launcher. Isso não valida login Microsoft, uma sessão licenciada, multiplayer nem todos os estados da interface do jogo.
- Fabric 0.16.14 sobre Minecraft 1.20.1: perfil oficial, arquivos Maven com hashes e diagnóstico aprovados. O jogo com Fabric/mods não foi iniciado neste teste.
- Auditoria npm de dependências de produção: zero vulnerabilidades reportadas na consulta desta sessão. A instalação reportou 8 moderadas no conjunto que inclui ferramentas de desenvolvimento; não foi aplicado `audit fix --force`.
- Instalador NSIS Windows x64 gerado. O artefato é **não assinado**, confirmado por Get-AuthenticodeSignature; geração do arquivo não equivale a validar instalação/desinstalação em VM limpa.

O teste de rede encontrou e corrigiu o parsing de nomes históricos de snapshots e uma falha fatal de um dispatcher undici compartilhado. Os downloads do aplicativo usam HTTPS nativo e foram retomados preservando arquivos previamente conferidos. A publicação XMCL também exigiu os ajustes de compatibilidade descritos em DISTRIBUTION.md.

Pendências externas: client ID Microsoft próprio autorizado e conta Java legítima; certificado/canal HTTPS e atualização entre releases assinadas; endereço/porta, Discord, API e modpack oficiais MATRIX. Forge/NeoForge, Linux e combinações de mods diferentes ainda precisam de testes reais. O instalador não é uma release pública homologada.

Evidências locais (não incluídas no instalador): `.smoke/home.png`, `.smoke/electron.log`, `.smoke/live-game/validation.json`, `.smoke/live-game/fabric-validation.json`. Scripts reproduzíveis estão em `scripts/smoke.mjs`, `live-smoke.ts` e `loader-smoke.ts`.
