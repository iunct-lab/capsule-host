#!/usr/bin/env bash
# IaC の lint（sam validate --lint）。CI（.github/workflows/ci.yml）とローカル CI が同じこの手順を回す。
# 固定の版の SAM CLI が PATH に無ければ、公式のリリースの zip を sha256 で確かめて、この実行だけの場所に入れる（置き場には確かめた zip だけを残す）。
# 版を上げるときは、下の SAM_VERSION と sha256（https://github.com/aws/aws-sam-cli/releases の Hashes）を変える。
set -euo pipefail

SAM_VERSION=1.166.2
SHA256_ARM64=3fd8eba05754538767c6e664496998721f22028343401f0b94314e44d215b55a
SHA256_X86_64=4419ea4bb4ae1c69d2d41b346f77fdcd80099ae4ba9da7278e23427d54b05420

cd "$(dirname "${BASH_SOURCE[0]}")/.."

home="${XDG_CACHE_HOME:-$HOME/.cache}/capsule-host/sam-$SAM_VERSION"
want="SAM CLI, version $SAM_VERSION"

if command -v sam >/dev/null 2>&1 && [ "$(sam --version 2>/dev/null || true)" = "$want" ]; then
  sam=$(command -v sam)
elif [ "$(uname -s)" = Linux ]; then
  case "$(uname -m)" in
    aarch64) zip=aws-sam-cli-linux-arm64.zip; sha=$SHA256_ARM64 ;;
    x86_64) zip=aws-sam-cli-linux-x86_64.zip; sha=$SHA256_X86_64 ;;
    *) echo "未対応の CPU: $(uname -m)。SAM CLI $SAM_VERSION を入れて（aws/README.md）" >&2; exit 1 ;;
  esac
  # 置き場に残すのは配布物（zip）だけ。入れた sam は残さず、毎回 zip の sha256 を確かめ直して、この実行だけの場所に入れる
  # （置き場は実行をまたいで残ることがあり、版の文字だけでは中身を信じられないため）
  mkdir -p "$home"
  run=$(mktemp -d "$home/run.XXXXXX")
  trap 'rm -rf "$run"' EXIT
  verified() { (cd "$(dirname "$1")" && echo "$sha  $(basename "$1")" | sha256sum -c --quiet - >/dev/null 2>&1); }
  if ! [ -f "$home/$zip" ] || ! verified "$home/$zip"; then
    echo "SAM CLI $SAM_VERSION をダウンロードする: $home/$zip"
    curl -fsSL -o "$run/$zip" "https://github.com/aws/aws-sam-cli/releases/download/v$SAM_VERSION/$zip"
    verified "$run/$zip" || { echo "sha256 が合わない。$zip は展開しない" >&2; exit 1; }
    mv -f "$run/$zip" "$home/$zip"
  fi
  # 確かめた後に別の実行が置き場の zip を替えても使わないよう、この実行の場所へ写してから確かめ直して展開する
  cp "$home/$zip" "$run/$zip"
  verified "$run/$zip" || { echo "sha256 が合わない。$zip は展開しない" >&2; exit 1; }
  unzip -q "$run/$zip" -d "$run/x"
  "$run/x/install" --install-dir "$run/dist" --bin-dir "$run/bin" >/dev/null
  sam="$run/bin/sam"
else
  command -v sam >/dev/null 2>&1 || { echo "SAM CLI を入れて（aws/README.md）" >&2; exit 1; }
  sam=$(command -v sam)
fi

"$sam" validate --lint --template-file aws/template.yaml --region ap-northeast-1
