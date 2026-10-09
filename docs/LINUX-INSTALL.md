# MATRIX Launcher — pacotes Linux x86_64

## Ubuntu, Linux Mint e Debian

Use o arquivo `matrix-launcher_VERSAO_amd64.deb`. Abra-o com o instalador de aplicativos da distribuição e confirme a instalação. Depois procure **MATRIX Launcher** no menu de aplicativos e adicione aos favoritos. Não é necessário instalar Node.js ou compilar o código.

Se a distribuição não possuir instalador gráfico de pacotes, abra um terminal na pasta do arquivo e execute, substituindo VERSAO pelo número recebido:

```bash
sudo apt install ./matrix-launcher_VERSAO_amd64.deb
```

A autorização administrativa é para instalar o pacote; execute o launcher com seu usuário normal.

## AppImage

O arquivo `MATRIX-Launcher-VERSAO-linux-x64.AppImage` é portátil. Nas propriedades do arquivo, permita sua execução e abra-o. Guarde-o em uma pasta Linux onde seu usuário possa escrever. Algumas distribuições podem exigir componentes FUSE; consulte a mensagem de erro antes de instalar dependências.

O AppImage é o formato preparado para atualização automática. Ela requer uma release com os metadados assinados correspondentes e testes entre versões. Os artefatos de teste do GitHub Actions não habilitam atualizações públicas por conta própria.

## Fedora e outras distribuições RPM

O arquivo `.rpm` é gerado para avaliação. Instale pelo gerenciador de pacotes da distribuição somente após testes no seu sistema. Não declare compatibilidade com Fedora/openSUSE sem validar a abertura e o Minecraft nesses sistemas.

## O que acompanha o pacote

- `.deb`: instalação e atalho no menu para sistemas Debian/Ubuntu compatíveis.
- `.AppImage`: aplicativo portátil Linux.
- `.rpm`: pacote para testes em distribuições RPM.
- `SHA256SUMS.txt`: hashes reais dos três pacotes, para verificar integridade.
- `LEIA-ME-LINUX.md`: estas instruções.

Para verificar todos os arquivos juntos, pelo terminal na pasta extraída:

```bash
sha256sum -c SHA256SUMS.txt
```

O hash ajuda a detectar corrupção; obtenha o pacote pelo canal oficial MATRIX. Não desative o sandbox ou outras proteções para conseguir abrir. Se houver erro, execute `matrix-launcher` pelo terminal (instalação DEB/RPM) e envie a mensagem para diagnóstico, removendo dados pessoais.

Atualizações DEB/RPM são manuais, instalando o pacote mais recente. Os dados pessoais ficam separados da instalação; a desinstalação do pacote não deve apagar mundos e instâncias. Faça backup antes dos testes e não remova manualmente os diretórios de dados do usuário.

Estes pacotes são para validação inicial. A geração e a inspeção dos arquivos não comprovam a execução do Minecraft, autenticação, renderização 3D ou atualização automática na sua distribuição.
