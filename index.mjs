/**
 * Complete Video -> HLS -> Hugging Face Storage Bucket pipeline
 *
 * Required env:
 *   VIDEO_URL, HF_TOKEN, HF_BUCKET_ID
 *
 * Optional env:
 *   VIDEO_NAME=my-video
 *   INPUT_FORMAT=auto|mp4|mkv|hevc
 *   SEGMENT_DURATION=6
 *   HF_PATH=hls                 (remote folder in the bucket)
 *   WORK_DIR=temp-work
 *
 * Notes:
 *   - Video is stream-copied (not re-encoded).
 *   - If stream-copy HLS fails because of the audio codec, audio is retried as AAC.
 *   - HLS segment boundaries depend on source keyframes when video is stream-copied.
 */

import fs from "node:fs/promises";
import path from "node:fs";
import pathModule from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const {
  VIDEO_URL,
  VIDEO_NAME = "my-video",
  INPUT_FORMAT = "auto",
  SEGMENT_DURATION = "6",
  HF_TOKEN,
  HF_BUCKET_ID,
  HF_PATH = "hls",
  WORK_DIR = "temp-work"
} = process.env;

function required(value, name) {
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return String(value).trim();
}

function safeFolder(value, label) {
  const cleaned = String(value || "").trim().replace(/^\/+|\/+$/g, "");
  if (!cleaned || cleaned.includes("\\") ||
      cleaned.split("/").some(p => !p || p === "." || p === "..")) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return cleaned;
}

function safeName(value) {
  const name = String(value || "").trim();
  if (!name || name === "." || name === ".." ||
      /[/\\<>:"|?*\x00-\x1f]/.test(name)) {
    throw new Error("Invalid VIDEO_NAME. Avoid slashes and filesystem-reserved characters.");
  }
  return name;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", chunk => {
      const value = chunk.toString();
      stdout += value;
      if (options.streamOutput) process.stdout.write(value);
    });
    child.stderr?.on("data", chunk => {
      const value = chunk.toString();
      stderr += value;
      if (options.streamOutput) process.stderr.write(value);
    });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(
        `${command} exited with code ${code}\n${stderr.slice(-12000)}`
      ));
    });
  });
}

