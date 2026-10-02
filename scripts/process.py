#!/usr/bin/env python3
"""
⚡ Extreme Speed Telegram HLS Pipeline
- Multi-Client MTProto Connection Pool (5 dedicated TCP sockets to Telegram DC)
- Fast Multipart 512KB Parallel Part Uploader
- Zero single-socket bandwidth throttling
- Real-time Speed & Progress Tracker (MB/s)
- Automatic cleanup and error handling
"""

import os
import sys
import json
import asyncio
import time
import re
import hashlib
import random
from pathlib import Path
from telethon import TelegramClient, errors
from telethon.sessions import StringSession
from telethon.tl.types import InputFile, InputFileBig, DocumentAttributeFilename
from telethon.tl.functions.upload import SaveBigFilePartRequest, SaveFilePartRequest


def get_env_var(name: str, default: str = None, required: bool = False) -> str:
    val = os.getenv(name, default)
    if required and (val is None or str(val).strip() == ""):
        print(f"❌ Error: Environment variable '{name}' is required but not set.")
        sys.exit(1)
    return str(val).strip() if val is not None else ""


def sanitize_session_string(session_str: str) -> str:
    if not session_str:
        return ""
    s = session_str.strip().strip("'\"").strip()
    s = "".join(s.split())

    if len(s) > 1 and s[0] == "1":
        payload = s[1:]
        missing_padding = len(payload) % 4
        if missing_padding:
            payload += "=" * (4 - missing_padding)
        return "1" + payload

    return s


def parse_channel_identifier(channel_str: str):
    channel_str = channel_str.strip()
    if channel_str.startswith("https://t.me/"):
        channel_str = "@" + channel_str.replace("https://t.me/", "").rstrip("/")
    if channel_str.startswith("-100") or (channel_str.startswith("-") and channel_str[1:].isdigit()):
        return int(channel_str)
    if channel_str.isdigit():
        return int(f"-100{channel_str}")
    return channel_str


def parse_local_m3u8(m3u8_path: Path):
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


async def fast_upload_file(client: TelegramClient, file_path: Path):
    file_size = file_path.stat().st_size
    if file_size == 0:
        raise ValueError(f"File {file_path} is empty")

    file_id = random.randint(0, 0x7FFFFFFFFFFFFFFF)
    is_big = file_size > 10 * 1024 * 1024
    part_size = 512 * 1024  # 512 KB
    part_count = (file_size + part_size - 1) // part_size

    with open(file_path, "rb") as f:
        file_bytes = f.read()

    md5_hash = hashlib.md5(file_bytes).hexdigest()
    parts = []
    for i in range(part_count):
        start = i * part_size
        end = min(start + part_size, file_size)
        parts.append((i, file_bytes[start:end]))

    async def upload_part(idx: int, data: bytes):
        if is_big:
            await client(SaveBigFilePartRequest(
                file_id=file_id,
                file_part=idx,
                file_total_parts=part_count,
                bytes=data
            ))
        else:
            await client(SaveFilePartRequest(
                file_id=file_id,
                file_part=idx,
                bytes=data
            ))

    await asyncio.gather(*(upload_part(idx, data) for idx, data in parts))

    if is_big:
        return InputFileBig(id=file_id, parts=part_count, name=file_path.name)
    else:
        return InputFile(id=file_id, parts=part_count, name=file_path.name, md5_checksum=md5_hash)


