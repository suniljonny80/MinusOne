# MinusOne

**Play along with any song, minus your part.**

Paste a YouTube link (or upload a song). MinusOne splits it into **vocals, drums, bass, guitar,
keys and other**, then mutes the instrument you play so you can drum, sing or jam along.

- Mixer with a fader, mute and solo for every instrument, plus level meters
- One tap for **Full song / Without my part / Only my part** (great for learning a part)
- **Loop** any section: drag across the waveform
- **Slow down** to 50% or speed up to 125% without changing pitch; **change key** ±6 semitones
- **Download** your practice mix as a WAV (whole song or just the loop)
- Songs are saved in your browser, so they reopen instantly, even offline
- Works on phones, tablets and computers

It costs nothing to run: the website is hosted on **GitHub Pages**, and the AI that splits songs
([Demucs](https://github.com/adefossez/demucs) `htdemucs_6s`) runs on **your own Windows PC**. A free
Cloudflare tunnel lets your phone, tablet or any other device use it too.

**Website:** https://suniljonny80.github.io/MinusOne/

---

## Start the server on your PC

You need Windows 10/11 and [Python 3.12](https://www.python.org/downloads/) (tick *Add python.exe to PATH*
when installing).

1. Download this repository (green **Code** button → **Download ZIP**) and unzip it.
2. Open the `server` folder and double-click **Start MinusOne Server.bat**.
   If Windows shows "Windows protected your PC", click **More info → Run anyway**.
3. The first start installs everything it needs into `server\.venv` (5–15 minutes, about 2 GB with
   PyTorch). Later starts take a few seconds.
4. When it says **MinusOne is ready**, the website opens already connected, and a QR code opens.
   **Scan the QR code with your phone** to use MinusOne there.

Keep the server window open while you practise; close it to stop. The tunnel address changes every time
you start the server, so scan the new QR code (or open the new link) after a restart.

**Speed:** with an NVIDIA graphics card a song splits in well under a minute; on a CPU it takes about
1–3 minutes depending on the PC. Each song is split once: finished songs are kept in `server\data`
and in your browser, so opening them again is instant.

---

## Portable USB app (no website, no install)

Run MinusOne from a USB stick on any Windows 10/11 PC, in its own app window.

1. Download **`MinusOne-USB.zip`** (build it with `python desktop/build_usb.py`, or grab it from the
   releases) and copy the `MinusOne` folder inside it to a USB stick (about 6 GB free for GPU speed on NVIDIA PCs, 2 GB for the processor-only version).
2. Double-click **`Set up USB.bat`** once, on a PC with internet. It puts a portable Python, the
   splitting AI and everything else on the stick (about 2 GB, 10–30 minutes).
3. From then on, on any Windows PC: double-click **`MinusOne.exe`**.

Your songs are saved on the USB, saved mixes go to its `Exports` folder, and uploading a song works
offline (YouTube links need internet). The app window uses Microsoft Edge WebView2, which is built
into Windows 10 and 11.

```
desktop/
  launcher/launcher.c   MinusOne.exe source (cross-compiled with zig, see the comment at the top)
  launcher/MinusOne.exe the built launcher
  app/desktop.py        starts the server and opens the app window
  app/setup-usb.ps1     one-time USB setup
  build_usb.py          assembles dist/MinusOne and MinusOne-USB.zip
```

---

## Good to know

**YouTube blocking.** YouTube rarely blocks home internet connections, but if a video won't download,
upload the audio file instead (always works). Very long videos (over 15 minutes) are refused.

**Use it fairly.** MinusOne is for personal practice. Only split music you have the right to use, and
respect YouTube's terms.

**Other ways to host the server.** `server/Dockerfile` runs the same server on any Docker host
(e.g. a cloud VM). Point the website at it with the status button at the top right, or set a
repository variable `SERVER_URL` so the website uses it by default.

---

## How it works

```
site/      the website (GitHub Pages): plain HTML, CSS and JavaScript, no build step
  app.js            screens, server connection, song library (IndexedDB), mixer controls
  engine.js         loads stems, transport, WAV export
  mixer-worklet.js  real-time mixer on the audio thread: keeps all stems sample-locked,
                    loops, and time-stretches with SoundTouch for speed/key changes
server/    the stem server
  app.py                     FastAPI: YouTube download (yt-dlp) → Demucs → MP3 stems, job queue with progress
  Start MinusOne Server.bat  Windows one-click launcher (runs start-windows.ps1)
  start-windows.ps1          installs everything, starts the server and a Cloudflare tunnel, opens the site
.github/workflows/
  pages.yml         publishes site/ to GitHub Pages
```

**Server API:** `GET /api/health`, `POST /api/split {"url": …}`, `POST /api/upload` (file),
`GET /api/jobs/{id}`, `GET /api/stems/{id}/{stem}.mp3`.

**Server settings** (environment variables): `MAX_MINUTES` (default 10; the Windows launcher uses 15),
`MAX_SONGS` (40), `DEMUCS_MODEL` (`htdemucs_6s`; `htdemucs` gives 4 stems, slightly faster),
`ACCESS_KEY` (require a password), `YT_COOKIES` (Netscape cookies if YouTube blocks the server),
`ALLOWED_ORIGINS`, `DATA_DIR`.

**Run the server by hand** (Mac/Linux, or without the launcher):

```bash
cd server
pip install torch -r requirements.txt     # also needs ffmpeg on PATH
uvicorn app:app --port 7860
cloudflared tunnel --url http://localhost:7860   # optional: reach it from other devices
```

Then open `https://suniljonny80.github.io/MinusOne/?server=<the tunnel address>`.

**Try the website locally:** `cd site && python -m http.server 8080`, then open http://localhost:8080.

## Credits

- [Demucs](https://github.com/adefossez/demucs) by Alexandre Défossez / Meta AI (MIT), for source separation
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (Unlicense), for downloading audio
- [SoundTouchJS](https://github.com/cutterbl/SoundTouchJS) (LGPL-2.1, in `site/vendor/`), for tempo and pitch
- Fonts: [Archivo](https://fonts.google.com/specimen/Archivo) and [Permanent Marker](https://fonts.google.com/specimen/Permanent+Marker) (SIL Open Font License)
