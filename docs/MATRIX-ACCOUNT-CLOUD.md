# MATRIX Account e MATRIX Cloud

## Estado implementado

- MATRIX Account autentica separadamente das contas Minecraft existentes.
- Google e Discord usam o navegador do sistema, Authorization Code + PKCE e callback loopback em `127.0.0.1`; o renderer nunca recebe access/refresh tokens.
- Login por e-mail usa código OTP do Supabase Auth.
- Sessões MATRIX são guardadas no cofre criptografado já usado pelo login Microsoft (`safeStorage`). Se o cofre do sistema não estiver disponível, o login falha fechado.
- O launcher não usa `service_role`, client secret, nem sincroniza token Minecraft.
- A migration inicial cria perfis, preferências limitadas, manifestos versionados, dispositivos e metadados de backups com RLS por `auth.uid()`.

O login MATRIX está implementado. Os serviços locais para autorização separada do Google Drive, listagem, backups manuais e restauração em uma pasta nova estão implementados. A troca/renovação de tokens usa uma Edge Function autenticada, com Client Secret apenas no Supabase. É necessário publicar a função e configurar os Secrets seguindo [GOOGLE-DRIVE-SETUP.md](GOOGLE-DRIVE-SETUP.md). Upload e restauração com uma conta real não foram validados. Sincronização automática/em fila, resolução de conflitos, gerenciamento real de dispositivos e sincronização entre computadores ainda não estão implementados; não há envio automático de dados.

## Configuração necessária antes de habilitar login

1. Crie um projeto Supabase e aplique `supabase/migrations/202610080001_matrix_account_cloud.sql` pelo SQL Editor ou Supabase CLI.
2. Copie `config/distribution.example.json` para `config/distribution.json` apenas em uma cópia limpa do projeto; mantenha as demais configurações locais reais ao editar o arquivo existente.
3. Preencha `supabaseUrl` e `supabaseAnonKey` com a URL do projeto e a chave publicável/anon. Essa chave é pública por definição; nunca coloque `service_role`, secret key ou client secret no launcher.
4. Em Supabase Auth, habilite Google e Discord, configure as credenciais OAuth de cada provedor e defina o callback do provedor para `https://<PROJECT-REF>.supabase.co/auth/v1/callback`.
5. Cadastre o padrão de redirect de aplicativo `http://127.0.0.1:43827/**` na lista de Redirect URLs do Supabase. O launcher usa uma rota aleatória de uso único nesse loopback, abre o navegador padrão e valida PKCE e state no callback.
6. Configure o template de e-mail de login para mostrar `{{ .Token }}` como código OTP. Configure SMTP próprio/adequado e limites de Auth antes de distribuir; a cota padrão não deve ser tratada como ilimitada.
7. Faça um build limpo e teste Google, Discord, OTP, cancelamento, expiração, logout e falha do cofre em uma instalação empacotada.

As credenciais de provedores Google/Discord e SMTP ficam no painel do Supabase, não no repositório. Não publique a chave `service_role` nem OAuth client secrets.

Referências oficiais: [OAuth/PKCE do Supabase](https://supabase.com/docs/guides/auth/sessions/pkce-flow), [URLs de redirecionamento](https://supabase.com/docs/guides/auth/redirect-urls), [login Google](https://supabase.com/docs/guides/auth/social-login/auth-google) e [login sem senha por e-mail](https://supabase.com/docs/guides/auth/auth-email-passwordless).

## Google Drive e MATRIX Backup Center

A autorização do Drive é independente do login Google da Conta MATRIX. A integração pede o escopo `drive.file`, cria a pasta visível `MATRIX Launcher Backups` na conta pessoal do jogador e só envia arquivos/pastas que ele escolher no seletor nativo. O launcher compacta a seleção em ZIP, envia em blocos retomáveis durante a operação e lista/exclui somente backups MATRIX criados por ele. A restauração valida caminhos/limites e cria uma pasta `MATRIX-Restaurado-*` nova; não substitui arquivos existentes.

Configuração do distribuidor:

1. No Google Cloud Console do projeto, habilite a **Google Drive API**.
2. Em Google Auth Platform, declare o escopo `https://www.googleapis.com/auth/drive.file`. Para OAuth em modo Testing, adicione a conta que testará como usuário de teste.
3. Crie um OAuth Client do tipo **Desktop app**, separado do cliente Web usado pelo Supabase. O Client ID identifica a aplicação, mas o cliente configurado exige também autenticação na troca de tokens. O launcher não distribui Client Secret.
4. Informe o Client ID terminado em `.apps.googleusercontent.com` no campo `googleDriveClientId` de `config/distribution.json` e gere um novo build. Esse valor é público; não inclua segredo OAuth.
5. Publique `supabase/functions/matrix-drive-token/index.ts` e configure os Secrets `GOOGLE_DRIVE_CLIENT_ID` e `GOOGLE_DRIVE_CLIENT_SECRET` no Supabase, conforme [GOOGLE-DRIVE-SETUP.md](GOOGLE-DRIVE-SETUP.md).
6. No launcher atualizado, entre na Conta MATRIX e abra Google Drive → Conectar Google Drive. A autorização Drive continua independente do provedor usado para login MATRIX.

O fluxo abre o navegador padrão, usa PKCE e callback loopback em `127.0.0.1` com porta aleatória. O refresh token fica no cofre seguro do sistema. O escopo `drive.file` limita o app aos arquivos criados ou compartilhados especificamente com ele; os backups são visíveis na conta Drive do usuário. Um app público poderá precisar da verificação OAuth do Google. Consulte [configurar a Drive API](https://developers.google.com/workspace/drive/api/quickstart/nodejs), [escopos do Drive](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) e [OAuth para apps desktop](https://developers.google.com/identity/protocols/oauth2/native-app).

O backend implementado valida a sessão MATRIX, aceita apenas o cliente Desktop configurado e grants de autorização com PKCE ou renovação. Não armazena tokens Google nem retorna o Client Secret. Os tokens trafegam por HTTPS entre launcher, Supabase e Google; os arquivos de backup continuam indo diretamente ao Drive. A partir de 0.3.4, a página local só confirma a conexão após a troca de tokens e a gravação no cofre; falhas exibem uma página de erro e diagnóstico no launcher. Publicação da função, configuração de Secrets e validação real permanecem pendentes.

Limitações atuais: backups são manuais, não há agenda ou sincronização entre PCs, e os ZIPs não recebem criptografia ponta a ponta do MATRIX. O usuário deve fechar o Minecraft antes de criar/restaurar backups e não selecionar pastas de credenciais/tokens. Backups grandes usam espaço temporário local durante a compactação e dependem da cota disponível na própria conta Google.

## Dados e privacidade

Os tokens de sessão MATRIX ficam apenas no cofre local criptografado. Contas Microsoft/offline, seus tokens, instâncias, mundos, arquivos da Mod Library e projetos Skin Studio existentes não são migrados ou enviados pela migration. A tabela de backup guarda apenas metadados/referências; não armazena mundos nem arquivos binários.

Para operar em produção, publique uma política de privacidade e defina retenção/exclusão de dados. Exclusão de conta MATRIX ainda requer endpoint privilegiado confiável fora do launcher; não use uma chave administrativa distribuída para implementá-la.