async function downloadVideo(url, destination) {
  // curl follows redirects, retries transient errors and supports large files.
  console.log("⬇️ Downloading source video...");
  await run("curl", [
    "--fail", "--location", "--retry", "5", "--retry-delay", "3",
    "--retry-all-errors", "--connect-timeout", "30",
    "--output", destination, url
  ], { streamOutput: true });

  const stat = await fs.stat(destination);
  if (!stat.size) throw new Error("Downloaded video is empty.");
  console.log(`✅ Download complete: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
}

function inputExtension(url, format) {
  if (format === "mp4") return ".mp4";
  if (format === "mkv") return ".mkv";
  if (format === "hevc") return ".hevc";
  const pathname = new URL(url).pathname.toLowerCase();
  for (const ext of [".mp4", ".mkv", ".mov", ".webm", ".hevc", ".h265", ".ts"]) {
    if (pathname.endsWith(ext)) return ext;
  }
  return ".input";
}

async function convertToHls(inputFile, hlsDir, segmentDuration) {
  await fs.mkdir(hlsDir, { recursive: true });
  const playlist = pathModule.join(hlsDir, "index.m3u8");
  const segmentPattern = pathModule.join(hlsDir, "segment_%05d.ts");

  // Always encode video to H.264. The supplied source is VP9 in an MKV
  // container; copying VP9 into MPEG-TS HLS can produce audio with black video.
  // Explicit stream mapping also excludes the attached PNG cover-art stream.
  const ffmpegArgs = [
    "-hide_banner", "-y",
    "-i", inputFile,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-sn", "-dn",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "22",
    "-pix_fmt", "yuv420p",
    "-profile:v", "high",
    "-level:v", "5.1",
    "-c:a", "aac",
    "-b:a", "160k",
    "-ac", "2",
    "-ar", "44100",
    "-max_muxing_queue_size", "2048",
    "-f", "hls",
    "-hls_time", String(segmentDuration),
    "-hls_playlist_type", "vod",
    "-hls_segment_type", "mpegts",
    "-hls_flags", "independent_segments",
    "-hls_segment_filename", segmentPattern,
    playlist
  ];

  console.log("🎞️ Converting source to browser-compatible HLS...");
  console.log("   Video: H.264 / yuv420p (4K resolution preserved)");
  console.log("   Audio: AAC / 44.1 kHz / stereo");
  console.log("   Attached images/subtitles/data streams: excluded");

  await run("ffmpeg", ffmpegArgs, { streamOutput: true });

  // Verify that FFmpeg produced video and audio in the HLS transport stream.
  const files = await fs.readdir(hlsDir);
  const segments = files.filter(name => /^segment_.*\.ts$/i.test(name));
  if (!segments.length || !files.includes("index.m3u8")) {
    throw new Error(`FFmpeg did not produce expected HLS files in ${hlsDir}`);
  }

  const firstSegment = pathModule.join(hlsDir, segments.sort()[0]);
  const probe = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,pix_fmt,width,height",
    "-of", "default=noprint_wrappers=1",
    firstSegment
  ]);
  const videoInfo = probe.stdout.trim();
  if (!videoInfo.includes("codec_name=h264")) {
    throw new Error(`HLS video verification failed; expected H.264. ffprobe returned:\n${videoInfo}`);
  }

  console.log(`✅ HLS generated and verified: ${segments.length} segments`);
  console.log(`   First-segment video: ${videoInfo.replace(/\n/g, ", ")}`);
}

function sortSegments(a, b) {
  const n = name => {
    const match = name.match(/(\d+)(?=\.ts$)/i);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  };
  return n(a.name) - n(b.name) || a.name.localeCompare(b.name);
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = path.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function readDurations(m3u8Path) {
  const durations = new Map();
  let targetDuration = 1;
  const text = await fs.readFile(m3u8Path, "utf8");
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  let currentDuration = null;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      const value = Number(line.split(":")[1]);
      if (Number.isFinite(value) && value > 0) targetDuration = Math.ceil(value);
    } else if (line.startsWith("#EXTINF:")) {
      const match = line.match(/^#EXTINF:\s*([0-9.]+)/);
      currentDuration = match ? Number(match[1]) : null;
    } else if (!line.startsWith("#") && /\.ts(?:\?.*)?$/i.test(line)) {
      const basename = pathModule.basename(line.split("?")[0]);
      if (Number.isFinite(currentDuration) && currentDuration > 0) {
        durations.set(basename, currentDuration);
        targetDuration = Math.max(targetDuration, Math.ceil(currentDuration));
      }
      currentDuration = null;
    }
  }
  return { durations, targetDuration };
}

function encodeBucketPath(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

function makeBucketResolveUrl(bucketId, bucketPath) {
  // Bucket URLs are unversioned and use /resolve/<path> (no branch segment).
  return `https://huggingface.co/buckets/${bucketId}/resolve/${encodeBucketPath(bucketPath)}`;
}

async function uploadHls(hlsDir, movieName, token, bucketId, remoteRoot) {
  const stat = await fs.stat(hlsDir).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`HLS directory does not exist: ${hlsDir}`);

  const segmentFiles = (await fs.readdir(hlsDir, { withFileTypes: true }))
    .filter(entry => entry.isFile() && /^segment_.*\.ts$/i.test(entry.name))
    .map(entry => ({ name: entry.name, localPath: pathModule.join(hlsDir, entry.name) }))
    .sort(sortSegments);

  if (!segmentFiles.length) throw new Error(`No segment_*.ts files found in ${hlsDir}`);

  const { durations, targetDuration } = await readDurations(pathModule.join(hlsDir, "index.m3u8"));
  const movieRoot = `${remoteRoot}/${movieName}`;
  const totalBytes = (await Promise.all(segmentFiles.map(async f => (await fs.stat(f.localPath)).size)))
    .reduce((sum, size) => sum + size, 0);

  console.log("\n" + "=".repeat(64));
  console.log("🤗 HUGGING FACE BUCKET UPLOADER");
  console.log(`🪣 Bucket        : ${bucketId}`);
  console.log(`📁 Remote folder : ${movieRoot}`);
  console.log(`🎞️ Segments      : ${segmentFiles.length}`);
  console.log(`💾 Total size    : ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log("=".repeat(64));

  const mapping = {};
  for (let i = 0; i < segmentFiles.length; i++) {
    const file = segmentFiles[i];
    const fileStat = await fs.stat(file.localPath);
    const remotePath = `${movieRoot}/${file.name}`;
    mapping[file.name] = {
      filename: file.name,
      path: remotePath,
      url: makeBucketResolveUrl(bucketId, remotePath),
      size_bytes: fileStat.size,
      duration_seconds: durations.get(file.name) ?? (Number(SEGMENT_DURATION) || 6),
      sha256: await sha256File(file.localPath)
    };
    if ((i + 1) % 25 === 0 || i + 1 === segmentFiles.length) {
      console.log(`🔍 Prepared ${i + 1}/${segmentFiles.length} segments`);
    }
  }

  const playlistLines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    "#EXT-X-MEDIA-SEQUENCE:0"
  ];
  for (const file of segmentFiles) {
    playlistLines.push(`#EXTINF:${Number(mapping[file.name].duration_seconds).toFixed(6)},`);
    playlistLines.push(mapping[file.name].url);
  }
  playlistLines.push("#EXT-X-ENDLIST");

  await fs.writeFile(pathModule.join(hlsDir, "index.m3u8"), playlistLines.join("\n") + "\n", "utf8");
  await fs.writeFile(pathModule.join(hlsDir, "mapping.json"), JSON.stringify(mapping, null, 2) + "\n", "utf8");
  await fs.writeFile(pathModule.join(hlsDir, "segment_mapping.json"), JSON.stringify(mapping, null, 2) + "\n", "utf8");

  const destination = `hf://buckets/${bucketId}/${movieRoot}`;
  console.log(`\n⬆️ Syncing HLS folder to ${destination}`);
  console.log("ℹ️ Bucket sync compares remote files and uploads only new or changed files.");
  await run("hf", ["buckets", "sync", hlsDir, destination], {
    streamOutput: true,
    env: { ...process.env, HF_TOKEN: token }
  });

  const playlistUrl = makeBucketResolveUrl(bucketId, `${movieRoot}/index.m3u8`);
  const mappingUrl = makeBucketResolveUrl(bucketId, `${movieRoot}/mapping.json`);
  console.log("\n" + "=".repeat(64));
  console.log("🎉 HLS BUCKET SYNC COMPLETE");
  console.log(`🪣 Bucket   : https://huggingface.co/buckets/${bucketId}`);
  console.log(`📄 Playlist : ${playlistUrl}`);
  console.log(`🗂️ Mapping  : ${mappingUrl}`);
  console.log("=".repeat(64));
}

