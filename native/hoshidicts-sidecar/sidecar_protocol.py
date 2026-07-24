# SPDX-License-Identifier: GPL-3.0-only

import base64
import json
import pathlib
import subprocess
import sys
import tempfile
import zipfile


class Sidecar:
    def __init__(self, executable, root):
        self.process = subprocess.Popen(
            [str(executable), "--dictionary-root", str(root)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )
        self.events = []

    def send(self, request_id, method, params=None, allow_error=False):
        message = {"id": request_id, "method": method, "params": params or {}}
        self.process.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
        self.process.stdin.flush()
        return self.response(request_id, allow_error)

    def response(self, request_id, allow_error=False):
        while True:
            message = json.loads(self.process.stdout.readline())
            if "event" in message:
                self.events.append(message)
                continue
            if message.get("id") != request_id:
                continue
            if not allow_error:
                assert "error" not in message, message
            return message

    def close(self, request_id):
        assert self.send(request_id, "shutdown")["result"] == {"ok": True}
        assert self.process.wait(timeout=5) == 0


def make_dictionary(path):
    media = b"\x89PNG\r\n\x1a\nHayase dictionary media"
    files = {
        "index.json": {"title": "日本語辞書", "revision": "1", "format": 3},
        "term_bank_1.json": [
            ["食べる", "たべる", "", "v1", 10, ["to eat"], 1, "common"],
        ],
        "term_meta_bank_1.json": [
            ["食べる", "freq", {"reading": "たべる", "frequency": {"value": 42, "displayValue": "42"}}],
            ["食べる", "pitch", {"reading": "たべる", "pitches": [{"position": 2}]}],
        ],
    }
    with zipfile.ZipFile(path, "w") as archive:
        for name, value in files.items():
            archive.writestr(name, json.dumps(value, ensure_ascii=False))
        archive.writestr("styles.css", ".glossary-content { color: rgb(1, 2, 3); }")
        archive.writestr("media/test.png", media)

def make_frequency_dictionary(path):
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("index.json", json.dumps({"title": "Test Frequency", "revision": "1", "format": 3}))
        archive.writestr(
            "term_bank_1.json",
            json.dumps([["見る", "みる", "", "", 0, [], 0, ""]], ensure_ascii=False),
        )
        archive.writestr(
            "term_meta_bank_1.json",
            json.dumps([["見る", "freq", {"reading": "みる", "frequency": 7}]], ensure_ascii=False),
        )


def make_term_backed_pitch_dictionary(path):
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("index.json", json.dumps({"title": "Test Pitch Guide", "revision": "1", "format": 3}))
        archive.writestr(
            "term_bank_1.json",
            json.dumps([["数える", "かぞえる", "", "v1", 0, ["pitch guide"], 0, ""]], ensure_ascii=False),
        )


def main():
    executable = pathlib.Path(sys.argv[1])
    with tempfile.TemporaryDirectory() as temporary:
        temporary = pathlib.Path(temporary)
        root = temporary / "日本語プロファイル" / "dictionaries"
        dictionary_zip = temporary / "日本語辞書.zip"
        frequency_zip = temporary / "[Freq] Test.zip"
        pitch_zip = temporary / "[Pitch] Test.zip"
        unsupported_zip = temporary / "unsupported.zip"
        make_dictionary(dictionary_zip)
        make_frequency_dictionary(frequency_zip)
        make_term_backed_pitch_dictionary(pitch_zip)
        with zipfile.ZipFile(unsupported_zip, "w") as archive:
            archive.writestr("index.json", json.dumps({"title": "Unsupported Kanji", "format": 3}))

        sidecar = Sidecar(executable, root)
        hello = sidecar.send(1, "hello", {"protocolVersion": 1})["result"]
        assert hello["protocolVersion"] == 1
        assert {"lookup", "import", "frequency", "pitch", "media", "supersession"} <= set(hello["capabilities"])

        state = sidecar.send(2, "state")["result"]
        assert state["available"] is True
        assert state["dictionaries"] == []
        assert state["order"] == {"term": [], "frequency": [], "pitch": []}
        assert state["styles"] == {}

        # Malformed frames return protocol errors without terminating the process.
        sidecar.process.stdin.write("{not-json}\n")
        sidecar.process.stdin.flush()
        malformed = sidecar.response(0, allow_error=True)
        assert malformed["error"]["code"] == "INVALID_REQUEST"

        imported = sidecar.send(3, "import", {"paths": [str(dictionary_zip)]})["result"]
        dictionary = imported["dictionaries"][0]
        assert dictionary["counts"] == {"term": 1, "frequency": 1, "pitch": 1, "media": 1}
        assert imported["order"] == {
            "term": [dictionary["id"]],
            "frequency": [dictionary["id"]],
            "pitch": [dictionary["id"]],
        }
        assert "日本語辞書" in imported["styles"]
        phases = {event["data"]["phase"] for event in sidecar.events if event["event"] == "importProgress"}
        assert {"opening", "importing", "finalizing", "completion"} <= phases

        after_batch = sidecar.send(
            4,
            "import",
            {"paths": [str(unsupported_zip), str(dictionary_zip), str(frequency_zip), str(pitch_zip)]},
        )["result"]
        by_title = {item["title"]: item for item in after_batch["dictionaries"]}
        assert set(by_title) == {"日本語辞書", "Test Frequency", "Test Pitch Guide"}
        assert by_title["Test Frequency"]["counts"] == {"term": 0, "frequency": 1, "pitch": 0, "media": 0}
        assert by_title["Test Pitch Guide"]["counts"] == {"term": 0, "frequency": 0, "pitch": 1, "media": 0}
        import_errors = [event for event in sidecar.events if event["event"] == "importError"]
        assert {event["data"]["fileName"] for event in import_errors} == {
            "unsupported.zip",
            "日本語辞書.zip",
        }
        assert not any((root / ".staging").iterdir())

        # The emoji occupies two UTF-16 units, so the lookup begins at offset 2.
        lookup = sidecar.send(
            5,
            "lookup",
            {"text": "😀食べました", "offset": 2, "scanLength": 16, "maxResults": 8},
        )["result"]
        assert lookup["length"] == 5
        entry = lookup["entries"][0]
        assert entry["expression"] == "食べる"
        assert entry["trace"]
        assert entry["frequencies"][0]["frequencies"][0] == {"value": 42, "displayValue": "42"}
        assert entry["pitches"][0]["pitchPositions"] == [2]

        media = sidecar.send(
            6,
            "media",
            {"dictionary": "日本語辞書", "path": "media/test.png"},
        )["result"]
        assert base64.b64decode(media["data"]) == b"\x89PNG\r\n\x1a\nHayase dictionary media"
        assert media["size"] == 31
        missing_media = sidecar.send(
            7,
            "media",
            {"dictionary": "日本語辞書", "path": "media/missing.png"},
            allow_error=True,
        )
        assert missing_media["error"]["code"] == "MEDIA_NOT_FOUND"

        invalid_offset = sidecar.send(
            8,
            "lookup",
            {"text": "😀食べました", "offset": 1, "scanLength": 16, "maxResults": 8},
            allow_error=True,
        )
        assert invalid_offset["error"]["code"] == "INVALID_OFFSET"

        disabled = sidecar.send(
            9, "setEnabled", {"id": dictionary["id"], "kind": "term", "enabled": False}
        )["result"]
        assert disabled["dictionaries"][0]["enabled"]["term"] is False
        no_results = sidecar.send(
            10,
            "lookup",
            {"text": "食べました", "offset": 0, "scanLength": 16, "maxResults": 8},
        )["result"]
        assert no_results["entries"] == []
        sidecar.send(11, "setEnabled", {"id": dictionary["id"], "kind": "term", "enabled": True})
        sidecar.send(12, "reorder", {"kind": "term", "ids": [dictionary["id"]]})
        sidecar.close(13)

        # Manifest state and query data survive a complete sidecar restart.
        sidecar = Sidecar(executable, root)
        persisted = sidecar.send(14, "state")["result"]
        assert persisted["dictionaries"][0]["title"] == "日本語辞書"
        assert sidecar.send(
            15,
            "lookup",
            {"text": "食べました", "offset": 0, "scanLength": 16, "maxResults": 8},
        )["result"]["entries"]
        sidecar.send(16, "remove", {"id": dictionary["id"]})
        remaining = sidecar.send(17, "state")["result"]["dictionaries"]
        for request_id, item in enumerate(remaining, start=18):
            sidecar.send(request_id, "remove", {"id": item["id"]})
        removed = sidecar.send(22, "state")["result"]
        assert removed["dictionaries"] == []
        assert any((root / ".trash").iterdir())
        sidecar.close(23)

        assert (root / "manifest.json").is_file()
        assert (root / "data").is_dir()
        assert (root / ".staging").is_dir()
        assert (root / ".trash").is_dir()


if __name__ == "__main__":
    main()
