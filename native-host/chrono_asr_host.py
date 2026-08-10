#!/usr/bin/env python3
"""Native Messaging host for 视频字幕提取插件 (Video Subtitle Extractor).

Stdout is reserved for Chrome's framed JSON protocol. Diagnostics go to stderr.
"""

from __future__ import annotations

import json
import os
import struct
import sys
import tempfile
import threading
import time
import traceback
from pathlib import Path
from typing import Any, BinaryIO
from urllib.parse import urlparse


# Xet transport can stall behind some proxies. Standard HTTPS is slower but
# substantially more predictable for a one-time model download.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "30")
os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "10")

HOST_NAME = "com.chrono_asr.host"
ALLOWED_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}
MAX_DURATION_SECONDS = 6 * 60 * 60
RESULT_CHUNK_SIZE = 100

_write_lock = threading.Lock()
_protocol_stream: BinaryIO | None = None
_worker_lock = threading.Lock()
_worker: threading.Thread | None = None
_cancel_event = threading.Event()
_active_job_id = ""
_models: dict[str, Any] = {}

MODEL_REPOSITORIES = {
    "tiny": "Systran/faster-whisper-tiny",
    "base": "Systran/faster-whisper-base",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
}


class CancelledError(RuntimeError):
    pass


def read_message(stream: BinaryIO) -> dict[str, Any] | None:
    header = stream.read(4)
    if not header:
        return None
    if len(header) != 4:
        raise ValueError("Incomplete native message header")
    length = struct.unpack("=I", header)[0]
    if length <= 0 or length > 16 * 1024 * 1024:
        raise ValueError("Invalid native message length")
    payload = stream.read(length)
    if len(payload) != length:
        raise ValueError("Incomplete native message payload")
    value = json.loads(payload.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("Native message must be a JSON object")
    return value


def reserve_protocol_stdout() -> BinaryIO | None:
    """Detach fd 1 from the framing channel and keep a private copy.

    Libraries such as yt-dlp write progress output to stdout, which corrupts
    the framed Native Messaging protocol. Protocol frames are written through
    a duplicated descriptor instead, and fd 1 is redirected to /dev/null so
    stray writes cannot interleave with frames.
    """
    try:
        protocol_fd = os.dup(1)
        devnull = os.open(os.devnull, os.O_WRONLY)
        os.dup2(devnull, 1)
        os.close(devnull)
        return os.fdopen(protocol_fd, "wb", buffering=0)
    except OSError as error:
        print(f"无法隔离 stdout，回退到默认协议通道：{error}", file=sys.stderr, flush=True)
        return None


def write_message(message: dict[str, Any], stream: BinaryIO | None = None) -> None:
    target = stream or _protocol_stream or sys.stdout.buffer
    payload = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with _write_lock:
        target.write(struct.pack("=I", len(payload)))
        target.write(payload)
        target.flush()


def validate_youtube_url(value: str) -> str:
    parsed = urlparse(str(value or ""))
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS:
        raise ValueError("只允许 HTTPS YouTube 视频地址。")
    if parsed.port not in (None, 443):
        raise ValueError("不允许自定义端口。")
    if parsed.username or parsed.password:
        raise ValueError("视频地址不能包含登录信息。")
    if parsed.hostname == "youtu.be":
        if not parsed.path.strip("/"):
            raise ValueError("YouTube 短链接缺少视频 ID。")
    elif parsed.path != "/watch" and not parsed.path.startswith("/shorts/"):
        raise ValueError("只支持 YouTube 普通视频或 Shorts 地址。")
    return value


def data_root() -> Path:
    configured = os.environ.get("TUBECAPTION_DATA_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return Path.home() / "Library" / "Application Support" / "TubeCaptionLocal"


def report(job_id: str, stage: str, message: str, **extra: Any) -> None:
    write_message({"type": "progress", "jobId": job_id, "stage": stage, "message": message, **extra})


def check_cancelled() -> None:
    if _cancel_event.is_set():
        raise CancelledError("识别任务已取消。")


def load_model(model_name: str, job_id: str) -> Any:
    if model_name in _models:
        return _models[model_name]

    report(job_id, "model", f"正在准备 Whisper {model_name} 模型；首次使用需要下载…")
    from faster_whisper import WhisperModel

    root = data_root() / "models"
    root.mkdir(parents=True, exist_ok=True)
    model_path = download_model(model_name, job_id, root)
    model = WhisperModel(model_path, device="cpu", compute_type="int8")
    check_cancelled()
    _models[model_name] = model
    return model


def download_model(model_name: str, job_id: str, root: Path) -> str:
    from huggingface_hub import snapshot_download

    configured_endpoint = os.environ.get("TUBECAPTION_MODEL_ENDPOINT", "").strip()
    endpoints: list[str | None] = [configured_endpoint] if configured_endpoint else [
        None,
        "https://hf-mirror.com",
    ]
    errors = []
    for endpoint in endpoints:
        source_label = "配置的模型源" if configured_endpoint else ("Hugging Face" if endpoint is None else "备用镜像")
        report(job_id, "model", f"正在从{source_label}下载或校验模型…")
        try:
            return str(snapshot_download(
                repo_id=MODEL_REPOSITORIES[model_name],
                cache_dir=root,
                endpoint=endpoint,
                max_workers=4,
            ))
        except Exception as error:
            errors.append(f"{source_label}: {error}")
            if configured_endpoint:
                break
            report(job_id, "model", "官方模型源不可用，正在尝试备用镜像…")
    raise RuntimeError("模型下载失败。" + " | ".join(errors))


def locate_audio(info: dict[str, Any], ydl: Any, temp_dir: Path) -> Path:
    downloads = info.get("requested_downloads") or []
    candidates = [item.get("filepath") for item in downloads if isinstance(item, dict)]
    candidates.extend([info.get("_filename"), ydl.prepare_filename(info)])
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return Path(candidate)

    video_id = str(info.get("id") or "")
    for candidate in temp_dir.glob(f"{video_id}.*"):
        if candidate.is_file() and not candidate.name.endswith((".part", ".ytdl")):
            return candidate
    raise RuntimeError("音频下载完成，但没有找到输出文件。")


def download_audio(url: str, job_id: str, temp_dir: Path) -> tuple[Path, dict[str, Any]]:
    report(job_id, "download", "正在获取视频音频…")
    from yt_dlp import YoutubeDL

    last_progress_at = 0.0

    def progress_hook(status: dict[str, Any]) -> None:
        nonlocal last_progress_at
        check_cancelled()
        if status.get("status") == "downloading":
            now = time.monotonic()
            if now - last_progress_at < 0.5:
                return
            last_progress_at = now
            percent = str(status.get("_percent_str") or "").strip()
            report(job_id, "download", f"正在下载音频 {percent}".strip())

    options = {
        "format": "bestaudio[ext=m4a]/bestaudio/best",
        "outtmpl": str(temp_dir / "%(id)s.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        # yt-dlp writes progress and diagnostics to stdout by default, which
        # would corrupt the framed Native Messaging stream.
        "noprogress": True,
        "logtostderr": True,
        "retries": 3,
        "fragment_retries": 3,
        "socket_timeout": 30,
        "progress_hooks": [progress_hook],
    }
    with YoutubeDL(options) as ydl:
        info = ydl.extract_info(url, download=True)
        check_cancelled()
        if not isinstance(info, dict):
            raise RuntimeError("无法读取 YouTube 视频信息。")
        duration = float(info.get("duration") or 0)
        if duration > MAX_DURATION_SECONDS:
            raise ValueError("视频超过 6 小时，已停止处理。")
        return locate_audio(info, ydl, temp_dir), info


def transcribe(request: dict[str, Any]) -> dict[str, Any]:
    job_id = str(request.get("jobId") or "")
    url = validate_youtube_url(str(request.get("url") or ""))
    model_name = str(request.get("model") or "small")
    if model_name not in {"tiny", "base", "small", "medium"}:
        raise ValueError("不支持的 Whisper 模型。")
    language = str(request.get("language") or "auto")
    language_arg = None if language == "auto" else language

    root = data_root()
    temp_root = root / "tmp"
    temp_root.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="job-", dir=temp_root) as directory:
        audio_path, info = download_audio(url, job_id, Path(directory))
        check_cancelled()
        model = load_model(model_name, job_id)
        report(job_id, "transcribe", "正在识别语音并生成时间轴…")

        segment_stream, detected = model.transcribe(
            str(audio_path),
            language=language_arg,
            beam_size=5,
            vad_filter=True,
            condition_on_previous_text=True,
        )
        segments: list[dict[str, Any]] = []
        for index, segment in enumerate(segment_stream):
            check_cancelled()
            text = str(segment.text or "").strip()
            if text:
                segments.append({
                    "startSeconds": round(float(segment.start), 3),
                    "durationSeconds": round(max(0.0, float(segment.end) - float(segment.start)), 3),
                    "text": text,
                })
            if index and index % 25 == 0:
                report(job_id, "transcribe", f"已生成 {len(segments)} 段字幕…")

        if not segments:
            raise RuntimeError("语音识别完成，但没有生成可读文本。")

        detected_language = str(getattr(detected, "language", "") or language_arg or "und")
        return {
            "platform": "youtube",
            "videoId": str(info.get("id") or ""),
            "url": str(info.get("webpage_url") or url),
            "title": str(info.get("title") or "YouTube video"),
            "author": str(info.get("uploader") or info.get("channel") or ""),
            "selectedTrack": {
                "id": "local-asr",
                "language": detected_language,
                "label": f"{detected_language}（本地 Whisper）",
                "source": "local-asr",
                "model": model_name,
            },
            "segments": segments,
            "text": "\n".join(item["text"] for item in segments),
            "warnings": ["该字幕由本地语音识别生成，并非视频发布者提供，可能存在识别错误。"],
        }


def send_result(job_id: str, data: dict[str, Any]) -> None:
    segments = data.get("segments") or []
    metadata = {key: value for key, value in data.items() if key not in {"segments", "text"}}
    write_message({"type": "resultStart", "jobId": job_id, "data": metadata})
    for index in range(0, len(segments), RESULT_CHUNK_SIZE):
        write_message({
            "type": "resultChunk",
            "jobId": job_id,
            "segments": segments[index:index + RESULT_CHUNK_SIZE],
        })
    write_message({"type": "resultEnd", "jobId": job_id})


def run_job(request: dict[str, Any]) -> None:
    global _active_job_id
    job_id = str(request.get("jobId") or "")
    try:
        result = transcribe(request)
        check_cancelled()
        send_result(job_id, result)
    except CancelledError as error:
        write_message({"type": "error", "jobId": job_id, "error": str(error)})
    except Exception as error:
        details = ""
        if os.environ.get("TUBECAPTION_DEBUG") == "1":
            details = traceback.format_exc(limit=5)
        print(f"subtitle-extractor job failed: {error}", file=sys.stderr, flush=True)
        write_message({"type": "error", "jobId": job_id, "error": str(error), "details": details})
    finally:
        with _worker_lock:
            _active_job_id = ""
            _cancel_event.clear()


def start_job(request: dict[str, Any]) -> None:
    global _worker, _active_job_id
    job_id = str(request.get("jobId") or "")
    if not job_id:
        write_message({"type": "error", "jobId": "", "error": "缺少任务 ID。"})
        return
    with _worker_lock:
        if _worker and _worker.is_alive():
            write_message({"type": "error", "jobId": job_id, "error": "已有识别任务正在运行。"})
            return
        _cancel_event.clear()
        _active_job_id = job_id
        _worker = threading.Thread(target=run_job, args=(request,), name="transcription", daemon=True)
        _worker.start()


def handle_message(message: dict[str, Any]) -> None:
    if message.get("action") == "transcribe":
        start_job(message)
        return
    if message.get("action") == "cancel":
        if str(message.get("jobId") or "") == _active_job_id:
            _cancel_event.set()
        return
    write_message({
        "type": "error",
        "jobId": str(message.get("jobId") or ""),
        "error": "不支持的本地助手操作。",
    })


def main() -> int:
    global _protocol_stream
    _protocol_stream = reserve_protocol_stdout()
    try:
        while True:
            message = read_message(sys.stdin.buffer)
            if message is None:
                _cancel_event.set()
                return 0
            handle_message(message)
    except Exception as error:
        print(f"Native host protocol failure: {error}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
