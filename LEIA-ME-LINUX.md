# MATRIX Launcher no Linux

Este pacote contém o código do launcher, com preparação automática e atalho no menu. Ainda não é um AppImage ou instalador Linux validado.

## Primeira abertura — Ubuntu, Linux Mint e Debian x86_64

1. Extraia o ZIP em sua pasta pessoal Linux, por exemplo `~/Aplicativos/MATRIX-Launcher`. Evite executar diretamente no SSD Windows: permissões de discos NTFS podem impedir a abertura.
2. Instale **Node.js 24.19 ou superior com npm**, seguindo as instruções oficiais em https://nodejs.org/en/download. Confira `node --version` e `npm --version`. A versão dos repositórios da distribuição pode ser antiga demais.
3. Abra um terminal na pasta extraída, onde estão `package.json` e `INICIAR-LINUX.sh`:

```bash
bash ./INICIAR-LINUX.sh
```

Na primeira vez, o script baixa as dependências, compila o launcher e cria o atalho **MATRIX Launcher** no menu de aplicativos. É necessário internet e espaço livre para as dependências. Aguarde as mensagens do terminal; se uma etapa falhar, a abertura é interrompida com o erro.

Depois, abra pelo menu e fixe nos favoritos. Não precisa de terminal, npm ou servidor de desenvolvimento em cada abertura. Mantenha a pasta extraída no mesmo lugar. Se mover a pasta ou receber código atualizado, execute novamente o comando acima para atualizar o build e o atalho.

Para apenas preparar sem abrir:

```bash
bash ./INICIAR-LINUX.sh --preparar
```

## Se não abrir

Execute `bash ./INICIAR-LINUX.sh` pelo terminal para ver o erro. Use sua sessão gráfica normal, sem `sudo`. Não acrescente `--no-sandbox` e não desative proteções do Electron.

Se aparecer uma biblioteca `.so` ausente, instale o pacote correspondente pelo gerenciador da sua distribuição. A lista varia por versão do sistema. Se o erro mencionar sandbox/AppArmor, envie a mensagem completa para diagnóstico; não altere permissões administrativas aleatoriamente.

Para remover somente este atalho, exclua `org.matrixcommunity.launcher-source.desktop` de `${XDG_DATA_HOME:-$HOME/.local/share}/applications`. Isso não remove suas contas, instâncias ou mundos.

## Dados e limitações

O iniciador usa o build de produção existente e o Electron nativo Linux. Não utiliza Wine, não instala Java globalmente e não altera o Windows. Minecraft e Java continuam sendo gerenciados pelos serviços do launcher.

As contas, mundos e configurações ficam nos diretórios pessoais definidos pelo launcher, separados desta pasta. Veja `docs/LINUX-SUPPORT.md` para os caminhos e a lista de testes pendentes.

O atalho não torna esta cópia de código um pacote distribuído: **atualização automática do aplicativo requer um AppImage empacotado e validado**. Para gerar os formatos Linux no próprio Linux:

```bash
npm run dist:linux
```

Os testes desta mudança foram executados no Windows sobre os scripts e a geração do atalho. A abertura gráfica, a instalação e a execução real do Minecraft ainda precisam ser testadas no Linux.
