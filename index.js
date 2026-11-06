
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const {
  VIDEO_URL,
  VIDEO_NAME = "my-video",
  INPUT_FORMAT = "auto",
  OUTPUT_DIR = "hls",
  SEGMENT_DURATION = "6",
  HF_TOKEN,
  HF_REPO_ID,
  HF_REPO_TYPE = "dataset"
} = process.env;

const WORK_DIR = path.resolve("temp-work");
const INPUT_DIR = path.join(WORK_DIR, "input");
const OUTPUT_PATH = path.resolve("nexplay");

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
    throw new Error("HF_REPO_ID must be username/repository-name");
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
    throw new Error("Invalid OUTPUT_DIR. Example: movies/action");
  }

  return normalized;
}

function validateVideoName(value) {
  const name = (value || "").trim();

  if (
    !name ||
    name === "." ||
    name === ".." ||
    /[/\\<>:"|?*\x00-\x1f]/.test(name)
  ) {
    throw new Error(
      "Invalid VIDEO_NAME. Use letters, numbers, spaces, - or _."
    );
  }

  return name;
}

function getSegmentDuration(value) {
  const duration = Number(value);

  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 60
  ) {
    throw new Error(
      "SEGMENT_DURATION must be greater than 0 and at most 60 seconds."
    );
  }

  return String(duration);
}

function getVideoInfo(inputFile, format) {
  const args = [
    "-v", "error",
    "-show_entries",
    "format=format_name:stream=codec_type,codec_name",
    "-of", "json"
  ];

  if (format === "hevc") {
    args.push("-f", "hevc");
  }

  args.push(inputFile);

  const result = spawnSync("ffprobe", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });

  if (result.status !== 0 || !result.stdout) {
    throw new Error(
      "Invalid video file. URL must point to a direct video file."
    );
  }

  const info = JSON.parse(result.stdout);
  const video = info.streams?.find(
    stream => stream.codec_type === "video"
  );

  if (!video) {
    throw new Error("No video stream found in downloaded file.");
  }

  return {
    codec: video.codec_name,
    hasAudio: info.streams.some(
      stream => stream.codec_type === "audio"
    ),
    format: info.format?.format_name || "unknown"
  };
}

function createAskpass() {
  return path.join(WORK_DIR, "git-askpass.sh");
}

