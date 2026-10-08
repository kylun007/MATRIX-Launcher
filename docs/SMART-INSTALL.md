# MATRIX Smart Install

## Arquitetura e uso

A área **Smart Install** cria Minecraft Java **1.21.1 com Fabric** na mesma biblioteca do launcher. Escolha Começar → Hardware → Objetivo → Personalizar → Revisar plano → Instalar. Java oficial só é baixado depois da autorização na revisão do plano ou na retomada. É necessário selecionar uma conta antes de jogar; as regras existentes de licença e servidores online permanecem.

Não modifica serviços do Windows, drivers, prioridade de processos ou opções de energia. **Boost permanece separado**. Não existe integração de Boost nesta implementação.

Os serviços `hardware.ts`, `catalog.ts`, `content-validation.ts`, `smart-config.ts` e `smart-install.ts` usam o Store, instalador/execução XMCL, Java oficial, downloads com retries/Range, validação de caminhos e IPC existentes. As instâncias antigas continuam válidas: os campos `smart` e `launch` são opcionais, sem migração destrutiva. As dependências XMCL instaladas foram verificadas localmente: core2.16.2, installer6.3.5, user4.4.2. A comparação de versões usa semver7.8.5; ZIP/JAR usa @xmcl/unzip2.1.2 já presente no instalador. Não foram atualizadas as demais dependências.

## Hardware e recomendações

Node fornece CPU/threads, memória, OS/arquitetura e espaço do volume. No Windows, CIM sem administrador identifica os núcleos físicos e adaptadores gráficos; falhas produzem campos desconhecidos e avisos. `AdapterRAM` WMI é uint32 e não fornece VRAM confiável para GPUs modernas: a quantidade permanece desconhecida e pode ser informada manualmente. Dados manuais são estimativas, preservando a leitura original.

CPU, threads/núcleos, RAM livre/total, GPU integrada/dedicada e VRAM informada influenciam a recomendação. Memória reservada ao sistema limita os presets. Performance reduz distância/efeitos; Balanced e Ultra oferecem Iris e shaders opcionais. Nenhum shader é ativado automaticamente só por escolher um preset; o jogador escolhe um pack. Limite de FPS é preferência, não resultado medido. Linux recebe os dados Node disponíveis e avisos para GPU/CIM ausentes.

## Catálogo, segurança e licenças

