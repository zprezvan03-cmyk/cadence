#!/usr/bin/env python3
"""Generate the audio fixtures used by Cadence's tests.

Every supported format is produced with a real encoder (PyAV/libsndfile) and tagged with
Mutagen, including embedded artwork and embedded USLT lyrics, so the library scanner and the
browser harness can verify decoding, metadata, artwork and lyric extraction against genuine
files instead of committed binaries.

Requires: pip install av soundfile numpy mutagen
Output:   .artifacts/fixtures/formats/<format>/<file>
"""

from __future__ import annotations

import base64
import math
import struct
import sys
import wave
import zlib
from pathlib import Path

import numpy as np
import soundfile as sf
import av

try:
    from mutagen.flac import FLAC, Picture
    from mutagen.id3 import APIC, ID3, TALB, TIT2, TPE1, TRCK, TYER, USLT
    from mutagen.mp4 import MP4, MP4Cover
    from mutagen.oggopus import OggOpus
    from mutagen.oggvorbis import OggVorbis
except ImportError:  # pragma: no cover
    print("mutagen is required: pip install mutagen", file=sys.stderr)
    raise

ROOT = Path(__file__).resolve().parents[2] / ".artifacts" / "fixtures" / "formats"
SAMPLE_RATE = 44100
SECONDS = 6.0
LRC = """[ti:Cadence Fixture]
[ar:Harness Artist]
[al:Test Bench]
[length:00:06]
[00:00.50]Fixture first line
[00:02.00]Second line of the fixture
[00:04.00]Closing line
"""


def tone() -> np.ndarray:
    """Stereo tone with a 2 Hz amplitude envelope so beat analysis has real transients."""
    frames = int(SAMPLE_RATE * SECONDS)
    t = np.arange(frames) / SAMPLE_RATE
    envelope = 0.35 + 0.65 * np.abs(np.sin(2 * math.pi * 1.0 * t))
    left = 0.30 * np.sin(2 * math.pi * 330 * t) * envelope
    right = 0.30 * np.sin(2 * math.pi * 440 * t) * envelope
    return np.stack([left, right], axis=1).astype(np.float32)


def cover_png(size: int = 256) -> bytes:
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            r = 30 + int(180 * x / size)
            g = 20 + int(90 * y / size)
            b = 120 + int(110 * math.sin((x + y) / 40) ** 2)
            row += bytes((r, g, b))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + kind
            + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def encode_with_pyav(
    path: Path, codec: str, container: str, bitrate: int | None = None, rate: int = SAMPLE_RATE
) -> None:
    data = tone()
    if rate != SAMPLE_RATE:
        # Linear interpolation resample; adequate for a fixture tone.
        source = np.arange(data.shape[0])
        target = np.linspace(0, data.shape[0] - 1, int(data.shape[0] * rate / SAMPLE_RATE))
        data = np.stack([np.interp(target, source, data[:, channel]) for channel in range(2)], axis=1).astype(
            np.float32
        )
    with av.open(str(path), mode="w", format=container) as output:
        stream = output.add_stream(codec, rate=rate)
        stream.layout = "stereo"
        if bitrate and codec in {"libmp3lame", "aac", "libvorbis", "libopus"}:
            stream.bit_rate = bitrate
        chunk = 1024
        for start in range(0, len(data), chunk):
            block = data[start : start + chunk]
            interleaved = (np.clip(block, -1, 1) * 32767).astype(np.int16).reshape(1, -1)
            frame = av.AudioFrame.from_ndarray(interleaved, format="s16", layout="stereo")
            frame.sample_rate = rate
            frame.pts = start
            for packet in stream.encode(frame):
                output.mux(packet)
        for packet in stream.encode(None):
            output.mux(packet)


def tag_mp3(path: Path, cover: bytes) -> None:
    audio = MP3File = ID3()
    audio.add(TIT2(encoding=3, text="Fixture MP3"))
    audio.add(TPE1(encoding=3, text="Harness Artist"))
    audio.add(TALB(encoding=3, text="Test Bench"))
    audio.add(TRCK(encoding=3, text="1/7"))
    audio.add(TYER(encoding=3, text="2024"))
    audio.add(APIC(encoding=3, mime="image/png", type=3, desc="Cover", data=cover))
    audio.add(USLT(encoding=3, lang="eng", desc="", text=LRC))
    audio.save(str(path), v2_version=3)


