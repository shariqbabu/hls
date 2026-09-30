#!/usr/bin/env python3
"""
Telegram HLS Upload & Zero-Buffer M3U8 Generator
Uploads HLS segments to a Telegram Channel via Telethon MTProto and generates:
- index.m3u8 (with Worker URL streaming & prefetch optimization)
- mapping.json (filename -> Telegram message_id mapping)
"""

import os
import sys
import json
import asyncio
import re
from pathlib import Path
from telethon import TelegramClient, errors
from telethon.sessions import StringSession


def get_env_var(name: str, default: str = None, required: bool = False) -> str:
    val = os.getenv(name, default)
    if required and (val is None or str(val).strip() == ""):
        print(f"❌ Error: Environment variable '{name}' is required but not set.")
        sys.exit(1)
    return str(val).strip() if val is not None else ""


def parse_channel_identifier(channel_str: str):
    """
    Handles @username, public links, or numeric channel IDs (-100...).
    """
    channel_str = channel_str.strip()
    if channel_str.startswith("https://t.me/"):
        channel_str = "@" + channel_str.replace("https://t.me/", "").rstrip("/")
    if channel_str.startswith("-100") or (channel_str.startswith("-") and channel_str[1:].isdigit()):
        return int(channel_str)
    if channel_str.isdigit():
        return int(f"-100{channel_str}")
    return channel_str


def parse_local_m3u8(m3u8_path: Path):
    """
    Parses local.m3u8 to extract exact segment durations and target duration.
    Returns: (target_duration, dict(segment_name -> duration_str))
    """
    target_duration = 7
    segment_durations = {}

    if not m3u8_path.exists():
        return target_duration, segment_durations

    with open(m3u8_path, "r", encoding="utf-8", errors="ignore") as f:
        lines = [line.strip() for line in f if line.strip()]

    current_duration = "6.000000"
    for line in lines:
        if line.startswith("#EXT-X-TARGETDURATION:"):
            try:
                target_duration = int(line.split(":")[1].strip())
            except Exception:
                pass
        elif line.startswith("#EXTINF:"):
            match = re.search(r"#EXTINF:\s*([0-9.]+)", line)
            if match:
                current_duration = match.group(1)
        elif not line.startswith("#") and (line.endswith(".ts") or "segment_" in line):
            seg_name = Path(line).name
            segment_durations[seg_name] = current_duration

    return target_duration, segment_durations


def build_streaming_m3u8(mapping: dict, worker_url: str, target_duration: int, segment_durations: dict, prefetch_count: int = 5) -> str:
    """
    Generates zero-buffer M3U8 with prefetch parameters (next, next2, next3...).
    """
    worker_base = worker_url.strip().rstrip("/")
    if not worker_base.endswith("/api/tg/stream"):
        if worker_base.endswith("/api/tg"):
            worker_base += "/stream"
        elif "/api/tg" not in worker_base:
            worker_base += "/api/tg/stream"

    sorted_fnames = sorted(mapping.keys())
    msg_ids = [str(mapping[fname]["message_id"]) for fname in sorted_fnames]

    playlist = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        f"#EXT-X-TARGETDURATION:{target_duration}"
    ]

    for n in range(len(sorted_fnames)):
        fname = sorted_fnames[n]
        dur = segment_durations.get(fname, "6.000000")

        # Build URL with prefetch parameters
        params = [f"msg={msg_ids[n]}"]
        for offset in range(1, prefetch_count + 1):
            if n + offset < len(msg_ids):
                key = "next" if offset == 1 else f"next{offset}"
                params.append(f"{key}={msg_ids[n + offset]}")

        chunk_url = f"{worker_base}?{'&'.join(params)}"
        playlist.append(f"#EXTINF:{float(dur):.6f},")
        playlist.append(chunk_url)

    playlist.append("#EXT-X-ENDLIST")
    return "\n".join(playlist) + "\n"


