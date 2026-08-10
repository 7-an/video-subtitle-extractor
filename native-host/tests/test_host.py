import importlib.util
import io
import json
import struct
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "chrono_asr_host.py"
SPEC = importlib.util.spec_from_file_location("chrono_asr_host", MODULE_PATH)
host = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(host)


class UrlValidationTests(unittest.TestCase):
    def test_accepts_watch_and_shorts_urls(self):
        urls = [
            "https://www.youtube.com/watch?v=abc123",
            "https://m.youtube.com/shorts/abc123",
            "https://youtu.be/abc123",
        ]
        for url in urls:
            with self.subTest(url=url):
                self.assertEqual(host.validate_youtube_url(url), url)

    def test_rejects_non_youtube_and_credentials(self):
        urls = [
            "http://www.youtube.com/watch?v=abc123",
            "https://example.com/watch?v=abc123",
            "https://youtube.com.evil.test/watch?v=abc123",
            "https://name:password@youtube.com/watch?v=abc123",
            "https://youtube.com:444/watch?v=abc123",
            "https://youtube.com/channel/example",
        ]
        for url in urls:
            with self.subTest(url=url):
                with self.assertRaises(ValueError):
                    host.validate_youtube_url(url)


class ProtocolTests(unittest.TestCase):
    def test_round_trip_message(self):
        value = {"action": "transcribe", "title": "中文测试"}
        stream = io.BytesIO()
        host.write_message(value, stream)
        stream.seek(0)
        self.assertEqual(host.read_message(stream), value)

    def test_frame_uses_four_byte_length(self):
        stream = io.BytesIO()
        host.write_message({"ok": True}, stream)
        raw = stream.getvalue()
        length = struct.unpack("=I", raw[:4])[0]
        self.assertEqual(length, len(raw[4:]))
        self.assertEqual(json.loads(raw[4:]), {"ok": True})


if __name__ == "__main__":
    unittest.main()
