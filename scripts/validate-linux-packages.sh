#!/usr/bin/env bash
set -euo pipefail
[[ "$(uname -s)" == Linux ]] || { echo 'Esta validação requer Linux.' >&2; exit 1; }
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
version="$(node -p 'JSON.parse(require("fs").readFileSync("package.json", "utf8")).version')"
deb="release/matrix-launcher_${version}_amd64.deb"
rpm="release/matrix-launcher-${version}.x86_64.rpm"
image="release/MATRIX-Launcher-${version}-linux-x64.AppImage"
for package in "$deb" "$rpm" "$image"; do
  test -s "$package" || { echo "Pacote ausente: $package" >&2; exit 1; }
done
test "$(dpkg-deb -f "$deb" Package)" = matrix-launcher
test "$(dpkg-deb -f "$deb" Version)" = "$version"
test "$(dpkg-deb -f "$deb" Architecture)" = amd64
test "$(rpm -qp --queryformat '%{ARCH}' "$rpm")" = x86_64
test "$(rpm -qp --queryformat '%{VERSION}' "$rpm")" = "$version"
validation_directory="$(mktemp -d -t matrix-linux-package.XXXXXXXX)"
trap 'rm -rf -- "$validation_directory"' EXIT
dpkg-deb -x "$deb" "$validation_directory"
desktop="$validation_directory/usr/share/applications/matrix-launcher.desktop"
desktop-file-validate "$desktop"
grep -q '^Name=MATRIX Launcher$' "$desktop"
if grep -q -- '--no-sandbox' "$desktop"; then
  echo 'O atalho não pode desativar o sandbox.' >&2
  exit 1
fi
test -x "$validation_directory/opt/MATRIX Launcher/matrix-launcher"
test -s "$validation_directory/opt/MATRIX Launcher/resources/app.asar"
node --input-type=module - "$image" "$validation_directory/opt/MATRIX Launcher/matrix-launcher" <<'NODE'
import { open } from 'node:fs/promises';
for (const [index, path] of process.argv.slice(2).entries()) {
  const file = await open(path);
  try {
    const header = Buffer.alloc(12);
    await file.read(header, 0, 12, 0);
    if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error(`Não é um executável Linux: ${path}`);
    if (index === 0 && !header.subarray(8, 11).equals(Buffer.from([0x41, 0x49, 0x02]))) throw new Error('AppImage tipo 2 inválido.');
  } finally { await file.close(); }
}
NODE
cp docs/LINUX-INSTALL.md release/LEIA-ME-LINUX.md
(
  cd release
  sha256sum "matrix-launcher_${version}_amd64.deb" "matrix-launcher-${version}.x86_64.rpm" "MATRIX-Launcher-${version}-linux-x64.AppImage" > SHA256SUMS.txt
  sha256sum -c SHA256SUMS.txt
)
echo "Pacotes MATRIX Launcher $version verificados. Ainda é necessário testar a abertura e o Minecraft no Linux do jogador."
