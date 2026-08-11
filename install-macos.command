#!/bin/bash
set -euo pipefail

APP_NAME="TubeCaptionLocal"
HOST_NAME="com.chrono_asr.host"
EXTENSION_ID="nhhnpcghjppnpenldjjaofbnfkpoogdf"
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
APP_DIR="$HOME/Library/Application Support/$APP_NAME"
HOST_DIR="$APP_DIR/native-host"
EXTENSION_DIR="$APP_DIR/extension"
VENV_DIR="$APP_DIR/venv"
UPGRADING=false
if [[ -d "$APP_DIR" ]]; then
  UPGRADING=true
fi

printf '\n视频字幕提取插件 安装器\n'
printf '=========================\n\n'

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf '此安装器只支持 macOS。\n' >&2
  exit 1
fi

find_python() {
  local candidate
  for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
      if "$candidate" -c 'import sys; raise SystemExit(0 if (3, 10) <= sys.version_info < (3, 14) else 1)'; then
        command -v "$candidate"
        return 0
      fi
    fi
  done
  return 1
}

PYTHON_BIN="$(find_python || true)"
if [[ -z "$PYTHON_BIN" ]]; then
  printf '需要 Python 3.10 至 3.13；Python 3.14 暂不受依赖链支持。\n' >&2
  printf '如已安装 Homebrew，请先运行：brew install python@3.12\n' >&2
  exit 1
fi

printf '使用 Python：%s\n' "$PYTHON_BIN"
mkdir -p "$HOST_DIR" "$EXTENSION_DIR"
cp "$SCRIPT_DIR/native-host/chrono_asr_host.py" "$HOST_DIR/chrono_asr_host.py"
cp "$SCRIPT_DIR/native-host/requirements.txt" "$HOST_DIR/requirements.txt"
cp -R "$SCRIPT_DIR/extension/." "$EXTENSION_DIR/"

if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  printf '创建独立 Python 环境…\n'
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

printf '安装或更新本地识别依赖…\n'
"$VENV_DIR/bin/python" -m pip install --upgrade pip wheel
"$VENV_DIR/bin/python" -m pip install --upgrade --prefer-binary -r "$HOST_DIR/requirements.txt"

HOST_RUNNER="$HOST_DIR/run-host.sh"
cat > "$HOST_RUNNER" <<EOF
#!/bin/bash
export TUBECAPTION_DATA_DIR="$APP_DIR"
exec "$VENV_DIR/bin/python" "$HOST_DIR/chrono_asr_host.py"
EOF
chmod 755 "$HOST_RUNNER"

NATIVE_MANIFEST="$HOST_DIR/$HOST_NAME.json"
cat > "$NATIVE_MANIFEST" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Local transcription host for 视频字幕提取插件",
  "path": "$HOST_RUNNER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF

REGISTER_DIRS=(
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
  "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
)

for directory in "${REGISTER_DIRS[@]}"; do
  mkdir -p "$directory"
  cp "$NATIVE_MANIFEST" "$directory/$HOST_NAME.json"
done

if [[ "$UPGRADING" == true ]]; then
  printf '\n升级完成；原有模型缓存已保留。\n'
else
  printf '\n安装完成。\n'
fi
printf '1. 打开 chrome://extensions\n'
if [[ "$UPGRADING" == true ]]; then
  printf '2. 找到“视频字幕提取插件”，点击“重新加载”\n'
  printf '3. 不需要删除旧扩展，也不要运行卸载脚本\n'
else
  printf '2. 开启“开发者模式”\n'
  printf '3. 点击“加载已解压的扩展程序”\n'
  printf '4. 选择：%s\n' "$EXTENSION_DIR"
fi
printf '\n扩展 ID 应显示为：%s\n' "$EXTENSION_ID"
printf '首次本地识别会下载 Whisper 模型。\n\n'