def tag_mp4(path: Path, cover: bytes, title: str) -> None:
    audio = MP4(str(path))
    audio["\xa9nam"] = [title]
    audio["\xa9ART"] = ["Harness Artist"]
    audio["\xa9alb"] = ["Test Bench"]
    audio["trkn"] = [(1, 7)]
    audio["\xa9day"] = ["2024"]
    audio["covr"] = [MP4Cover(cover, imageformat=MP4Cover.FORMAT_PNG)]
    audio["\xa9lyr"] = [LRC]
    audio.save()


def tag_flac(path: Path, cover: bytes) -> None:
    audio = FLAC(str(path))
    audio["title"] = "Fixture FLAC"
    audio["artist"] = "Harness Artist"
    audio["album"] = "Test Bench"
    audio["tracknumber"] = "2"
    audio["date"] = "2024"
    audio["lyrics"] = LRC
    picture = Picture()
    picture.type = 3
    picture.mime = "image/png"
    picture.desc = "Cover"
    picture.data = cover
    audio.add_picture(picture)
    audio.save()


def tag_ogg(path: Path, cover: bytes, title: str) -> None:
    audio = OggVorbis(str(path)) if path.suffix == ".ogg" else OggOpus(str(path))
    audio["title"] = title
    audio["artist"] = "Harness Artist"
    audio["album"] = "Test Bench"
    audio["tracknumber"] = "3"
    audio["date"] = "2024"
    audio["lyrics"] = LRC
    picture = Picture()
    picture.type = 3
    picture.mime = "image/png"
    picture.desc = "Cover"
    picture.width = 256
    picture.height = 256
    picture.depth = 24
    picture.data = cover
    audio["metadata_block_picture"] = [base64.b64encode(picture.write()).decode("ascii")]
    audio.save()


def main() -> int:
    ROOT.mkdir(parents=True, exist_ok=True)
    cover = cover_png()
    data = tone()
    created: list[str] = []

    # WAV (libsndfile)
    wav = ROOT / "fixture.wav"
    sf.write(str(wav), data, SAMPLE_RATE, subtype="PCM_16", format="WAV")
    created.append(str(wav))
    # Sidecar LRC + a cover file next to the audio, which the scanner must ignore.
    (ROOT / "fixture.lrc").write_text(LRC, encoding="utf-8")
    (ROOT / "cover.png").write_bytes(cover)

    # FLAC (libsndfile)
    flac_path = ROOT / "fixture.flac"
    sf.write(str(flac_path), data, SAMPLE_RATE, subtype="PCM_16", format="FLAC")
    tag_flac(flac_path, cover)
    created.append(str(flac_path))

    # Ogg Vorbis + Opus (libsndfile)
    ogg = ROOT / "fixture.ogg"
    sf.write(str(ogg), data, SAMPLE_RATE, subtype="VORBIS", format="OGG")
    tag_ogg(ogg, cover, "Fixture Ogg Vorbis")
    created.append(str(ogg))

    opus = ROOT / "fixture.opus"
    # Opus only accepts 48/24/16/8/12 kHz; resample the fixture with PyAV on the way in.
    encode_with_pyav(opus, "libopus", "opus", 128_000, rate=48_000)
    tag_ogg(opus, cover, "Fixture Opus")
    created.append(str(opus))

    # MP3, AAC/M4A, ALAC (PyAV)
    mp3 = ROOT / "fixture.mp3"
    encode_with_pyav(mp3, "libmp3lame", "mp3", 192_000)
    tag_mp3(mp3, cover)
    created.append(str(mp3))

    aac = ROOT / "fixture-aac.m4a"
    encode_with_pyav(aac, "aac", "mp4", 160_000)
    tag_mp4(aac, cover, "Fixture AAC")
    created.append(str(aac))

    alac = ROOT / "fixture-alac.m4a"
    encode_with_pyav(alac, "alac", "mp4")
    tag_mp4(alac, cover, "Fixture ALAC")
    created.append(str(alac))

    # Deliberately broken inputs for failure handling.
    (ROOT / "broken.flac").write_bytes(b"not a flac file at all" * 8)
    (ROOT / "notes.txt").write_text("ignored", encoding="utf-8")
    created.append(str(ROOT / "broken.flac"))

    for path in created:
        size = Path(path).stat().st_size
        print(f"{Path(path).name:20s} {size:>8d} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