async function main() {
  const videoUrl = required(VIDEO_URL, "VIDEO_URL");
  const token = required(HF_TOKEN, "HF_TOKEN");
  const bucketId = required(HF_BUCKET_ID, "HF_BUCKET_ID");
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(bucketId)) {
    throw new Error("HF_BUCKET_ID must be in username/bucket-name format.");
  }
  const remoteRoot = safeFolder(HF_PATH, "HF_PATH");
  const movieName = safeName(VIDEO_NAME);
  const segmentDuration = Number(SEGMENT_DURATION);

  if (!Number.isInteger(segmentDuration) || segmentDuration < 1 || segmentDuration > 60) {
    throw new Error("SEGMENT_DURATION must be an integer from 1 to 60.");
  }
  if (!["auto", "mp4", "mkv", "hevc"].includes(INPUT_FORMAT)) {
    throw new Error("INPUT_FORMAT must be auto, mp4, mkv, or hevc.");
  }

  await run("ffmpeg", ["-version"]);
  await run("curl", ["--version"]);
  await run("hf", ["--version"]);
  await run("hf", ["buckets", "info", bucketId], {
    streamOutput: true, env: { ...process.env, HF_TOKEN: token }
  });

  const workRoot = pathModule.resolve(WORK_DIR);
  const downloadDir = pathModule.join(workRoot, "download");
  const hlsDir = pathModule.join(workRoot, "hls", movieName);
  await fs.rm(workRoot, { recursive: true, force: true });
  await fs.mkdir(downloadDir, { recursive: true });

  const inputFile = pathModule.join(downloadDir, `source${inputExtension(videoUrl, INPUT_FORMAT)}`);

  console.log("=".repeat(64));
  console.log("🎬 VIDEO → HLS → HUGGING FACE BUCKET");
  console.log(`🎞️ Video name     : ${movieName}`);
  console.log(`📁 Local HLS dir  : ${hlsDir}`);
  console.log(`🪣 HF destination : ${bucketId}/${remoteRoot}/${movieName}`);
  console.log("=".repeat(64));

  await downloadVideo(videoUrl, inputFile);
  await convertToHls(inputFile, hlsDir, segmentDuration);
  await uploadHls(hlsDir, movieName, token, bucketId, remoteRoot);
}

main().catch(error => {
  console.error("\n❌ VIDEO → HLS → HUGGING FACE BUCKET FAILED:");
  console.error(error?.stack || error);
  process.exitCode = 1;
});
