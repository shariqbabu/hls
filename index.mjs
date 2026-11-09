/**
 * Complete Video -> HLS -> Hugging Face Dataset pipeline
 *
 * Required env:
 *   VIDEO_URL, HF_TOKEN, HF_REPO_ID
 *
 * Optional env:
 *   VIDEO_NAME=my-video
 *   INPUT_FORMAT=auto|mp4|mkv|hevc
 *   SEGMENT_DURATION=6
 *   HF_PATH=hls                 (remote folder in the dataset)
 *   HF_BATCH_SIZE=40
 *   HF_BRANCH=main
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
import os from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import crypto from "node:crypto";
import { downloadFile, uploadFiles } from "@huggingface/hub";

const {
  VIDEO_URL,
  VIDEO_NAME = "my-video",
  INPUT_FORMAT = "auto",
  SEGMENT_DURATION = "6",
  HF_TOKEN,
  HF_REPO_ID,
  HF_REPO_TYPE = "dataset",
  HF_PATH = "hls",
  HF_BATCH_SIZE = "40",
  HF_BRANCH = "main",
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

  const common = [
    "-hide_banner", "-y", "-i", inputFile,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-c:v", "copy",
    "-f", "hls",
    "-hls_time", String(segmentDuration),
    "-hls_playlist_type", "vod",
    "-hls_flags", "independent_segments",
    "-hls_segment_filename", segmentPattern,
    playlist
  ];

  console.log("🎞️ Converting video to HLS (video/audio stream-copy)...");
  try {
    await run("ffmpeg", [...common.slice(0, common.indexOf("-f")), "-c:a", "copy", ...common.slice(common.indexOf("-f"))], {
      streamOutput: true
    });
  } catch (copyError) {
    console.warn("\n⚠️ Audio stream-copy failed. Retrying with AAC audio; video remains stream-copy.");
    await fs.rm(hlsDir, { recursive: true, force: true });
    await fs.mkdir(hlsDir, { recursive: true });
    const fallback = [
      "-hide_banner", "-y", "-i", inputFile,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
      "-f", "hls",
      "-hls_time", String(segmentDuration),
      "-hls_playlist_type", "vod",
      "-hls_flags", "independent_segments",
      "-hls_segment_filename", segmentPattern,
      playlist
    ];
    try {
      await run("ffmpeg", fallback, { streamOutput: true });
    } catch (fallbackError) {
      throw new Error(
        `HLS conversion failed.\nStream-copy attempt:\n${copyError.message}\nAAC-audio fallback:\n${fallbackError.message}`
      );
    }
  }

  const files = await fs.readdir(hlsDir);
  const segments = files.filter(name => /^segment_.*\.ts$/i.test(name));
  if (!segments.length || !files.includes("index.m3u8")) {
    throw new Error(`FFmpeg did not produce expected HLS files in ${hlsDir}`);
  }
  console.log(`✅ HLS generated: ${segments.length} segments`);
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

function encodeRepoPath(repoPath) {
  return repoPath.split("/").map(encodeURIComponent).join("/");
}

function makeResolveUrl(repoId, repoPath, branch) {
  return `https://huggingface.co/datasets/${repoId}/resolve/${encodeURIComponent(branch)}/${encodeRepoPath(repoPath)}`;
}

async function uploadBatch(repo, token, branch, batch, batchNumber, totalBatches, stateLocalPath, stateRemotePath) {
  const files = batch.map(item => ({
    path: item.remotePath,
    content: pathToFileURL(item.localPath)
  }));
  files.push({ path: stateRemotePath, content: pathToFileURL(stateLocalPath) });

  console.log(`\n⬆️ Upload batch ${batchNumber}/${totalBatches} (${batch.length} segments + checkpoint)`);
  await uploadFiles({
    repo,
    accessToken: token,
    branch,
    files,
    commitTitle: `Upload HLS batch ${batchNumber}/${totalBatches}`,
    commitDescription: "HLS segment upload via Node.js"
  });
}

async function uploadHls(hlsDir, movieName, token, repoId, remoteRoot, batchSize, branch) {
  const repo = { type: "dataset", name: repoId };
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
  console.log("🤗 HUGGING FACE HLS UPLOADER");
  console.log(`📦 Dataset       : ${repoId}`);
  console.log(`📁 Remote folder : ${movieRoot}`);
  console.log(`🎞️ Segments      : ${segmentFiles.length}`);
  console.log(`💾 Total size    : ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log("=".repeat(64));

  const startedAt = Date.now();
  const mapping = {};
  const uploadItems = [];
  const stateRemotePath = `${movieRoot}/upload-state.json`;
  const stateLocalPath = pathModule.join(hlsDir, "upload-state.json");
  let remoteState = {};

  try {
    const remoteStateFile = await downloadFile({ repo, path: stateRemotePath, accessToken: token });
    if (remoteStateFile) {
      const parsed = JSON.parse(await remoteStateFile.text());
      remoteState = parsed.segments && typeof parsed.segments === "object" ? parsed.segments : {};
      console.log(`🔄 Resume checkpoint found: ${Object.keys(remoteState).length} segment records.`);
    }
  } catch {
    console.log("ℹ️ No previous upload checkpoint found; starting a new upload.");
  }

  for (let i = 0; i < segmentFiles.length; i++) {
    const file = segmentFiles[i];
    const fileStat = await fs.stat(file.localPath);
    const remotePath = `${movieRoot}/${file.name}`;
    const duration = durations.get(file.name) ?? (Number(SEGMENT_DURATION) || 6);
    const sha256 = await sha256File(file.localPath);
    const url = makeResolveUrl(repoId, remotePath, branch);

    mapping[file.name] = {
      filename: file.name,
      path: remotePath,
      url,
      size_bytes: fileStat.size,
      duration_seconds: duration,
      sha256
    };

    const previous = remoteState[file.name];
    if (previous?.sha256 === sha256 && previous?.size_bytes === fileStat.size) {
      console.log(`⏭️ Already uploaded; skipping ${file.name}`);
    } else {
      uploadItems.push({ localPath: file.localPath, remotePath, size: fileStat.size });
    }
    if ((i + 1) % 25 === 0 || i + 1 === segmentFiles.length) {
      console.log(`🔍 Prepared ${i + 1}/${segmentFiles.length} segments`);
    }
  }

  const totalBatches = Math.ceil(uploadItems.length / batchSize);
  let completed = segmentFiles.length - uploadItems.length;
  let uploadedBytes = 0;

  for (let offset = 0; offset < uploadItems.length; offset += batchSize) {
    const batch = uploadItems.slice(offset, offset + batchSize);
    const batchNumber = Math.floor(offset / batchSize) + 1;

    // Update checkpoint in the same Hub commit as this batch's segments.
    const nextState = { ...remoteState };
    for (const item of batch) {
      const name = pathModule.basename(item.localPath);
      nextState[name] = mapping[name];
    }
    await fs.writeFile(stateLocalPath, JSON.stringify({
      movie: movieName,
      updated_at: new Date().toISOString(),
      segments: nextState
    }, null, 2) + "\n", "utf8");

    await uploadBatch(repo, token, branch, batch, batchNumber, totalBatches, stateLocalPath, stateRemotePath);
    remoteState = nextState;

    completed += batch.length;
    uploadedBytes += batch.reduce((sum, item) => sum + item.size, 0);
    const elapsed = Math.max((Date.now() - startedAt) / 1000, 0.1);
    const speed = uploadedBytes / 1024 / 1024 / elapsed;
    console.log(`✅ ${completed}/${segmentFiles.length} files (${(completed / segmentFiles.length * 100).toFixed(1)}%) | ${speed.toFixed(2)} MB/s average`);
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

  const playlistLocalPath = pathModule.join(hlsDir, "index.m3u8");
  const mappingLocalPath = pathModule.join(hlsDir, "mapping.json");
  const segmentMappingLocalPath = pathModule.join(hlsDir, "segment_mapping.json");
  const playlistRemotePath = `${movieRoot}/index.m3u8`;
  const mappingRemotePath = `${movieRoot}/mapping.json`;
  const segmentMappingRemotePath = `${movieRoot}/segment_mapping.json`;

  await fs.writeFile(playlistLocalPath, playlistLines.join("\n") + "\n", "utf8");
  await fs.writeFile(mappingLocalPath, JSON.stringify(mapping, null, 2) + "\n", "utf8");
  await fs.writeFile(segmentMappingLocalPath, JSON.stringify(mapping, null, 2) + "\n", "utf8");

  await uploadFiles({
    repo,
    accessToken: token,
    branch,
    files: [
      { path: playlistRemotePath, content: pathToFileURL(playlistLocalPath) },
      { path: mappingRemotePath, content: pathToFileURL(mappingLocalPath) },
      { path: segmentMappingRemotePath, content: pathToFileURL(segmentMappingLocalPath) }
    ],
    commitTitle: `Publish HLS playlist: ${movieName}`,
    commitDescription: "Publish HLS playlist and segment mapping after segment upload"
  });

  const elapsed = Math.max((Date.now() - startedAt) / 1000, 0.1);
  console.log("\n" + "=".repeat(64));
  console.log("🎉 HLS UPLOAD COMPLETE");
  console.log(`⏱️ Upload time : ${elapsed.toFixed(1)} seconds`);
  console.log(`📄 Playlist    : ${makeResolveUrl(repoId, playlistRemotePath, branch)}`);
  console.log(`🗂️ Mapping     : ${makeResolveUrl(repoId, mappingRemotePath, branch)}`);
  console.log("=".repeat(64));
}

async function main() {
  const videoUrl = required(VIDEO_URL, "VIDEO_URL");
  const token = required(HF_TOKEN, "HF_TOKEN");
  const repoId = required(HF_REPO_ID, "HF_REPO_ID");
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repoId)) {
    throw new Error("HF_REPO_ID must be in username/repository-name format.");
  }
  if (HF_REPO_TYPE !== "dataset") throw new Error("HF_REPO_TYPE must be 'dataset'.");
  const remoteRoot = safeFolder(HF_PATH, "HF_PATH");
  const movieName = safeName(VIDEO_NAME);
  const segmentDuration = Number(SEGMENT_DURATION);
  const batchSize = Number(HF_BATCH_SIZE);

  if (!Number.isInteger(segmentDuration) || segmentDuration < 1 || segmentDuration > 60) {
    throw new Error("SEGMENT_DURATION must be an integer from 1 to 60.");
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 200) {
    throw new Error("HF_BATCH_SIZE must be an integer from 1 to 200.");
  }
  if (!["auto", "mp4", "mkv", "hevc"].includes(INPUT_FORMAT)) {
    throw new Error("INPUT_FORMAT must be auto, mp4, mkv, or hevc.");
  }

  await run("ffmpeg", ["-version"]);
  await run("curl", ["--version"]);

  const workRoot = pathModule.resolve(WORK_DIR);
  const downloadDir = pathModule.join(workRoot, "download");
  const hlsDir = pathModule.join(workRoot, "hls", movieName);
  await fs.rm(workRoot, { recursive: true, force: true });
  await fs.mkdir(downloadDir, { recursive: true });

  const inputFile = pathModule.join(downloadDir, `source${inputExtension(videoUrl, INPUT_FORMAT)}`);

  console.log("=".repeat(64));
  console.log("🎬 VIDEO → HLS → HUGGING FACE");
  console.log(`🎞️ Video name     : ${movieName}`);
  console.log(`📁 Local HLS dir  : ${hlsDir}`);
  console.log(`📦 HF destination : ${remoteRoot}/${movieName}`);
  console.log("=".repeat(64));

  await downloadVideo(videoUrl, inputFile);
  await convertToHls(inputFile, hlsDir, segmentDuration);
  await uploadHls(hlsDir, movieName, token, repoId, remoteRoot, batchSize, HF_BRANCH);
}

main().catch(error => {
  console.error("\n❌ VIDEO → HLS → HUGGING FACE FAILED:");
  console.error(error?.stack || error);
  process.exitCode = 1;
});