async def upload_segments_to_telegram(hls_dir: Path, movie_name: str):
    # Load configuration
    tg_api_id = get_env_var("TG_API_ID", required=True)
    tg_api_hash = get_env_var("TG_API_HASH", required=True)
    tg_session = get_env_var("TG_SESSION", required=True)
    tg_channel = get_env_var("TG_CHANNEL", required=True)
    worker_url = get_env_var("WORKER_URL", required=True)

    concurrency = int(get_env_var("TG_UPLOAD_CONCURRENCY", default="5"))
    upload_timeout = int(get_env_var("TG_UPLOAD_TIMEOUT", default="900"))

    # Discover segment files
    segments = sorted(
        [f for f in hls_dir.glob("segment_*.ts") if f.is_file()],
        key=lambda x: x.name
    )

    if not segments:
        print(f"❌ Error: No HLS segment files (segment_*.ts) found in {hls_dir}")
        sys.exit(1)

    total_segments = len(segments)
    total_size_mb = sum(s.stat().st_size for s in segments) / (1024 * 1024)
    print(f"📁 Found {total_segments} HLS segments ({total_size_mb:.2f} MB) in {hls_dir}")
    print(f"🚀 Starting MTProto upload (Concurrency: {concurrency}, Target Channel: {tg_channel})...")

    # Initialize Telethon Client
    channel_target = parse_channel_identifier(tg_channel)
    client = TelegramClient(StringSession(tg_session), int(tg_api_id), tg_api_hash)

    await client.connect()
    if not await client.is_user_authorized():
        print("❌ Error: Telegram session is not authorized! Check TG_SESSION secret.")
        sys.exit(1)

    me = await client.get_me()
    print(f"✅ Connected as: {me.first_name} (ID: {me.id})")

    try:
        entity = await client.get_input_entity(channel_target)
    except Exception as e:
        print(f"❌ Error finding channel '{tg_channel}': {e}")
        sys.exit(1)

    # Resume capability if mapping.json already exists
    mapping_file = hls_dir / "mapping.json"
    mapping = {}
    if mapping_file.exists():
        try:
            with open(mapping_file, "r", encoding="utf-8") as f:
                mapping = json.load(f)
            print(f"🔄 Found existing mapping for {len(mapping)} segments.")
        except Exception:
            mapping = {}

    pending_segments = [s for s in segments if s.name not in mapping]
    print(f"📦 Segments to upload: {len(pending_segments)} / {total_segments}")

    semaphore = asyncio.Semaphore(concurrency)
    completed_count = len(mapping)
    lock = asyncio.Lock()

    async def upload_single(seg_path: Path):
        nonlocal completed_count
        fname = seg_path.name
        caption_text = f"{movie_name} - {fname}" if movie_name else fname

        for attempt in range(1, 4):
            try:
                async with semaphore:
                    msg = await asyncio.wait_for(
                        client.send_file(
                            entity,
                            file=str(seg_path),
                            caption=caption_text,
                            force_document=True
                        ),
                        timeout=upload_timeout
                    )
                    async with lock:
                        mapping[fname] = {
                            "filename": fname,
                            "message_id": msg.id,
                            "size_bytes": seg_path.stat().st_size
                        }
                        completed_count += 1
                        pct = (completed_count / total_segments) * 100
                        print(f"⚡ [{completed_count}/{total_segments}] ({pct:.1f}%) Uploaded {fname} ➔ Msg ID: {msg.id}")
                    return
            except errors.FloodWaitError as e:
                print(f"⏳ FloodWait: Sleeping for {e.seconds} seconds on {fname}...")
                await asyncio.sleep(e.seconds + 1)
            except Exception as e:
                print(f"⚠️ Attempt {attempt}/3 failed for {fname}: {e}")
                if attempt < 3:
                    await asyncio.sleep(2 * attempt)
                else:
                    print(f"❌ Failed to upload {fname} after 3 attempts.")
                    raise

    # Batch gather to prevent overwhelming task queues
    batch_size = 10
    tasks = [upload_single(s) for s in pending_segments]
    for i in range(0, len(tasks), batch_size):
        batch = tasks[i:i + batch_size]
        await asyncio.gather(*batch)

    print("\n🎉 All segments uploaded successfully!")

    # Parse local.m3u8 for accurate EXTINF durations
    local_m3u8_file = hls_dir / "local.m3u8"
    target_dur, segment_durs = parse_local_m3u8(local_m3u8_file)

    # Save mapping.json and segment_mapping.json
    with open(mapping_file, "w", encoding="utf-8") as f:
        json.dump(mapping, f, indent=2)

    with open(hls_dir / "segment_mapping.json", "w", encoding="utf-8") as f:
        json.dump(mapping, f, indent=2)

    # Generate and save index.m3u8
    m3u8_content = build_streaming_m3u8(
        mapping=mapping,
        worker_url=worker_url,
        target_duration=target_dur,
        segment_durations=segment_durs,
        prefetch_count=5
    )

    index_m3u8_file = hls_dir / "index.m3u8"
    index_m3u8_file.write_text(m3u8_content, encoding="utf-8")
    (hls_dir / "index_worker.m3u8").write_text(m3u8_content, encoding="utf-8")

    print("📄 Generated Outputs:")
    print(f" - {index_m3u8_file.resolve()}")
    print(f" - {mapping_file.resolve()}")

    await client.disconnect()


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 process.py <hls_directory> [movie_name]")
        sys.exit(1)

    hls_dir = Path(sys.argv[1]).resolve()
    movie_name = sys.argv[2] if len(sys.argv) > 2 else ""

    if not hls_dir.exists() or not hls_dir.is_dir():
        print(f"❌ Error: Directory '{hls_dir}' does not exist.")
        sys.exit(1)

    asyncio.run(upload_segments_to_telegram(hls_dir, movie_name))


if __name__ == "__main__":
    main()
