# MinusOne stem server

Backend for the MinusOne practice website. It downloads a song from a YouTube link (or takes an
uploaded file), splits it into six stems with [Demucs](https://github.com/adefossez/demucs)
(`htdemucs_6s`) and serves them as MP3s.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Server status, queue length, stems offered |
| `POST /api/split` `{"url": "<youtube link>"}` | Start splitting a YouTube song |
| `POST /api/upload` (multipart `file`) | Start splitting an uploaded file |
| `GET /api/jobs/{id}` | Progress of a song |
| `GET /api/stems/{id}/{stem}.mp3` | Download one stem |

On Windows, double-click **Start MinusOne Server.bat**. Optional settings (environment variables):
`ACCESS_KEY`, `YT_COOKIES`, `ALLOWED_ORIGINS`, `MAX_MINUTES`, `MAX_SONGS`, `DATA_DIR`.
See the main repository README for details.
