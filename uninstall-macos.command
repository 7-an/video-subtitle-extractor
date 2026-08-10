#!/bin/bash
set -euo pipefail

APP_DIR="$HOME/Library/Application Support/TubeCaptionLocal"
HOST_NAME="com.chrono_asr.host"
REGISTER_DIRS=(
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
  "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
)

for directory in "${REGISTER_DIRS[@]}"; do
  rm -f "$directory/$HOST_NAME.json"
done
rm -rf "$APP_DIR"

printf 'TubeCaption Local 的本地助手、模型缓存和注册文件已删除。\n'
printf '请在 chrome://extensions 中手动移除扩展。\n'

