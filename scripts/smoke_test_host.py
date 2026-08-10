#!/usr/bin/env python3
"""Exercise the native host protocol with a public YouTube URL."""

from __future__ import annotations

import argparse
import json
import os
import struct
import subprocess
import sys
from pathlib import Path


def write_frame(stream, message):
    payload = json.dumps(message).encode("utf-8")
    stream.write(struct.pack("=I", len(payload)))
    stream.write(payload)
    stream.flush()


def read_frame(stream):
    header = stream.read(4)
    if not header:
        raise RuntimeError("Native host exited before returning a result")
    length = struct.unpack("=I", header)[0]
    if length <= 0 or length > 16 * 1024 * 1024:
        raise RuntimeError(f"Invalid native host frame length: {length} (protocol corrupted?)")
    payload = stream.read(length)
    if len(payload) != length:
        raise RuntimeError("Incomplete native host frame")
    return json.loads(payload)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--model", default="tiny")
    parser.add_argument("--data-dir", default="/tmp/tubecaption-smoke-data")
    args = parser.parse_args()

    project = Path(__file__).resolve().parents[1]
    host = project / "native-host" / "chrono_asr_host.py"
    environment = {**os.environ, "TUBECAPTION_DATA_DIR": args.data_dir}
    process = subprocess.Popen(
        [sys.executable, str(host)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=None,
        env=environment,
    )
    segments = []
    metadata = None
    try:
        write_frame(process.stdin, {
            "action": "transcribe",
            "jobId": "smoke-test",
            "url": args.url,
            "language": "auto",
            "model": args.model,
        })
        while True:
            message = read_frame(process.stdout)
            if message.get("type") == "progress":
                print(message.get("message"), file=sys.stderr)
            elif message.get("type") == "resultStart":
                metadata = message.get("data")
            elif message.get("type") == "resultChunk":
                segments.extend(message.get("segments") or [])
            elif message.get("type") == "resultEnd":
                break
            elif message.get("type") == "error":
                raise RuntimeError(message.get("error") or "Unknown host error")
    finally:
        if process.stdin:
            process.stdin.close()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)

    print(json.dumps({
        "title": (metadata or {}).get("title"),
        "language": (metadata or {}).get("selectedTrack", {}).get("language"),
        "segmentCount": len(segments),
        "preview": segments[:3],
    }, ensure_ascii=False, indent=2))
    return 0 if metadata and segments else 1


if __name__ == "__main__":
    raise SystemExit(main())