async def upload_segments_to_telegram(hls_dir: Path, movie_name: str):
    tg_api_id = get_env_var("TG_API_ID", required=True)
    tg_api_hash = get_env_var("TG_API_HASH", required=True)
    raw_session = get_env_var("TG_SESSION", default="")
    tg_bot_token = get_env_var("TG_BOT_TOKEN", default="")
    tg_channel = get_env_var("TG_CHANNEL", required=True)
    raw_worker_url = get_env_var("WORKER_URL", default="https://live.betadda.workers.dev/api/tg/stream")
    worker_url = "https://live.betadda.workers.dev/api/tg/stream" if (not raw_worker_url or "***" in raw_worker_url) else raw_worker_url

    tg_session = sanitize_session_string(raw_session)

    if not tg_bot_token and not tg_session:
        print("❌ Error: 'TG_SESSION' secret is missing.")
        sys.exit(1)

    # Number of parallel TCP socket connections
    num_clients = 5
    concurrency = int(get_env_var("TG_UPLOAD_CONCURRENCY", default="8"))
    upload_timeout = int(get_env_var("TG_UPLOAD_TIMEOUT", default="900"))

    segments = sorted(
        [f for f in hls_dir.glob("segment_*.ts") if f.is_file()],
        key=lambda x: x.name
    )

    if not segments:
        print(f"❌ Error: No HLS segment files (segment_*.ts) found in {hls_dir}")
        sys.exit(1)

    total_segments = len(segments)
    total_bytes = sum(s.stat().st_size for s in segments)
    total_size_mb = total_bytes / (1024 * 1024)

    print("=" * 60)
    print("⚡ MULTI-SOCKET HIGH-SPEED TELEGRAM HLS PIPELINE")
    print(f"📁 Total Chunks : {total_segments} ({total_size_mb:.2f} MB)")
    print(f"🔌 TCP Sockets  : {num_clients} Dedicated MTProto Connections")
    print(f"🚀 Workers      : {concurrency} Parallel File Streams")
    print(f"🎯 Target       : {tg_channel}")
    print("=" * 60)

    channel_target = parse_channel_identifier(tg_channel)

    # Create Multi-Client TCP Socket Pool
    print(f"🔌 Opening {num_clients} independent MTProto connections to Telegram...")
    clients = [
        TelegramClient(
            StringSession(tg_session) if tg_session else StringSession(),
            int(tg_api_id),
            tg_api_hash,
            flood_sleep_threshold=120,
            request_retries=10,
            connection_retries=10
        )
        for _ in range(num_clients)
    ]

    try:
        if tg_bot_token:
            await asyncio.gather(*(c.start(bot_token=tg_bot_token) for c in clients))
        else:
            await asyncio.gather(*(c.connect() for c in clients))
            for c in clients:
                if not await c.is_user_authorized():
                    print("❌ Error: Telegram StringSession is not authorized!")
                    sys.exit(1)
    except Exception as e:
        print(f"❌ Failed to connect connection pool: {e}")
        sys.exit(1)

    try:
        primary_client = clients[0]
        me = await primary_client.get_me()
        user_type = "Bot" if getattr(me, "bot", False) else "User"
        print(f"✅ Connected as {user_type}: {me.first_name} (@{me.username or 'NoUsername'}) [ID: {me.id}]")

        # Resolve entity for all clients
        entities = await asyncio.gather(*(c.get_input_entity(channel_target) for c in clients))

        mapping_file = hls_dir / "mapping.json"
        mapping = {}
        if mapping_file.exists():
            try:
                with open(mapping_file, "r", encoding="utf-8") as f:
                    mapping = json.load(f)
                print(f"🔄 Resuming: {len(mapping)} / {total_segments} already mapped.")
            except Exception:
                mapping = {}

        pending_segments = [s for s in segments if s.name not in mapping]
        pending_bytes = sum(s.stat().st_size for s in pending_segments)
        print(f"📦 Remaining to upload: {len(pending_segments)} chunks ({(pending_bytes / (1024 * 1024)):.2f} MB)\n")

        queue = asyncio.Queue()
        for seg in pending_segments:
            queue.put_nowait(seg)

        completed_count = len(mapping)
        uploaded_bytes = total_bytes - pending_bytes
        start_time = time.time()
        lock = asyncio.Lock()
        fatal_error_event = asyncio.Event()

        async def worker(worker_id: int):
            nonlocal completed_count, uploaded_bytes
            client = clients[worker_id % num_clients]
            entity = entities[worker_id % num_clients]

            while not queue.empty() and not fatal_error_event.is_set():
                try:
                    seg_path: Path = await queue.get()
                except asyncio.QueueEmpty:
                    break

                fname = seg_path.name
                fsize = seg_path.stat().st_size
                fsize_mb = fsize / (1024 * 1024)
                caption_text = f"{movie_name} - {fname}" if movie_name else fname

                for attempt in range(1, 4):
                    if fatal_error_event.is_set():
                        queue.task_done()
                        return

                    try:
                        if not client.is_connected():
                            await client.connect()

                        # Step 1: Upload multipart to Telegram DC via dedicated socket
                        input_file = await asyncio.wait_for(
                            fast_upload_file(client, seg_path),
                            timeout=upload_timeout
                        )

                        # Step 2: Instant message sending with pre-uploaded handle
                        msg = await asyncio.wait_for(
                            client.send_file(
                                entity,
                                file=input_file,
                                caption=caption_text,
                                force_document=True,
                                attributes=[DocumentAttributeFilename(fname)],
                                mime_type="video/mp2t"
                            ),
                            timeout=60
                        )

                        async with lock:
                            mapping[fname] = {
                                "filename": fname,
                                "message_id": msg.id,
                                "size_bytes": fsize
                            }
                            completed_count += 1
                            uploaded_bytes += fsize

                            elapsed = max(time.time() - start_time, 0.1)
                            speed_mb = (uploaded_bytes - (total_bytes - pending_bytes)) / (1024 * 1024) / elapsed
                            pct = (completed_count / total_segments) * 100

                            print(
                                f"⚡ [{completed_count:4d}/{total_segments}] ({pct:5.1f}%) "
                                f"➔ {fname} ({fsize_mb:.2f} MB) | "
                                f"Speed: {speed_mb:5.1f} MB/s | "
                                f"Msg ID: {msg.id}"
                            )
                        queue.task_done()
                        break

                    except (errors.AuthKeyDuplicatedError, errors.AuthKeyUnregisteredError) as e:
                        print(f"\n❌ [Worker {worker_id}] CRITICAL AUTH ERROR: Session revoked.")
                        fatal_error_event.set()
                        queue.task_done()
                        raise RuntimeError("Invalid Telegram session") from e

                    except (ConnectionError, errors.DisconnectedError) as e:
                        print(f"⚠️ [Worker {worker_id}] Connection reset on {fname}: {e}. Reconnecting...")
                        try:
                            if client.is_connected():
                                await client.disconnect()
                            await client.connect()
                        except Exception:
                            pass
                        if attempt < 3:
                            await asyncio.sleep(1.5 * attempt)
                        else:
                            queue.task_done()
                            raise

                    except errors.FloodWaitError as e:
                        print(f"⏳ [Worker {worker_id}] FloodWait: Sleeping {e.seconds}s on {fname}...")
                        await asyncio.sleep(e.seconds + 1)

                    except Exception as e:
                        print(f"⚠️ [Worker {worker_id}] Attempt {attempt}/3 on {fname} error: {e}")
                        if attempt < 3:
                            await asyncio.sleep(1.5 * attempt)
                        else:
                            queue.task_done()
                            print(f"❌ Failed to upload {fname} after 3 attempts.")
                            raise

        num_workers = min(concurrency, len(pending_segments)) if pending_segments else 1
        worker_tasks = [asyncio.create_task(worker(i)) for i in range(num_workers)]

        try:
            await asyncio.gather(*worker_tasks)
        except Exception as e:
            for t in worker_tasks:
                if not t.done():
                    t.cancel()
            raise e

        total_elapsed = max(time.time() - start_time, 0.1)
        avg_speed = (pending_bytes / (1024 * 1024)) / total_elapsed if pending_bytes > 0 else 0
        print("\n" + "=" * 60)
        print(f"🎉 ALL {total_segments} SEGMENTS UPLOADED!")
        print(f"⏱️ Total Time: {total_elapsed:.1f}s | Avg Speed: {avg_speed:.2f} MB/s")
        print("=" * 60)

        # Parse local.m3u8 for exact EXTINF durations
        local_m3u8_file = hls_dir / "local.m3u8"
        target_dur, segment_durs = parse_local_m3u8(local_m3u8_file)

        # Save mapping.json and segment_mapping.json
        with open(mapping_file, "w", encoding="utf-8") as f:
            json.dump(mapping, f, indent=2)

        with open(hls_dir / "segment_mapping.json", "w", encoding="utf-8") as f:
            json.dump(mapping, f, indent=2)

        # Generate zero-buffer index.m3u8
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

    finally:
        for c in clients:
            if c.is_connected():
                await c.disconnect()


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
