# Suporte Linux — auditoria e estado da implementação

## O que foi adaptado

- Builds Linux x86_64 configurados para AppImage, DEB e RPM. O empacotador gera também a integração `.desktop` e usa o ícone existente.
- Em instalações Linux novas, configurações e credenciais ficam no diretório de dados do Electron; jogos, biblioteca de mods e skins usam `XDG_DATA_HOME` (ou `~/.local/share`); logs usam `XDG_STATE_HOME` (ou `~/.local/state`). Diretórios antigos de biblioteca e skins em `userData` continuam sendo usados para preservar instalações de desenvolvimento existentes.
- Detecção e execução Java usam `java` no Linux e o caminho do executável selecionado. A instalação de runtimes Mojang aceita links simbólicos somente quando seus destinos permanecem dentro do runtime; arquivos inesperados e links externos são recusados.
- O atualizador assinado reconhece metadados Linux. Atualizações automáticas ficam habilitadas apenas para AppImage; DEB e RPM devem ser atualizados pelo gerenciador de pacotes/distribuição.
- CI ganhou jobs para gerar e validar os pacotes Linux. Releases versionadas podem anexar AppImage, DEB e RPM e assinar o manifesto Linux com a chave já usada pelo canal de atualização.
- O fluxo de login continua usando o código de dispositivo Microsoft e o armazenamento seguro do Electron. Se o cofre do sistema não estiver disponível, o launcher recusa salvar credenciais em texto simples.

## Incompatibilidades e limites conhecidos

- Esta máquina de desenvolvimento é Windows. Portanto, AppImage, DEB e RPM não foram gerados nem executados localmente nesta validação; o novo runner Linux do GitHub Actions precisa concluir para validar o empacotamento.
- Ainda falta teste manual em Ubuntu/Debian/Mint e Fedora, com X11 e Wayland, além de executar Minecraft real em Linux. Não anuncie essas distribuições como testadas antes desses ensaios.
- GPUs Linux não são identificadas por um adaptador confiável nesta versão; o Smart Install informa a ausência e permite ajuste manual, sem inventar modelo ou VRAM.
- Java automático é limitado a Linux x86_64. Outras arquiteturas exigem selecionar manualmente um runtime compatível.
- Perfis DEB/RPM não são atualizados pelo launcher. AppImage precisa ser executado a partir de um arquivo gravável pelo usuário para que o atualizador consiga substituí-lo.
- Dependências gráficas do sistema, drivers OpenGL/Vulkan e cofres GNOME/KDE variam por distribuição. A abertura do aplicativo em um build não garante, por si só, que Minecraft ou o cofre estejam configurados.

## Instalação e teste local

Para testar o **código-fonte** sem executar comandos separados de instalação e build, use `bash ./INICIAR-LINUX.sh` na raiz extraída. O iniciador verifica Linux x86_64 e Node.js, instala dependências quando necessário, reutiliza o build sem alterações e cria um atalho pessoal no menu. Veja [LEIA-ME-LINUX.md](../LEIA-ME-LINUX.md). Esse fluxo não equivale a um AppImage empacotado e não habilita suas atualizações automáticas.

Validação do iniciador: testes automatizados de diretórios XDG, escaping do atalho e invalidação do build, mais sintaxe Bash, executados no Windows. A abertura gráfica em Linux continua pendente.

No Ubuntu/Debian/Mint, prefira o `.deb` e instale usando o gerenciador de pacotes. No Fedora/openSUSE compatível, utilize o `.rpm` pelo gerenciador da distribuição. Para AppImage:

```sh
chmod +x MATRIX-Launcher-*.AppImage
./MATRIX-Launcher-*.AppImage
```

Teste primeiro perfil offline, instalação Vanilla, Java detectado/manual, Fabric e um mod compatível. Faça backup dos mundos. Não use `sudo` para executar o launcher ou o Minecraft.

O mecanismo do electron-builder oferece alvos AppImage, DEB e RPM; a distribuição e as atualizações têm requisitos diferentes por formato. Consulte a [documentação Linux](https://www.electron.build/v26/docs/linux/) e a [documentação de atualizações](https://www.electron.build/docs/features/auto-update/).
