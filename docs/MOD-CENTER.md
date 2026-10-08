# MATRIX Mod Center

## Disponível nesta versão

- Pesquisa paginada de mods na API Modrinth v2, ordenada por relevância, downloads, data de publicação ou atualização.
- Filtro por versão Minecraft e loader da instância selecionada, com opção para explorar resultados sem filtro.
- Página de detalhes com descrição, autoria retornada pelo catálogo, licença, categorias, downloads, imagens e versões compatíveis.
- Resolução recursiva das dependências obrigatórias e das incompatibilidades declaradas no Modrinth. Resoluções sem release compatível são recusadas.
- Plano de instalação revisável, download retomável, hash validado, cache compartilhado e escrita isolada em `instances/<uuid>/mods`.
- Atualização individual dos mods gerenciados, com backup do arquivo anterior e rollback do lote se uma etapa falhar.
- Favoritos persistentes no armazenamento local do launcher.
- Lista de mods gerenciados pelo Mod Center, pelo Smart Install e adicionados manualmente. Ativação/desativação usa renomeação; arquivos pessoais são preservados. Remoção fica limitada aos arquivos gerenciados intactos.
- Operações de arquivo bloqueadas enquanto Minecraft estiver em execução.

O launcher consulta a [API oficial do Modrinth](https://docs.modrinth.com/api/operations/searchprojects/), identifica-se como `MATRIXLauncher` e usa cache curto, paginação, timeout e novas tentativas para respostas HTTP temporárias. Downloads de projetos são aceitos somente do CDN `cdn.modrinth.com`; os arquivos não são executados pelo instalador.

## Limites desta entrega

O primeiro fluxo do Mod Center cobre mods `.jar`. Instâncias Vanilla podem pesquisar, mas não instalar mods. Mods instalados pelo Smart Install são reconhecidos e podem ser ativados/desativados por sua integração; atualizações desses arquivos permanecem na aba Smart Install para manter seu manifesto e reparação coerentes. Arquivos manuais podem ser ativados ou desativados, mas não são removidos pelo launcher.

Shaders continuam disponíveis pelas ferramentas do Smart Install, que exigem uma instância Smart Fabric 1.21.1 com Iris instalado. A biblioteca de resource packs, importação `.mrpack`, atualização em lote, fixação de versão e histórico detalhado ainda não fazem parte desta entrega. Não há alegação de execução manual do jogo após instalar um mod nesta sessão; essa validação depende de uma instalação Minecraft real e de uma instância/conta utilizável.

## Validação automatizada

`tests/catalog.test.ts` cobre facetas Modrinth, paginação, compatibilidade dinâmica e resolução de dependências. `tests/mod-center.test.ts` simula a resposta do CDN para verificar hash, instalação isolada, atualização com backup, ativação/desativação e preservação de mods manuais e mundos. Esses testes não substituem uma consulta ao serviço ao vivo nem iniciar o Minecraft com mods.
