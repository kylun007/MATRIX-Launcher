# Contratos MATRIX

O site `https://matrixcommunity.dpdns.org/` não foi tratado como uma API Minecraft existente. Configure um endpoint HTTPS que retorne o contrato abaixo. A ausência de API, falha de rede ou JSON inválido não bloqueiam instalações nem jogo local. A consulta tem limite de tamanho e timeout; os conteúdos são renderizados como texto React.

## Comunicados: GET no endereço configurado

```json
{
  "schemaVersion": 1,
  "news": [{ "title": "Bem-vindo", "body": "Comunicado em texto simples.", "date": "2026-10-07T12:00:00Z", "url": "https://matrixcommunity.dpdns.org/" }],
  "maintenance": "Manutenção programada, quando aplicável.",
  "recommendedVersion": "1.20.1",
  "server": { "host": "mc.seudominio.com", "port": 25565, "onlineMode": true },
  "modpack": { "url": "https://matrixcommunity.dpdns.org/minecraft/modpack.json", "sha256": "HASH_SHA256_REAL_DE_64_CARACTERES" }
}
```

`news` é obrigatório e pode ser vazio; os demais campos são opcionais. Os placeholders devem ser substituídos: o exemplo só valida após colocar um hash real. `server` pode ser adotado explicitamente pelo jogador em Configurações. Não altera silenciosamente o servidor local. O status/player count é consultado pelo protocolo Minecraft Server List Ping, direto no endereço/porta configurados, com timeout e limite de resposta. Resposta offline é distinta de endereço não configurado.

Se houver uma API de status futura, recomenda-se `GET /minecraft/status` retornando `{schemaVersion:1, online:boolean, players:{online:number,max:number}, version:string, host:string, port:number, checkedAt:ISO8601}`. Essa API separada é um contrato proposto, não uma integração já ativada.

Conectar usa Quick Play quando o perfil de versão declara suporte; caso contrário usa os argumentos de servidor do XMCL. Copiar endereço oferece a alternativa Multijogador → Adicionar servidor. DNS SRV e plugins de autenticação próprios não estão implementados; configure explicitamente a porta. Nickname não será usado como prova de propriedade em uma autenticação MATRIX futura.

## Modpack versionado

```json
{
  "schemaVersion": 1,
  "id": "matrix-java",
  "version": "1.0.0",
  "minecraft": "1.20.1",
  "loader": { "type": "fabric", "version": "0.16.14" },
  "allowedHosts": ["cdn.modrinth.com"],
  "removalPolicy": "preserve",
  "files": [{ "path": "mods/exemplo.jar", "url": "https://cdn.modrinth.com/data/ID/versions/VERSION/exemplo.jar", "sha256": "HASH_REAL_DE_64_CARACTERES", "size": 123456, "license": "Licença e autorização de distribuição do autor" }]
}
```

O SHA-256 do manifesto deve vir do canal oficial MATRIX e é conferido antes do parsing. `allowedHosts` precisa ser subconjunto de `modpackAllowedHosts` em `config/distribution.json`. Todos os redirects são novamente validados. O launcher não aceita HTTP, credenciais na URL, drives/UNC, ADS, traversal, links simbólicos, dispositivos Windows, nomes ambíguos ou arquivos fora de mods/resourcepacks/shaderpacks/config.

O modpack precisa corresponder ao Minecraft/loader da instância. `license` documenta a autorização; não substitui a análise humana dos direitos de redistribuição. Distribua URLs originais quando as regras dos autores exigirem e respeite restrições dos serviços.

Arquivos pessoais ou modificados causam conflito claro antes dos downloads e permanecem intactos. O journal `.matrix-managed.json` registra cada arquivo verificado e permite retomar interrupções. `preserve` não remove arquivos. `managed-only` remove só arquivos antes gerenciados, ainda com o hash antigo, quando o jogador marca a autorização na interface. Mundos nunca fazem parte do manifesto.

A atualização de vários arquivos não é uma transação global: em falha, os arquivos já verificados ficam registrados e o jogador pode repetir a sincronização. O journal só anuncia a nova versão do pack ao finalizar. O backend bloqueia sincronização durante o jogo.