Fabric estável é consultado em [Fabric Meta](https://github.com/FabricMC/fabric-meta). Mods e shaders usam a [API oficial Modrinth v2](https://docs.modrinth.com/api/operations/getprojectversions/), releases publicadas para1.21.1/Fabric ou Iris. Projetos sem suporte ao cliente ou licença identificável são recusados. Dependências obrigatórias são recursivas, com pins exatos, backtracking limitado e incompatibilidades declaradas. Dependências opcionais/embedded não são instaladas separadamente; dependências externas não resolvíveis são recusadas.

Os candidatos Sodium, Lithium, FerriteCore, ImmediatelyFast, Entity Culling, ModernFix, Mod Menu e Iris são consultados individualmente. Indisponibilidade é mostrada e não gera arquivos falsos. Complementary Reimagined/Unbound, BSL e Sildur's Vibrant podem aparecer se a API confirmar releases para1.21.1/Iris. Pesquisa usa os mesmos filtros. As descrições são texto; imagens são restritas ao CDN Modrinth pela CSP.

Downloads vão diretamente ao CDN publicado pelo autor, com SHA512 preferencial (SHA1 se necessário), tamanho e URL vinculada ao projeto/versão. Licenças customizadas ou ARR permitem uso do download disponibilizado pelo próprio autor, **não** redistribuição pela MATRIX. Nenhum JAR/shader integra o instalador. Atribuição/licença aparece no plano e no registro local. A licença e os termos do autor devem ser conferidos antes de distribuir um modpack próprio.

Durante a resolução do plano, os JARs candidatos são baixados para cache de verificação: o launcher lê `fabric.mod.json`, inclusive JARs aninhados limitados, e verifica Minecraft, Java, Fabric, dependências, aliases, conflitos/breaks. Versões incompatíveis são rejeitadas e a seleção é refeita até encontrar combinação válida (máximo20rodadas). Isso ocorre antes da revisão final e não ativa mods, instala Java ou inicia o jogo. Os arquivos aprovados são reutilizados depois da confirmação. Usa a [especificação Fabric](https://wiki.fabricmc.net/documentation:fabric_mod_json_spec); restrições não interpretáveis falham claramente. Módulos aninhados são candidatos e recebem seleção compatível; JARs principais conflitantes são recusados. Isso verifica requisitos declarados, sem garantir ausência de bugs ou conflitos não declarados. Mods pessoais também são considerados no diagnóstico. ZIPs de shaders são verificados sem extração/execução e caminhos perigosos são recusados.

## Instâncias, recuperação e configurações

Cada perfil tem UUID próprio e `mods`, `shaderpacks`, `resourcepacks`, `config`, `saves` e logs separados. RAM e Java pertencem ao perfil; bibliotecas/assets/Java e `.smart-cache` podem ser compartilhados após verificação de hash. Não existem FPS ou resultados de hardware simulados.

`.matrix-smart.json` registra plano validado, arquivos gerenciados, preferências, etapas concluídas e aplicação de configuração. Cancelamento/falha marca a instância interrompida e bloqueia Jogar. Retomar revalida/reutiliza downloads; o estado é salvo atomicamente. A aplicação de vários arquivos não constitui uma transação global, mas arquivos parciais, backups e o registro permitem nova tentativa. O plano revisável em memória expira em30min; depois de iniciar, o registro persistente permite retomada após fechar/reabrir.

Arquivos pessoais/modificados não são sobrescritos. Atualizar exige revisar/aplicar um novo plano, substitui somente conteúdo gerenciado intacto e cria backup. Configurações existentes e mundos são preservados. Remover uma instância da biblioteca mantém seus arquivos no disco. Não existe exclusão automática de mundos ou configs.

`options.txt` usa `renderDistance`, `simulationDistance`, `particles` (0/1/2), `graphicsMode` (0/1) e `maxFps`. Um arquivo novo recebe `version:3955`, confirmado no `version.json` do cliente oficial1.21.1. Chaves locais, teclas e preferências não gerenciadas são preservadas. `config/iris.properties` usa `shaderPack` e `enableShaders`, conforme o [Iris1.21.1](https://github.com/IrisShaders/Iris/blob/1.21.1/common/src/main/java/net/irisshaders/iris/config/IrisConfig.java). Trocar/desativar shaders altera esses arquivos reais. Alterações criam backups em `.matrix-backups`; comandos de escrita exigem que o Minecraft esteja fechado. Configurações específicas de outros mods usam seus defaults; o launcher não inventa chaves.

No editor é possível renomear, mudar preferências, desativar/reativar mods com validação de dependências, reparar/atualizar, pesquisar/baixar/trocar/desativar/excluir shaders e abrir a pasta para mods pessoais. Se Iris estiver ausente ou desativado, baixar shader oferece revisão de um plano com Iris. Dependências necessárias não podem ser desativadas deixando a instalação inconsistente.

## Validação reproduzível

```powershell
npm.cmd run build
node --experimental-transform-types --test tests/hardware.test.ts tests/catalog.test.ts tests/smart.test.ts tests/minecraft.test.ts
node scripts/smoke.mjs
node --experimental-transform-types scripts/smart-live-smoke.ts --launch
```

O último comando exige rede/espaço e baixa arquivos oficiais em `.smoke/live-game`, usando uma conta offline de teste e **modo demo**, sem contornar licenças. Evidências ficam em `.smoke/smart`. Startup de processo não comprova renderização correta do shader, FPS ou gameplay; esses pontos precisam de verificação manual, GPUs variadas e uma conta legítima para online.
