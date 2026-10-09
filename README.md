# MATRIX Launcher

Launcher desktop Minecraft Java para Windows 10/11 x64. Electron, React, TypeScript, Vite, Tailwind e XMCL. Tema Saturno, instalações independentes, downloads oficiais com integridade e perfis offline claramente identificados.

## Executar

Instale Node.js 24.19 ou superior. No PowerShell, use `npm.cmd` se a política de execução bloquear `npm.ps1`.

```powershell
npm.cmd ci
npm.cmd run dev
```

```powershell
npm.cmd test
npm.cmd run build
npm.cmd start
npm.cmd run dist:win
```

O instalador padrão fica em `release/MATRIX Launcher Setup 0.3.1.exe`. A entrega com correções de layout e tela cheia fica em `release/skin-studio-fix/`; a entrega Skin Studio anterior fica em `release/skin-studio/`. Entregas anteriores permanecem em `release/icon-update/` e `release/smart-install/`. A versão sem instalador está na subpasta `win-unpacked/MATRIX Launcher.exe`. `dist/` contém a interface; suas funções de desktop precisam do Electron.

## MATRIX Skin Studio

Editor offline de skins com biblioteca local, ferramentas de pixels, camadas, modelos Steve/Alex, importação 64×64/64×32 e edição 3D sincronizada. Inclui histórico, paletas, recuperação automática e exportação PNG/projeto/prévia. A associação offline é local ao launcher; aplicar uma skin oficial exige uma conta Microsoft legítima e o registro do aplicativo configurado. Consulte [SKIN-STUDIO.md](docs/SKIN-STUDIO.md).

## MATRIX Smart Install

Abra **Smart Install**, detecte o hardware e escolha Performance, Balanced ou Ultra. Revise os mods, shaders opcionais e Java21 antes de instalar Minecraft1.21.1 com Fabric. A instância aparece na biblioteca existente, com preferências próprias e ferramentas de retomada, reparação e shaders. Boost permanece separado. Veja [funcionamento e limites](docs/SMART-INSTALL.md).

## MATRIX Mod Center

Abra **Mod Center**, escolha uma instância instalada com Fabric, Forge ou NeoForge, pesquise no catálogo real do Modrinth e confira compatibilidade, licença, autoria e dependências antes de instalar. Downloads são verificados por hash e arquivos pessoais são preservados. Mods manuais podem ser ativados/desativados; remoção e atualização pelo Mod Center ficam limitadas aos arquivos que ele gerencia. Consulte [escopo e limitações atuais](docs/MOD-CENTER.md).

## Para o jogador

No Linux x86_64, extraia o projeto em sua pasta pessoal e execute `bash ./INICIAR-LINUX.sh` com Node.js 24.19 ou superior instalado. A primeira abertura prepara o build e cria um atalho no menu. Consulte [abertura simplificada no Linux](LEIA-ME-LINUX.md) para instruções e limitações.

1. Abra Contas e crie um perfil offline para uso local, ou conecte uma conta Microsoft quando o distribuidor tiver configurado a autenticação.
2. Em Instalações, crie uma instância e escolha uma versão estável. Clique em Instalar.
3. Se Java não estiver disponível, clique em Instalar Java oficial. O aplicativo informa a versão necessária e só baixa o runtime após sua ação.
4. Volte ao Início e clique em Jogar. Para servidores autenticados, selecione uma conta Microsoft com acesso ao Java.
5. O endereço do servidor e o convite Discord podem ser definidos em Configurações. Sem servidor/API configurados, o jogo local continua disponível.

Forge/NeoForge precisam de Java antes de executar seus processadores de instalação. Fabric usa o perfil oficial publicado pelo projeto. Mods pessoais podem ser adicionados pela pasta da instância; cada instância tem `mods`, `resourcepacks`, `shaderpacks`, `config` e `saves` próprios.

## Dados e recuperação

Dados do launcher ficam em `%APPDATA%/matrix-launcher` (o caminho exato é o `userData` do Electron): `settings.json`, backup `.bak`, `credentials.bin` criptografado pelo sistema e `logs/`. Recursos ficam na pasta configurada, em `minecraft/`; instâncias ficam em `instances/<uuid>/`; runtimes em `runtimes/`.

Downloads incompletos ficam em arquivos `.part` associados ao hash. Cancelar preserva o parcial; Instalar/Reparar retoma quando a fonte aceita Range. Nenhuma instância é marcada como instalada antes da conclusão. Reparar verifica os hashes. Remover da lista não apaga arquivos. Alterar o diretório não move dados: copie-os manualmente ou reinstale os recursos.

Para reutilizar uma pasta `.minecraft` existente, selecione-a como diretório dos jogos e use Detectar na pasta configurada. Se a pasta contém `versions/`, seus recursos oficiais são reutilizados diretamente; o launcher mantém os novos mundos em instâncias separadas. A detecção cria perfis vanilla; loaders existentes de outros launchers precisam de um perfil novo com as versões correspondentes.

Configuração corrompida recupera o último backup válido. Se ambos falharem, a inicialização mostra o problema sem apagar seus arquivos. O cofre Microsoft não usa armazenamento em texto simples; no Linux exige um backend seguro do sistema.

## Configuração da comunidade e distribuição

Edite [config/distribution.json](config/distribution.json) antes do build. Não coloque client secrets: o client ID é público. Autenticação real requer registro/autorização externos. Atualizações são habilitadas apenas para instalação Windows empacotada com URL HTTPS e publisher configurados; a publicação exige certificado.

- [Autenticação Microsoft](docs/AUTHENTICATION.md)
- [Contratos MATRIX e modpacks](docs/API.md)
- [Publicação e assinatura](docs/DISTRIBUTION.md)
- [Arquitetura, dependências e etapas](docs/IMPLEMENTATION.md)
- [Validação e testes pendentes](docs/TESTING.md)

O launcher não inclui nem redistribui o jogo, assets, Java ou mods no instalador. Os arquivos são obtidos de suas fontes autorizadas. Perfis offline são identidades locais; não representam licenças ou sessões oficiais e não contornam servidores online. MATRIX Launcher não é um produto oficial Mojang/Microsoft.
