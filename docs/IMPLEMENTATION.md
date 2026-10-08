# Arquitetura e etapas

## Módulos

- `src/`: interface React, navegação, estados reais, tema grafite/areia, Saturno em SVG, acessibilidade de foco/reduced-motion.
- `shared/contracts.ts`: schemas Zod e tipos do IPC, persistência, API e modpacks.
- `electron/main.ts`: orquestração, validação de origem/frame, exclusão mútua de comandos, diálogos nativos e ciclo do aplicativo.
- `electron/preload.ts`: duas capacidades limitadas, invoke e subscribe; Electron IPC não é exposto diretamente.
- `electron/services/store.ts`: persistência atômica, backup e perfis offline.
- `auth.ts`: OAuth/Xbox/Minecraft via XMCL user, ownership, renovação e cofre do SO.
- `minecraft.ts`: catálogo oficial, instalação verificada de cliente/bibliotecas/recursos, diagnóstico XMCL, lançamento e encerramento de processo.
- `loaders.ts`: workflows XMCL publicados para Fabric e processadores Forge/NeoForge, runtime com restrições de caminhos, fontes e executáveis.
- `java.ts`: detecção por PATH/JAVA_HOME/pastas Windows/runtimes locais, checagem de major e runtime Mojang com hashes.
- `download.ts`, `http.ts`, `security.ts`: transporte HTTPS nativo, redirects, Range/retries/cancelamento, tamanho/hashes, disco, traversal/junctions e erros legíveis.
- `modpack.ts`: manifestos versionados, allowlist de fontes e journal de arquivos gerenciados.
- `community.ts`: contrato opcional e Server List Ping real.
- `updates.ts`: updater Windows, canal fixado no build e aplicação controlada.
- `logs.ts`: rotação, remoção de segredos e diagnóstico sem tokens.

Sandbox, contextIsolation e webSecurity permanecem ativos; nodeIntegration está desativado. IPC valida o BrowserWindow, mainFrame, URL exata e schema do argumento. Links externos não abrem janelas Electron e passam pela lista autorizada. Permissões de browser e webviews são recusadas. CSP restringe script/object/form/base e conexão do renderer; notícias não contêm HTML executável.

## Etapas entregues e dependências

| Etapa | Implementação | Limite externo / validação |
| --- | --- | --- |
| 1. Estrutura | Electron, React, TS, Vite, serviços, IPC | Dependências fixadas no lockfile |
| 2. Interface | Início, Instalações, Contas, Configurações, temas e ícone | Smoke Electron e captura real |
| 3. Persistência | Configuração validada, gravação atômica e backup | Teste de corrupção/recuperação |
| 4. Offline | Criar, editar, excluir e selecionar; UUID determinístico | Testes automatizados e IPC real |
| 5. Minecraft | Instalar, reparar, cancelar, reutilizar arquivos, executar | Testes simulados + teste de rede documentado |
| 6. Microsoft | Device flow, entitlement, perfil, refresh e cofre | Registro próprio autorizado e conta real pendentes |
| 7. Java | Detectar, selecionar e instalar com ação explícita | Manifestos Mojang / plataforma |
| 8. Loaders/mods | Workflows reais, pastas isoladas, sync/journal | Cada combinação de loader requer validação real; não há catálogo de mods/marketplace |
| 9. MATRIX | Contrato, status TCP, jogadores, links, conexão | Endereço, API, Discord e modpack oficiais não fornecidos |
| 10. Updates | electron-updater, HTTPS, hash e assinatura Windows | Certificado, publisher e canal de releases pendentes |
| 11. Distribuição | Scripts, ícone, NSIS x64, testes e docs | Release pública assinada e VM limpa pendentes |

Não há respostas simuladas permanentes na aplicação. Mocks pertencem somente aos testes. Componentes sem configuração externa exibem indisponibilidade ou configuração necessária.

## Bibliotecas e licenças

XMCL foi escolhido para parsing/launch, diagnóstico, autenticação Xbox/Minecraft e workflows de loaders. Downloads genéricos/segurança/persistência usam APIs nativas Node. Electron/React/Vite/TypeScript/Tailwind/XMCL/electron-builder/electron-updater/Zod possuem licenças permissivas; as licenças concretas das dependências instaladas estão em `dependency-licenses.json` (inclui ferramentas de desenvolvimento). Licenças upstream permanecem em node_modules e nos arquivos redistribuídos. O próprio projeto usa MIT. Antes de publicar, revise avisos de terceiros e licenças de cada mod; acesso público a um arquivo não concede redistribuição.

Referências: [XMCL](https://xmcl.app/en/core/), [repositório XMCL](https://github.com/Voxelum/minecraft-launcher-core-node), [Electron releases](https://releases.electronjs.org/), [electron-builder](https://github.com/electron-userland/electron-builder), [diretrizes Minecraft](https://www.minecraft.net/en-us/usage-guidelines). Documentação antiga e pacotes atuais divergiram; a integração foi ajustada aos tipos/código realmente instalados.

## Limites explícitos

Não distribui arquivos proprietários do jogo ou credenciais compartilhadas. Perfis offline não são contas oficiais; multiplayer online exige licença/sessão válidas. Não há sistema de autenticação próprio MATRIX implementado. O canal do servidor usa porta configurada (sem descoberta SRV). Instalações antigas e loaders não testados podem exigir ajustes de Java ou bibliotecas; falhas de integridade bloqueiam a execução e permitem reparação. Reparação de download individual é atômica; modpacks usam journal, sem rollback global.
