import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const env = process.env;
const videoUrl = env.VIDEO_URL;
const inputFormat = (env.INPUT_FORMAT || "auto").toLowerCase();
const hfToken = env.HF_TOKEN;
const hfRepoId = env.HF_REPO_ID;
const hfRepoType = (env.HF_REPO_TYPE || "dataset").toLowerCase();
const outputDir = path.resolve("hls/series/indias-got-latent/1");
const tempDir = path.resolve("temp-work");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...options.env },
    cwd: options.cwd,
    shell: false
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status}`);
  }
}

function required(name, value) {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
}

function validateRepoId(value) {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value || "")) {
    throw new Error("HF_REPO_ID must look like username/repository-name");
  }
}

async function main() {
  required("VIDEO_URL", videoUrl);
  required("HF_TOKEN", hfToken);
  required("HF_REPO_ID", hfRepoId);
  validateRepoId(hfRepoId);

  if (!["auto", "mp4", "mkv", "hevc"].includes(inputFormat)) {
    throw new Error("INPUT_FORMAT must be auto, mp4, mkv, or hevc");
  }
  if (!["dataset", "model", "space"].includes(hfRepoType)) {
    throw new Error("HF_REPO_TYPE must be dataset, model, or space");
  }

  const parsedUrl = new URL(videoUrl);
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("VIDEO_URL must be an HTTP or HTTPS direct-download URL");
  }

  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(tempDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });

  const inputPath = path.join(tempDir, "source-video");
  console.log("Downloading source video to temporary storage...");
  run("curl", [
    "--fail", "--location", "--retry", "3", "--retry-delay", "2",
    "--connect-timeout", "30", "--output", inputPath, videoUrl
  ]);

  const stat = await fs.stat(inputPath);
  if (!stat.size) throw new Error("Downloaded file is empty");
  console.log(`Download complete (${stat.size} bytes).`);

  const ffmpegArgs = ["-hide_banner", "-y"];
  if (inputFormat === "hevc") ffmpegArgs.push("-f", "hevc");
  ffmpegArgs.push(
    "-i", inputPath,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-vf", "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ac", "2",
    "-f", "hls",
    "-hls_time", "10",
    "-hls_playlist_type", "vod",
    "-hls_segment_filename", path.join(outputDir, "segment_%05d.ts"),
    path.join(outputDir, "index.m3u8")
  );

  console.log("Converting to HLS (maximum 1080p, 10-second target segments)...");
  run("ffmpeg", ffmpegArgs);

  const playlistPath = path.join(outputDir, "index.m3u8");
  const playlist = await fs.readFile(playlistPath, "utf8");
  if (!playlist.includes("#EXTM3U")) throw new Error("Generated playlist is invalid");

  const segments = (await fs.readdir(outputDir)).filter((name) => name.endsWith(".ts"));
  if (segments.length === 0) throw new Error("FFmpeg produced no .ts segments");
  console.log(`Generated ${segments.length} HLS segments.`);

  const repoDir = path.join(tempDir, "hf-repository");
  const repoBase = hfRepoType === "dataset" ? "datasets/" :
                   hfRepoType === "space" ? "spaces/" : "";
  const repoUrl = `https://huggingface.co/${repoBase}${hfRepoId}`;

  // Provide credentials to Git through a temporary askpass helper rather than
  // embedding the token in the remote URL.
  const askpassPath = path.join(tempDir, "git-askpass.sh");
  await fs.writeFile(
    askpassPath,
    '#!/bin/sh\ncase "$1" in\n  *Username*) echo "user" ;;\n  *Password*) echo "$HF_TOKEN" ;;\n  *) echo "" ;;\nesac\n',
    { mode: 0o700 }
  );

  const gitEnv = {
    GIT_ASKPASS: askpassPath,
    GIT_TERMINAL_PROMPT: "0",
    HF_TOKEN: hfToken
  };

  console.log("Cloning Hugging Face repository...");
  run("git", ["clone", "--depth", "1", repoUrl, repoDir], { env: gitEnv });

  // Upload into a dedicated directory so unrelated repository files are preserved.
  const uploadDir = path.join(repoDir, "hls");
  await fs.rm(uploadDir, { recursive: true, force: true });
  await fs.cp(outputDir, uploadDir, { recursive: true });

  run("git", ["config", "user.name", "GitHub Actions"], { cwd: repoDir });
  run("git", ["config", "user.email", "actions@users.noreply.github.com"], { cwd: repoDir });
  run("git", ["add", "hls"], { cwd: repoDir });

  const diff = spawnSync("git", ["diff", "--cached", "--quiet"], {
    cwd: repoDir, stdio: "ignore", env: { ...process.env, ...gitEnv }
  });

  if (diff.status === 0) {
    console.log("No changes to upload; repository already has the same HLS files.");
  } else {
    run("git", ["commit", "-m", "Upload HLS output from GitHub Actions"], {
      cwd: repoDir, env: gitEnv
    });
    console.log("Pushing HLS files to Hugging Face...");
    run("git", ["push", "origin", "HEAD"], { cwd: repoDir, env: gitEnv });
  }

  console.log(`Hugging Face repository: ${repoUrl}`);
  console.log("HLS path: hls/index.m3u8");
}

try {
  await main();
} finally {
  // Remove source, generated HLS, cloned repository, and askpass helper.
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.rm(outputDir, { recursive: true, force: true });
  console.log("Temporary input/output files cleaned up.");
}
