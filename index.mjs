
/**
 * Hugging Face Dataset HLS uploader
 * Usage: node process-hf.js <hls_directory> [movie_name]
 *
 * Required env:
 *   HF_TOKEN       Hugging Face write token
 *   HF_REPO_ID     username/dataset-repo
 *
 * Optional env:
 *   HF_REPO_TYPE   dataset (only dataset is supported)
 *   HF_PATH        remote folder, default: hls
 *   HF_BATCH_SIZE  files per commit, default: 40
 *   HF_BRANCH      target branch, default: main
 */

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { downloadFile, uploadFiles } from "@huggingface/hub";
import crypto from "node:crypto";

const {
  HF_TOKEN,
  HF_REPO_ID,
  HF_REPO_TYPE = "dataset",
  HF_PATH = "hls",
  HF_BATCH_SIZE = "40",
  HF_BRANCH = "main"
} = process.env;

function required(value, name) {
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return String(value).trim();
}

function validateRepoId(repoId) {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repoId)) {
    throw new Error("HF_REPO_ID must be in username/repository-name format.");
  }
}

function safeFolder(value, label) {
  const cleaned = String(value || "").trim().replace(/^\/+|\/+$/g, "");
  if (!cleaned || cleaned.includes("\\") || cleaned.split("/").some(p => !p || p === "." || p === "..")) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return cleaned;
}

