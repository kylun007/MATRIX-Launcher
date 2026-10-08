# Autenticação Microsoft

## Configuração externa necessária

1. Registre um aplicativo próprio da MATRIX no Microsoft Entra, compatível com contas pessoais Microsoft.
2. Configure-o como cliente público para desktop e habilite public client flows. O launcher usa OAuth Device Authorization Grant no tenant `consumers`; não exige redirect URI, client secret ou página de senha interna.
3. Autorize o escopo Xbox apropriado, `XboxLive.signin`, junto de `offline_access`. Verifique com Microsoft/Xbox a elegibilidade e aprovação necessárias para seu aplicativo acessar Xbox/Minecraft Services. Criar um App Registration não garante acesso às APIs Minecraft. Um HTTP 403 pode indicar que o aplicativo não foi autorizado.
4. Coloque apenas seu Application (client) ID em `config/distribution.json`, campo `microsoftClientId`, e gere novo build.
5. Valide com uma conta legítima com Minecraft Java, perfil Xbox e nickname Java. Não reutilize IDs de outros launchers nem tente contornar rejeições.

O canal exato de aprovação para launchers de terceiros deve ser confirmado com o responsável Microsoft/Xbox no momento da publicação. Não há aprovação configurada para este projeto nesta entrega.

## Fluxo implementado

Solicitação de device code → código visível no launcher → site Microsoft no navegador padrão → polling com interval/slow_down e expiração → Xbox Live RPS → XSTS para Minecraft → Minecraft access token → entitlements Java → perfil Java e skin.

Só depois da verificação de acesso a conta é salva. Tokens ficam no processo principal, em `credentials.bin` com Electron safeStorage (DPAPI no Windows). O renderer recebe nome, UUID, skin e expiração; nunca recebe tokens. Um backend `basic_text` no Linux é recusado. Logs do launcher removem tokens conhecidos e padrões de autorização.

A expiração renova o OAuth refresh token e refaz Xbox/Minecraft/entitlements/perfil. Quando a renovação é recusada, a interface pede novo login. Desconectar remove os tokens locais; não revoga todas as sessões Microsoft em outros dispositivos.

Offline usa UUID v3 determinístico de `OfflinePlayer:<nickname>`, userType local/legacy e argumento de access token vazio, substituindo o fallback aleatório do XMCL. Não envia um token Microsoft fabricado. Não prova propriedade de nickname. A conexão direta é recusada quando o servidor configurado exige online-mode e a conta selecionada é offline; o próprio servidor permanece responsável pela validação efetiva de sessões.

## Referências consultadas

- [Fluxo oficial Device Authorization](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code)
- [Registro de aplicativos Microsoft](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app)
- [XMCL: módulos core, installer e user](https://xmcl.app/en/core/)
- [Código do autenticador Xbox do XMCL](https://github.com/Voxelum/minecraft-launcher-core-node/blob/master/packages/user/microsoft.ts)
- [Termos e diretrizes Minecraft](https://www.minecraft.net/en-us/usage-guidelines)

Os testes automatizados usam respostas externas simuladas. O login real, controles familiares, restrições de região, revogação e a aprovação do client ID precisam de validação com a conta e o registro da comunidade.
