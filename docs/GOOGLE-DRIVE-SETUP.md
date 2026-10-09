# Conectar Google Drive sem incluir segredo no instalador

O segredo fica somente no Supabase. A Edge Function `matrix-drive-token` valida a sessão MATRIX antes de trocar ou renovar tokens com o Google. O launcher continua usando navegador, PKCE e retorno local. Os tokens Drive ficam no cofre local; atravessam a função por HTTPS, mas não são armazenados no banco ou registrados pelo código. Os arquivos de backup vão diretamente do computador ao Drive.

## 1. Cadastrar os Secrets

No projeto Supabase do launcher, abra **Edge Functions → Secrets** e cadastre:

| Nome | Valor |
| --- | --- |
| `GOOGLE_DRIVE_CLIENT_ID` | O Client ID do cliente **Desktop** do Drive. Deve ser igual a `googleDriveClientId` em `config/distribution.json`. |
| `GOOGLE_DRIVE_CLIENT_SECRET` | O segredo desse mesmo cliente Desktop. Cole somente no painel do Supabase. |

Clique em **Save**. Não coloque o segredo em `distribution.json`, no repositório, em um comando de terminal ou no chat.

O Supabase fornece sua URL e chaves públicas à função. Se o ambiente não disponibilizar `SUPABASE_PUBLISHABLE_KEYS` ou `SUPABASE_ANON_KEY`, adicione `MATRIX_SUPABASE_PUBLISHABLE_KEY` com a mesma chave **publicável** usada no launcher. Não use service_role ou chave administrativa.

## 2. Publicar a função pelo painel

1. Abra **Edge Functions → Deploy a new function → Via Editor**.
2. Use o nome exato **matrix-drive-token**.
3. Copie o conteúdo completo de `supabase/functions/matrix-drive-token/index.ts` para o arquivo `index.ts` do editor. É um único arquivo, sem bibliotecas adicionais.
4. Mantenha a verificação de JWT habilitada e clique em **Deploy function**.

Confira o **endereço**, não apenas o título: ele precisa terminar em `/functions/v1/matrix-drive-token`. Alterar **Name** em Settings muda somente o nome visível e mantém o slug/endereço original. Se a função foi criada como `Matrix-Worker`, crie uma nova função com o nome `matrix-drive-token` antes de publicar. Os Secrets pertencem ao projeto e podem ser reutilizados.

Para quem já usa Supabase CLI autenticada e vinculada ao projeto:

```powershell
supabase functions deploy matrix-drive-token
```

`supabase/config.toml` mantém `verify_jwt = true`. Não use `--no-verify-jwt` para contornar falhas. A função também valida a sessão pelo Supabase Auth e não aceita a chave pública como identidade de usuário.

## 3. Conferir o Google

- Habilite Google Drive API no projeto do cliente Desktop.
- Declare o escopo `https://www.googleapis.com/auth/drive.file`.
- Em modo Testing, inclua a conta usada no teste em **Público-alvo → Usuários de teste**.
- O segredo do cliente Web usado pelo Supabase/Google login é separado; não troque essas credenciais.

## 4. Testar no launcher atualizado

Esta integração exige um novo build do launcher. O instalador **0.3.5 já gerado anteriormente não contém esta mudança**.

Entre na **Conta MATRIX**, clique em **Conectar Google Drive**, autorize no navegador e espere a confirmação. Teste primeiro um backup pequeno de arquivos sem credenciais; confira a pasta `MATRIX Launcher Backups` no Drive e restaure como cópia separada. A confirmação só aparece depois da troca dos tokens e gravação no cofre.

Erros comuns:

- HTTP 404: a função não foi publicada com o nome correto no projeto configurado.
- `drive_server_not_configured`: os dois Secrets ainda não foram cadastrados.
- HTTP 401: entre novamente na Conta MATRIX. Confira a URL do projeto e o JWT; não desligue a verificação.
- `invalid_client`: confira se Client ID e Secret pertencem ao mesmo cliente Desktop.
- `invalid_grant`: refaça a autorização; códigos são de uso único e expiram.
- `invalid_token_response` (HTTP 502): atualize o código da função pelo painel e publique novamente. A função aceita `drive.file` junto de permissões básicas Google (`openid`, e-mail e perfil), mantendo a rejeição de acesso amplo ao Drive. Se persistir, consulte **Logs** da função e procure `MATRIX Drive token validation`: o motivo exibido é um código estático, sem tokens ou segredos. Compartilhe somente esse motivo para diagnóstico.
- HTTP 429: aguarde um minuto. O limitador em memória protege cada worker, mas não estabelece uma cota global entre regiões/reinícios; monitore as cotas do Supabase antes de ampliar a distribuição.

## Validação e limites

Testes locais verificam autenticação, PKCE, limites, destinos permitidos, renovação e ausência de segredo nas respostas usando respostas HTTP controladas. Eles não comprovam o login ou backup real na conta Google. A função deve ser publicada e os Secrets configurados para validar esse fluxo.

Referências: [Secrets do Supabase](https://supabase.com/docs/guides/functions/secrets), [publicar pelo painel](https://supabase.com/docs/guides/functions/quickstart-dashboard), [autenticação de funções](https://supabase.com/docs/guides/functions/auth).

A resposta Google pode conter múltiplas permissões e campos adicionais: [formato dos tokens e verificação de escopos](https://developers.google.com/identity/protocols/oauth2/native-app#step-6-check-which-scopes-users-granted). Uma correção feita somente em `supabase/functions/matrix-drive-token/index.ts` exige nova publicação da função, não outro instalador. A versão 0.3.6 já usa esse backend.
