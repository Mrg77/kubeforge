#!/bin/sh
# KubeForge installer — https://github.com/Mrg77/kubeforge
# Works on Linux (Debian, Ubuntu, Alpine…) and macOS.
# Usage: curl -fsSL https://raw.githubusercontent.com/Mrg77/kubeforge/main/install.sh | sh
set -eu

REPO="Mrg77/kubeforge"
INSTALL_DIR="${KUBEFORGE_INSTALL_DIR:-$HOME/.local/bin}"

os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$os" in
  darwin|linux) ;;
  *) echo "error: unsupported OS '$os' (darwin and linux only — use WSL on Windows)" >&2; exit 1 ;;
esac

arch=$(uname -m)
case "$arch" in
  x86_64|amd64) arch=amd64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "error: unsupported architecture '$arch'" >&2; exit 1 ;;
esac

version="${KUBEFORGE_VERSION:-}"
if [ -z "$version" ]; then
  version=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | grep '"tag_name"' | head -1 | cut -d '"' -f 4)
fi
[ -n "$version" ] || { echo "error: could not resolve latest release" >&2; exit 1; }

archive="kubeforge_${version#v}_${os}_${arch}.tar.gz"
url="https://github.com/$REPO/releases/download/$version/$archive"

echo "Downloading kubeforge $version ($os/$arch)..."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$url" -o "$tmp/$archive"
tar -xzf "$tmp/$archive" -C "$tmp" kubeforge

mkdir -p "$INSTALL_DIR"
install -m 0755 "$tmp/kubeforge" "$INSTALL_DIR/kubeforge"
echo "Installed to $INSTALL_DIR/kubeforge"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "note: add $INSTALL_DIR to your PATH, e.g.:"
     echo "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.bashrc" ;;
esac

echo
echo "Get started:"
echo "  kubeforge        # opens the local web console for your Kubernetes cluster"
