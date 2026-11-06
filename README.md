# Telegram HLS — 72 Worker Round-Robin

1. Add a GitHub Actions repository secret named `WORKER_URLS`.
2. Paste exactly 72 unique Worker base URLs, one per line.
3. Replace the existing workflow with `workflow.yml`.
4. Put `process.py` at `scripts/process.py` (or repository root if your workflow invokes root `process.py`).

Each playlist segment is assigned round-robin:
segment 1 -> Worker 1, segment 2 -> Worker 2, ... segment 72 -> Worker 72,
segment 73 -> Worker 1.

Each Worker must already be deployed and serve the same `/api/tg/stream` endpoint.
The code appends `/api/tg/stream` to base URLs automatically.
Existing `next`, `next2`, ... prefetch query parameters are retained.

This balances HLS playlist segment requests, not Telegram upload traffic.
A video with fewer than 72 segments will only use that many Workers.

url=https://huggingface.co/datasets/shariqbabu/hls-storage/resolve/main/
