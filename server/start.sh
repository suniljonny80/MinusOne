#!/bin/sh
# YouTube changes often and old yt-dlp versions stop working, so update it on every start.
pip install --user --no-cache-dir -q -U "yt-dlp[default]" 2>/dev/null || echo "yt-dlp update skipped"
exec uvicorn app:app --host 0.0.0.0 --port "${PORT:-7860}" --proxy-headers --forwarded-allow-ips="*"
