# 视频字幕提取插件

视频字幕提取插件是一个面向 Chrome / Chromium 的本地 YouTube 字幕工具。

- 视频已有字幕轨时，直接读取 YouTube 提供的字幕。
- 视频没有字幕轨时，通过本地 `yt-dlp + faster-whisper` 生成机器字幕。
- 支持导出 Markdown、SRT、TXT 和 JSON。
- 音频只保存在临时目录，识别结束后自动删除。
- 默认不读取浏览器 Cookie，不绕过登录、地区或付费访问限制。

本项目是独立的 clean-room 实现，与 Chrono 项目及其作者没有隶属或背书关系。

## 下载与安装（macOS）

1. 从 GitHub Releases 下载 `video-subtitle-extractor-v0.1.2-macos.zip`。
2. 解压后，双击 `install-macos.command`。
3. 首次安装会创建独立 Python 虚拟环境并安装语音识别依赖，可能需要几分钟。
4. 打开 `chrome://extensions`，开启“开发者模式”。
5. 点击“加载已解压的扩展程序”，选择安装脚本最后显示的 `extension` 目录。
6. 打开 YouTube 视频，点击扩展图标。

扩展 ID 固定为：`nhhnpcghjppnpenldjjaofbnfkpoogdf`。

首次使用本地识别时会下载 Whisper `small` 模型。模型会缓存在：

```text
~/Library/Application Support/TubeCaptionLocal/models
```

默认先使用 Hugging Face 官方模型源；官方源不可用时会回退到
`https://hf-mirror.com`。如需指定自己的兼容镜像，可在本地宿主环境设置
`TUBECAPTION_MODEL_ENDPOINT`。

## 使用

1. 打开 `youtube.com/watch?v=...` 或 YouTube Shorts。
2. 点击扩展图标。
3. 如果检测到字幕轨，选择语言后点击“提取已有字幕”。
4. 如果没有字幕轨，点击“本地生成字幕”。
5. 识别完成后选择 MD、SRT、TXT 或 JSON 下载。

## 系统要求

- macOS 12 或更高版本。
- Chrome、Chromium、Brave 或 Microsoft Edge。
- Python 3.10 至 3.13（推荐 3.12；当前依赖链暂不支持 3.14）。
- 首次安装依赖和首次下载模型时需要联网。
- 推荐至少 8 GB 内存；长视频的识别时间取决于 CPU。

如果没有合适的 Python，建议先安装 Homebrew Python：

```bash
brew install python@3.12
```

## 隐私与边界

- 本地识别不会把音频或字幕发送到云端 AI 服务。
- `yt-dlp` 仅用于获取当前用户可正常访问的公开视频音频。
- 登录受限、会员、付费、地区受限或 DRM 内容不在支持范围内。
- 机器字幕可能识别错误，导出内容会明确标记为本地 ASR。
- 请只处理你有权访问和使用的内容，并遵守平台条款及适用法律。

## 开发检查

```bash
node --check extension/background.js
node --check extension/content.js
node --check extension/page.js
node --check extension/popup.js
node --test extension/tests/*.test.js
python3 -m unittest discover -s native-host/tests
bash scripts/build-release.sh
```

安装开发依赖后，可用公开短视频执行完整 Native Messaging 冒烟测试：

```bash
.venv/bin/python scripts/smoke_test_host.py "https://www.youtube.com/watch?v=VIDEO_ID"
```

## 许可证

本仓库原创代码使用 [MIT License](LICENSE)。安装时下载的 `yt-dlp`、
`faster-whisper` 及其依赖使用各自许可证，本仓库不会把它们重新授权为 MIT。
