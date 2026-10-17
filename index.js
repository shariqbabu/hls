
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const {
  VIDEO_URL,
  INPUT_FORMAT = "auto",
  OUTPUT_DIR = "hls",
  HF_TOKEN,
  HF_REPO_ID,
  HF_REPO_TYPE = "dataset"
} = process.env;

const WORK_DIR = path.resolve("temp-work");
const INPUT_DIR = path.join(WORK_DIR, "input");
const OUTPUT_PATH = path.resolve("hls-output");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: "inherit",
    shell: false
  });

  if (result.error) throw result.error;

  if (result.status !== 0) {
    throw new Error(
      `${command} failed with exit code ${result.status}`
    );
  }
}

function validateRepoId(value) {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value || "")) {
    throw new Error(
      "HF_REPO_ID must be username/repository-name"
    );
  }
}

function validateOutputDir(value) {
  const normalized = (value || "").trim().replace(/^\/+|\/+$/g, "");

  if (
    !normalized ||
    normalized.includes("\\") ||
    normalized.split("/").some(
      part => !part || part === "." || part === ".."
    )
  ) {
    throw new Error(
      "Invalid OUTPUT_DIR. Example: movies/cricket"
    );
  }

  return normalized;
}

async function main() {
  if (!VIDEO_URL || !HF_TOKEN || !HF_REPO_ID) {
    throw new Error(
      "Required: VIDEO_URL, HF_TOKEN, HF_REPO_ID"
    );
  }

  const repoId = HF_REPO_ID.trim();
  validateRepoId(repoId);

  const format = INPUT_FORMAT.toLowerCase();

  if (!["auto", "mp4", "mkv", "hevc"].includes(format)) {
    throw new Error(
      "INPUT_FORMAT must be auto, mp4, mkv, or hevc"
    );
  }

  if (HF_REPO_TYPE !== "dataset") {
    throw new Error(
      "This workflow expects a Hugging Face dataset repository"
    );
  }

  const outputDir = validateOutputDir(OUTPUT_DIR);

  const url = new URL(VIDEO_URL);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("VIDEO_URL must be HTTP or HTTPS");
  }

  await fs.rm(WORK_DIR, { recursive: true, force: true });
  await fs.rm(OUTPUT_PATH, { recursive: true, force: true });

  await fs.mkdir(INPUT_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_PATH, { recursive: true });

  const inputFile = path.join(INPUT_DIR, "source-video");

  try {
    // 1. Download video to temporary storage
    console.log("Downloading video...");

    const curlArgs = [
      "--fail",
      "--location",
      "--retry", "3",
      "--retry-delay", "2",
      "--connect-timeout", "30",
      "--output", inputFile,
      VIDEO_URL
    ];

    run("curl", curlArgs);

    const inputStat = await fs.stat(inputFile);

    if (!inputStat.size) {
      throw new Error("Downloaded video is empty");
    }

    console.log(`Downloaded ${inputStat.size} bytes`);

    // 2. Convert to HLS, maximum 1080p, 10-second segments
    const ffmpegArgs = ["-hide_banner", "-y"];

    if (format === "hevc") {
      ffmpegArgs.push("-f", "hevc");
    }

    ffmpegArgs.push(
      "-i", inputFile,
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-vf",
      "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-ac", "2",
      "-f", "hls",
      "-hls_time", "10",
      "-hls_playlist_type", "vod",
      "-hls_segment_filename",
      path.join(OUTPUT_PATH, "segment_%05d.ts"),
      path.join(OUTPUT_PATH, "index.m3u8")
    );

    console.log("Converting video to HLS...");
    run("ffmpeg", ffmpegArgs);

    // 3. Validate playlist and segments
    const playlistPath = path.join(OUTPUT_PATH, "index.m3u8");
    const playlist = await fs.readFile(playlistPath, "utf8");

    if (!playlist.startsWith("#EXTM3U")) {
      throw new Error("Generated HLS playlist is invalid");
    }

    const files = await fs.readdir(OUTPUT_PATH);
    const segments = files.filter(file => file.endsWith(".ts"));

    if (!segments.length) {
      throw new Error("No HLS segments were generated");
    }

    console.log(`Generated ${segments.length} segments`);

    // 4. Clone Hugging Face dataset using temporary Git credentials
    const repoDir = path.join(WORK_DIR, "hf-repository");
    const repoUrl = `https://huggingface.co/datasets/${repoId}`;

    const askpassPath = path.join(WORK_DIR, "git-askpass.sh");

    await fs.writeFile(
      askpassPath,
      '#!/bin/sh\ncase "$1" in\n' +
      '  *Username*) printf "%s\\n" "user" ;;\n' +
      '  *Password*) printf "%s\\n" "$HF_TOKEN" ;;\n' +
      '  *) exit 1 ;;\n' +
      'esac\n',
      { mode: 0o700 }
    );

    const gitEnv = {
      GIT_ASKPASS: askpassPath,
      GIT_TERMINAL_PROMPT: "0",
      HF_TOKEN
    };

    console.log("Cloning Hugging Face repository...");
    run("git", ["clone", "--depth", "1", repoUrl, repoDir], {
      env: gitEnv
    });

    // 5. Copy generated files to the selected repository folder
    const uploadPath = path.resolve(repoDir, outputDir);
    const relativeUpload = path.relative(repoDir, uploadPath);

    if (
      relativeUpload.startsWith("..") ||
      path.isAbsolute(relativeUpload)
    ) {
      throw new Error("Output folder must be inside the repository");
    }

    await fs.mkdir(uploadPath, { recursive: true });

    for (const file of files) {
      await fs.copyFile(
        path.join(OUTPUT_PATH, file),
        path.join(uploadPath, file)
      );
    }

    run("git", ["config", "user.name", "GitHub Actions"], {
      cwd: repoDir
    });

    run("git", [
      "config", "user.email",
      "actions@users.noreply.github.com"
    ], { cwd: repoDir });

    run("git", ["add", "--", relativeUpload], {
      cwd: repoDir
    });

    const diff = spawnSync(
      "git",
      ["diff", "--cached", "--quiet"],
      { cwd: repoDir, stdio: "ignore" }
    );

    if (diff.status === 0) {
      console.log("No changes to upload.");
    } else if (diff.status === 1) {
      run("git", [
        "commit", "-m", "Upload generated HLS files"
      ], { cwd: repoDir });

      console.log("Uploading HLS files to Hugging Face...");

      run("git", [
        "-c",
        `http.extraheader=AUTHORIZATION: Basic ${Buffer.from(
          `user:${HF_TOKEN}`
        ).toString("base64")}`,
        "push", "origin", "HEAD"
      ], { cwd: repoDir });
    } else {
      throw new Error("Unable to inspect staged Git changes");
    }

    console.log("Upload completed successfully.");
    console.log(`Repository: ${repoUrl}`);
    console.log(`Playlist path: ${outputDir}/index.m3u8`);

  } finally {
    // 6. Remove downloaded video, generated HLS and cloned repository
    await fs.rm(WORK_DIR, {
      recursive: true,
      force: true
    });

    await fs.rm(OUTPUT_PATH, {
      recursive: true,
      force: true
    });

    console.log("Temporary files deleted.");
  }
}

main().catch(error => {
  console.error("Workflow failed:", error.message);
  process.exitCode = 1;
});