async function main() {
  if (!VIDEO_URL || !HF_TOKEN || !HF_REPO_ID) {
    throw new Error(
      "Required: VIDEO_URL, HF_TOKEN and HF_REPO_ID"
    );
  }

  const repoId = HF_REPO_ID.trim();
  validateRepoId(repoId);

  const format = INPUT_FORMAT.toLowerCase();

  if (!["auto", "mp4", "mkv", "hevc"].includes(format)) {
    throw new Error("Invalid INPUT_FORMAT.");
  }

  if (HF_REPO_TYPE !== "dataset") {
    throw new Error("Only Hugging Face dataset repositories are supported.");
  }

  const outputDir = validateOutputDir(OUTPUT_DIR);
  const videoName = validateVideoName(VIDEO_NAME);
  const segmentDuration = getSegmentDuration(SEGMENT_DURATION);

  const url = new URL(VIDEO_URL);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("VIDEO_URL must use HTTP or HTTPS.");
  }

  const repoUrl = `https://huggingface.co/datasets/${repoId}`;

  await fs.rm(WORK_DIR, { recursive: true, force: true });
  await fs.rm(OUTPUT_PATH, { recursive: true, force: true });

  await fs.mkdir(INPUT_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_PATH, { recursive: true });

  try {
    // STEP 1: DOWNLOAD

    const inputFile = path.join(INPUT_DIR, "source-video");

    console.log("==================================");
    console.log("STEP 1: Downloading video");
    console.log("==================================");

    run("curl", [
      "--fail",
      "--show-error",
      "--location",
      "--retry", "3",
      "--retry-delay", "2",
      "--connect-timeout", "30",
      "--output", inputFile,
      VIDEO_URL
    ]);

    const inputStat = await fs.stat(inputFile);

    if (!inputStat.size) {
      throw new Error("Downloaded video is empty.");
    }

    console.log(`Downloaded: ${inputStat.size} bytes`);

    // STEP 2: VIDEO VALIDATION

    console.log("==================================");
    console.log("STEP 2: Inspecting video");
    console.log("==================================");

    const videoInfo = getVideoInfo(inputFile, format);

    console.log("Container:", videoInfo.format);
    console.log("Video codec:", videoInfo.codec);
    console.log("Audio:", videoInfo.hasAudio ? "Yes" : "No");

    // STEP 3: HLS CONVERSION

    console.log("==================================");
    console.log("STEP 3: Generating HLS");
    console.log("==================================");

    const playlistPath = path.join(
      OUTPUT_PATH,
      "index.m3u8"
    );

    const segmentPattern = path.join(
      OUTPUT_PATH,
      "segment_%05d.ts"
    );

    const ffmpegArgs = [
      "-hide_banner",
      "-y",
      "-i", inputFile,
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-sn",
      "-dn"
    ];

    // Copy H.264 without re-encoding.
    // Convert HEVC and other codecs to H.264.

    if (videoInfo.codec === "h264") {
      console.log("H.264 detected: using stream copy.");
      ffmpegArgs.push("-c:v", "copy");
    } else {
      console.log("Non-H.264 detected: converting to H.264.");

      ffmpegArgs.push(
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-pix_fmt", "yuv420p"
      );
    }

    if (videoInfo.hasAudio) {
      ffmpegArgs.push(
        "-c:a", "aac",
        "-b:a", "128k"
      );
    }

    ffmpegArgs.push(
      "-max_muxing_queue_size", "1024",
      "-f", "hls",
      "-hls_time", segmentDuration,
      "-hls_playlist_type", "vod",
      "-hls_flags", "independent_segments",
      "-start_number", "0",
      "-hls_segment_filename", segmentPattern,
      playlistPath
    );

    run("ffmpeg", ffmpegArgs);

    // STEP 4: VERIFY OUTPUT

    console.log("==================================");
    console.log("STEP 4: Verifying HLS output");
    console.log("==================================");

    const playlist = await fs.readFile(playlistPath, "utf8");

    if (!playlist.startsWith("#EXTM3U")) {
      throw new Error("Generated playlist is invalid.");
    }

    const outputFiles = await fs.readdir(OUTPUT_PATH);

    const segments = outputFiles.filter(
      file => /^segment_\d+\.ts$/.test(file)
    );

    if (!segments.length) {
      throw new Error("No HLS segments generated.");
    }

    console.log(`Segments generated: ${segments.length}`);

    // STEP 5: CLONE HUGGING FACE REPOSITORY

    console.log("==================================");
    console.log("STEP 5: Connecting Hugging Face");
    console.log("==================================");

    const repoDir = path.join(WORK_DIR, "hf-repository");
    const askpassPath = createAskpass();

    await fs.writeFile(
      askpassPath,
      '#!/bin/sh\n' +
      'case "$1" in\n' +
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

    run("git", [
      "clone",
      "--depth", "1",
      repoUrl,
      repoDir
    ], { env: gitEnv });

    // STEP 6: CREATE NAMED VIDEO FOLDER

    console.log("==================================");
    console.log("STEP 6: Preparing upload folder");
    console.log("==================================");

    const relativeUpload = path.posix.join(
      outputDir,
      videoName
    );

    const uploadPath = path.resolve(
      repoDir,
      ...relativeUpload.split("/")
    );

    const relativeCheck = path.relative(repoDir, uploadPath);

    if (
      relativeCheck.startsWith("..") ||
      path.isAbsolute(relativeCheck)
    ) {
      throw new Error("Invalid upload destination.");
    }

    await fs.mkdir(uploadPath, { recursive: true });

    for (const file of outputFiles) {
      await fs.copyFile(
        path.join(OUTPUT_PATH, file),
        path.join(uploadPath, file)
      );
    }

    // Track HLS segments with Git LFS.

    run("git", ["lfs", "track", "*.ts"], {
      cwd: repoDir
    });

    run("git", ["config", "user.name", "GitHub Actions"], {
      cwd: repoDir
    });

    run("git", [
      "config",
      "user.email",
      "actions@users.noreply.github.com"
    ], { cwd: repoDir });

    // STEP 7: UPLOAD

    console.log("==================================");
    console.log("STEP 7: Uploading to Hugging Face");
    console.log("==================================");

    run("git", [
      "add",
      "--",
      ".gitattributes",
      relativeUpload
    ], { cwd: repoDir });

    const diff = spawnSync(
      "git",
      ["diff", "--cached", "--quiet"],
      { cwd: repoDir, stdio: "ignore" }
    );

    if (diff.status === 0) {
      console.log("No changes to upload.");
    } else if (diff.status === 1) {
      run("git", [
        "commit",
        "-m",
        `Upload HLS: ${videoName}`
      ], { cwd: repoDir });

      run("git", ["push", "origin", "HEAD"], {
        cwd: repoDir,
        env: gitEnv
      });
    } else {
      throw new Error("Unable to inspect staged Git changes.");
    }

    // STEP 8: FINAL RESULT

    
    // STEP 8: FINAL RESULT

    const baseUrl =
      `${repoUrl}/resolve/main/${relativeUpload}`;

    const playlistUrl = `${baseUrl}/index.m3u8`;

    console.log("\n==================================");
    console.log("HUGGING FACE UPLOAD SUCCESSFUL");
    console.log("==================================");

    console.log("\nVIDEO NAME:", videoName);
    console.log("HF FOLDER:", relativeUpload);
    console.log("TOTAL SEGMENTS:", segments.length);

    console.log("\nPLAYLIST URL:");
    console.log(playlistUrl);

    console.log("\nALL SEGMENT URLS:");

    for (const segment of segments.sort()) {
      console.log(`${baseUrl}/${segment}`);
    }

    console.log("\n==================================");
    console.log("ALL URLS GENERATED SUCCESSFULLY");
    console.log("==================================");

  } finally {
    await fs.rm(WORK_DIR, {
      recursive: true,
      force: true
    });

    await fs.rm(OUTPUT_PATH, {
      recursive: true,
      force: true
    });

    console.log("Temporary files cleaned.");
  }
}

main().catch(error => {
  console.error("WORKFLOW FAILED:", error.message);
  process.exitCode = 1;
});