function safeName(value) {
  const name = String(value || "").trim();
  if (!name || name === "." || name === ".." || /[/\\<>:"|?*\x00-\x1f]/.test(name)) {
    throw new Error("Invalid movie name. Avoid slashes and filesystem-reserved characters.");
  }
  return name;
}

function sortSegments(a, b) {
  const getNumber = name => {
    const match = name.match(/(\d+)(?=\.ts$)/i);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  };
  return getNumber(a.name) - getNumber(b.name) || a.name.localeCompare(b.name);
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = (await import("node:fs")).createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function readDurations(m3u8Path) {
  const durations = new Map();
  let targetDuration = 1;

  try {
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
        const basename = path.basename(line.split("?")[0]);
        if (Number.isFinite(currentDuration) && currentDuration > 0) {
          durations.set(basename, currentDuration);
          targetDuration = Math.max(targetDuration, Math.ceil(currentDuration));
        }
        currentDuration = null;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    console.warn("⚠️ local.m3u8 not found; using 6-second fallback durations.");
  }

  return { durations, targetDuration };
}

function encodeRepoPath(repoPath) {
  return repoPath.split("/").map(encodeURIComponent).join("/");
}

function makeResolveUrl(repoId, repoPath, branch) {
  return `https://huggingface.co/datasets/${repoId}/resolve/${encodeURIComponent(branch)}/${encodeRepoPath(repoPath)}`;
}

async function uploadBatch(repo, token, branch, batch, batchNumber, totalBatches, stateFilePath, stateRemotePath) {
  const files = batch.map(item => ({
    path: item.remotePath,
    content: pathToFileURL(item.localPath)
  }));
  files.push({ path: stateRemotePath, content: pathToFileURL(stateFilePath) });

  console.log(`\n⬆️ Upload batch ${batchNumber}/${totalBatches} (${files.length} files)`);
  await uploadFiles({
    repo,
    accessToken: token,
    branch,
    files,
    commitTitle: `Upload HLS batch ${batchNumber}/${totalBatches}`,
    commitDescription: "HLS segment upload via Node.js"
  });
}

async function main() {
  const token = required(HF_TOKEN, "HF_TOKEN");
  const repoId = required(HF_REPO_ID, "HF_REPO_ID");
  validateRepoId(repoId);

  if (HF_REPO_TYPE !== "dataset") {
    throw new Error("HF_REPO_TYPE must be 'dataset'.");
  }

  const remoteRoot = safeFolder(HF_PATH, "HF_PATH");
  const batchSize = Number(HF_BATCH_SIZE);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 200) {
    throw new Error("HF_BATCH_SIZE must be an integer from 1 to 200.");
  }

  const hlsDir = path.resolve(process.argv[2] || "");
  const movieName = safeName(process.argv[3] || path.basename(hlsDir));
  const repo = { type: "dataset", name: repoId };

  const stat = await fs.stat(hlsDir).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`HLS directory does not exist: ${hlsDir}`);

  const segmentFiles = (await fs.readdir(hlsDir, { withFileTypes: true }))
    .filter(entry => entry.isFile() && /^segment_.*\.ts$/i.test(entry.name))
    .map(entry => ({ name: entry.name, localPath: path.join(hlsDir, entry.name) }))
    .sort(sortSegments);

  if (!segmentFiles.length) throw new Error(`No segment_*.ts files found in ${hlsDir}`);

  const { durations, targetDuration } = await readDurations(path.join(hlsDir, "index.m3u8"));
  const movieRoot = `${remoteRoot}/${movieName}`;
  const totalBytes = (await Promise.all(segmentFiles.map(async file => (await fs.stat(file.localPath)).size)))
    .reduce((sum, size) => sum + size, 0);

  console.log("=".repeat(64));
  console.log("🤗 HUGGING FACE HLS UPLOADER");
  console.log(`📦 Dataset       : ${repoId}`);
  console.log(`📁 Remote folder : ${movieRoot}`);
  console.log(`🎞️ Segments      : ${segmentFiles.length}`);
  console.log(`💾 Total size    : ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`🧩 Batch size    : ${batchSize} files`);
  console.log("=".repeat(64));

  const startedAt = Date.now();
  const mapping = {};
  const uploadItems = [];
  const stateRemotePath = `${movieRoot}/upload-state.json`;
  const stateLocalPath = path.join(hlsDir, "upload-state.json");
  let remoteState = {};

  // Read the last committed checkpoint so a rerun can skip completed segments.
  try {
    const remoteStateFile = await downloadFile({ repo, path: stateRemotePath, accessToken: token });
    if (remoteStateFile) {
      const parsed = JSON.parse(await remoteStateFile.text());
      remoteState = parsed.segments && typeof parsed.segments === "object" ? parsed.segments : {};
      console.log(`🔄 Resume checkpoint found: ${Object.keys(remoteState).length} segment records.`);
    }
  } catch (error) {
    console.log("ℹ️ No previous upload checkpoint found; starting a new upload.");
  }

  // Hash and prepare segment metadata. Hashes make the local mapping auditable.
  for (let i = 0; i < segmentFiles.length; i++) {
    const file = segmentFiles[i];
    const fileStat = await fs.stat(file.localPath);
    const remotePath = `${movieRoot}/${file.name}`;
    const duration = durations.get(file.name) ?? 6;
    const url = makeResolveUrl(repoId, remotePath, HF_BRANCH);

    const sha256 = await sha256File(file.localPath);
    mapping[file.name] = {
      filename: file.name,
      path: remotePath,
      url,
      size_bytes: fileStat.size,
      duration_seconds: duration,
      sha256
    };

    const previous = remoteState[file.name];
    if (previous && previous.sha256 === sha256 && previous.size_bytes === fileStat.size) {
      console.log(`⏭️ Already uploaded; skipping ${file.name}`);
    } else {
      uploadItems.push({ localPath: file.localPath, remotePath, size: fileStat.size, stateRemotePath });
    }

    if ((i + 1) % 25 === 0 || i + 1 === segmentFiles.length) {
      console.log(`🔍 Prepared ${i + 1}/${segmentFiles.length} segments`);
    }
  }

  // Upload in bounded batches. The Hub SDK handles the underlying upload protocol
  // and content-addressed storage; rerunning the same files benefits from deduplication.
  const totalBatches = Math.ceil(uploadItems.length / batchSize);
  let uploadedFiles = segmentFiles.length - uploadItems.length;
  let uploadedBytes = 0;

  for (let offset = 0; offset < uploadItems.length; offset += batchSize) {
    const batch = uploadItems.slice(offset, offset + batchSize);
    const batchNumber = Math.floor(offset / batchSize) + 1;

    // Commit segment files and their checkpoint together. If the process stops,
    // the next run can trust only checkpoints that were committed with the files.
    for (const item of batch) remoteState[path.basename(item.localPath)] = mapping[path.basename(item.localPath)];
    await fs.writeFile(stateLocalPath, JSON.stringify({
      movie: movieName,
      updated_at: new Date().toISOString(),
      segments: remoteState
    }, null, 2) + "\n", "utf8");

    await uploadBatch(repo, token, HF_BRANCH, batch, batchNumber, totalBatches, stateLocalPath, stateRemotePath);

    uploadedFiles += batch.length;
    uploadedBytes += batch.reduce((sum, item) => sum + item.size, 0);
    const elapsed = Math.max((Date.now() - startedAt) / 1000, 0.1);
    const speed = uploadedBytes / 1024 / 1024 / elapsed;
    const percent = (uploadedFiles / segmentFiles.length) * 100;
    console.log(`✅ ${uploadedFiles}/${segmentFiles.length} files (${percent.toFixed(1)}%) | ${speed.toFixed(2)} MB/s average`);
  }

  // Create the final VOD playlist only after every segment upload has committed.
  const playlistLines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    "#EXT-X-MEDIA-SEQUENCE:0"
  ];

  for (const file of segmentFiles) {
    const item = mapping[file.name];
    playlistLines.push(`#EXTINF:${Number(item.duration_seconds).toFixed(6)},`);
    playlistLines.push(item.url);
  }
  playlistLines.push("#EXT-X-ENDLIST");

  const playlistContent = playlistLines.join("\n") + "\n";
  const playlistLocalPath = path.join(hlsDir, "index.m3u8");
  const mappingLocalPath = path.join(hlsDir, "mapping.json");
  const segmentMappingLocalPath = path.join(hlsDir, "segment_mapping.json");
  const playlistRemotePath = `${movieRoot}/index.m3u8`;
  const mappingRemotePath = `${movieRoot}/mapping.json`;
  const segmentMappingRemotePath = `${movieRoot}/segment_mapping.json`;

  await fs.writeFile(playlistLocalPath, playlistContent, "utf8");
  await fs.writeFile(mappingLocalPath, JSON.stringify(mapping, null, 2) + "\n", "utf8");
  await fs.writeFile(segmentMappingLocalPath, JSON.stringify(mapping, null, 2) + "\n", "utf8");

  await uploadFiles({
    repo,
    accessToken: token,
    branch: HF_BRANCH,
    files: [
      { path: playlistRemotePath, content: pathToFileURL(playlistLocalPath) },
      { path: mappingRemotePath, content: pathToFileURL(mappingLocalPath) },
      { path: segmentMappingRemotePath, content: pathToFileURL(segmentMappingLocalPath) }
    ],
    commitTitle: `Publish HLS playlist: ${movieName}`,
    commitDescription: "Publish HLS playlist and segment mapping after segment upload"
  });

  const elapsed = Math.max((Date.now() - startedAt) / 1000, 0.1);
  const playlistUrl = makeResolveUrl(repoId, playlistRemotePath, HF_BRANCH);

  console.log("\n" + "=".repeat(64));
  console.log("🎉 HLS UPLOAD COMPLETE");
  console.log(`⏱️ Total time : ${elapsed.toFixed(1)} seconds`);
  console.log(`📄 Playlist   : ${playlistUrl}`);
  console.log(`🗂️ Mapping    : ${makeResolveUrl(repoId, mappingRemotePath, HF_BRANCH)}`);
  console.log("\n🔗 Segment URLs:");
  for (const file of segmentFiles) console.log(mapping[file.name].url);
  console.log("=".repeat(64));
}

main().catch(error => {
  console.error("\n❌ HUGGING FACE HLS UPLOAD FAILED:");
  console.error(error?.stack || error);
  process.exitCode = 1;
});
