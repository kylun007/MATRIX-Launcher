# MATRIX Skin Studio

O Skin Studio usa a biblioteca e o IPC existentes do launcher. A edição, os modelos originais e os projetos funcionam offline. A aba é carregada por importação dinâmica; Three.js e WebGL são inicializados somente no editor.

## Arquitetura e etapas

1. Contratos validados: `shared/skin.ts`, comandos integrados em `shared/contracts.ts`.
2. Biblioteca: `electron/services/skins.ts`, projetos UUID em `userData/skin-studio`, gravação temporária com fsync/rename, backups, revisões e lixeira.
3. Editor: `shared/skin-pixels.ts` e `src/SkinStudio.tsx`, textura RGBA 64×64, operações por faces UV, histórico esparso até 100 ações/2 MiB. Cada traço é uma ação.
4. Visualização: `src/SkinPreview.tsx`, `PlayerObject` do skinview3d, textura CanvasTexture, Three.js e OrbitControls, sem requisições remotas.
5. Edição 3D: raycasting transforma UV em coordenadas da textura compartilhada; botão esquerdo edita e direito gira.
6. Ferramentas: lápis, borracha, balde por face, conta-gotas, linha, seleção, copiar/colar, preenchimento, gradiente, clarear/escurecer, simetria, espelhamento e cópia entre membros. Camadas e partes restringem a edição.
7. Contas: associação local a perfis offline; importação e aplicação Microsoft no processo principal, usando a sessão renovável existente e `MojangClient.setSkin` do XMCL.
8. Recursos: descarte de geometria, materiais, textura, controles, listeners, RAF e contexto ao sair; renderização sob demanda, animação pausável e FPS 15/30/60. Recuperação é salva após 800 ms sem alterações e antes de sair/fechar.

## Uso

Abra **Skin Studio**, crie um modelo ou importe PNG. Selecione Steve (braços de 4 pixels) ou Alex (3 pixels), parte e camada. Edite no mapa ou escolha **Pintar em 3D**. **Salvar projeto** adiciona à biblioteca; **Exportar PNG** gera uma textura para Minecraft; **Exportar projeto** gera `.matrixskin`, incluindo modelo e paleta. O PNG importado permanece intacto.

Atalhos: Ctrl+Z desfaz; Ctrl+Shift+Z ou Ctrl+Y refaz; Ctrl+S salva. A seleção permite copiar, colar, preencher, criar gradiente ou restaurar a região original. Clique direito em uma cor favorita a remove. O comparador exibe a imagem aberta ou do último salvamento.

Prévia: frente/costas/lado, zoom pela roda, navegação com mouse, partes individuais, luz, fundo, poses, caminhada/corrida, pausa, FPS e tela cheia. A exportação da prévia permite fundo transparente ou sólido e limita a maior dimensão a 2048 pixels.

Os modelos são criações originais do projeto sob MIT. “Steve” e “Alex” identificam a geometria; não são imagens copiadas da Mojang ou de terceiros.

## Formato e segurança

Importação aceita PNG 64×64 e 64×32 até 1 MiB; a versão antiga é convertida com espelhamento dos membros. São verificados assinatura, dimensões, estrutura, CRC e limites de expansão. A base é opaca; somente a camada externa aceita transparência. O editor e a exportação não interpolam os pixels.

Projetos têm schemaVersion 1, ID UUID, revisão, datas, nome, modelo, paleta e RGBA em base64. Os caminhos da biblioteca são gerados no processo principal, com proteção contra traversal e junctions. Exportações usam diálogo nativo e escrita atômica; um destino existente recebe `.bak`. Não são aceitos scripts, caminhos ou URLs de projetos para execução.

O rascunho recuperável é separado do projeto salvo. Ao reabrir a aba, use **Recuperar** para continuar. Bibliotecas têm limite de 500 projetos e paletas de 64 cores. Backups e lixeira não são apagados automaticamente. Projetos corrompidos são preservados; um backup válido é usado quando possível.

## Contas e limites externos

Uma associação offline atualiza a skin local e o avatar do launcher. **Minecraft vanilla offline não usa automaticamente esse arquivo**; um servidor ou mod precisa fornecer um mecanismo de skins compatível. Não são gerados tokens Microsoft e não há garantia de exibição em servidores.

Aplicação oficial exige Minecraft Java legítimo, conta Microsoft autenticada e `microsoftClientId` próprio configurado conforme [AUTHENTICATION.md](AUTHENTICATION.md). O launcher pede confirmação antes de atualizar a conta. O token fica no processo principal; uploads multipart usam HTTPS para `api.minecraftservices.com`, sem encaminhar credenciais a outras origens. Falhas permitem exportar o PNG para aplicação no site oficial.

Ao importar um PNG, confira o modelo Steve/Alex: as mesmas dimensões servem a ambos. A sessão da conta pode exigir conexão e renovação. O funcionamento da edição local independe disso. Sem WebGL, a edição 2D permanece disponível e a prévia informa a limitação.

## Bibliotecas verificadas

- [skinview3d 3.4.2](https://github.com/bs-community/skinview3d): MIT, modelo e UV reutilizados; versão estável consultada no npm.
- [Three.js](https://github.com/mrdoob/three.js): MIT, 0.156.1 para satisfazer a linha `^0.156.0` exigida pelo skinview3d e manter uma única cópia do motor.
- [pngjs 7.0.0](https://github.com/pngjs/pngjs): MIT, leitura e escrita PNG reais com CRC.
- [XMCL](https://github.com/Voxelum/x-minecraft-launcher): MIT, cliente Mojang existente reutilizado para atualização oficial.

Licenças e versões do projeto estão em `docs/dependency-licenses.json`.

## Validação

Testes direcionados em `skin-pixels.test.ts`, `skins.test.ts`, `skin-uv.test.ts` e `account-skin.test.ts` cobrem UV Steve/Alex contra a geometria real, conversão antiga, transparência, operações, histórico limitado, PNG, persistência, revisões concorrentes, backups, rascunhos, traversal/junctions, raycasting e autenticação/upload com respostas externas simuladas nos testes.

O envio a uma conta Microsoft legítima depende de credenciais e permissões externas e não pode ser considerado validado pelos testes simulados. A assinatura do instalador continua dependendo do certificado de publicação. Testes visuais de todas as ferramentas, GPUs e escalas de tela continuam necessários para distribuição ampla.

Em 07/10/2026: 18 testes automatizados passaram; TypeScript passou e o build de produção foi gerado. O smoke test no Electron/Windows abriu WebGL real, pintou no mapa 2D, desfez/refez, salvou/reabriu o projeto e pintou pela geometria 3D usando eventos reais de mouse, verificando a alteração no RGBA compartilhado. Também verificou remoção do canvas ao sair, reabertura da biblioteca sem iniciar WebGL, associação offline e rejeição de ID com traversal. Captura: `.smoke/skin-studio.png`.

O histórico tem limite de memória verificado no código e por operações automatizadas. O descarte da prévia foi verificado no smoke test; não foi realizado benchmark prolongado de RAM/GPU nem teste em todos os drivers. Diálogos nativos de importação/exportação e todas as combinações visuais precisam da validação manual de distribuição.

Na versão 0.3.1 foram corrigidos o espaçamento dos cartões, alinhamento dos textos/pesquisa e a tela cheia nativa da prévia. O teste `node scripts/smoke.mjs --skin-layout` passou, verificando aumento do viewport e saída pelo botão e por Escape. O renderizador existente é redimensionado, sem recriar a textura ou perder a edição.
