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
([Demucs](https://github.com/adefossez/demucs) `htdemucs_6s`) runs on a free **Hugging Face Space**.

---

## Set it up (one time, about 15 minutes)

### 1. Create the free stem server

1. Make a free account at [huggingface.co](https://huggingface.co/join).
2. Create an access token: **Settings → Access Tokens → Create new token**, type **Write**. Copy it.
3. In this GitHub repository open **Settings → Secrets and variables → Actions**:
   - **Secrets** tab → *New repository secret* → name `HF_TOKEN`, value: the token.
   - **Variables** tab → *New repository variable* → name `HF_SPACE`,
     value: `your-hf-username/minusone`.
4. Open the **Actions** tab → **Deploy stem server** → **Run workflow**.

The workflow creates the Space and uploads the server. Hugging Face then builds it, which takes about
10 minutes the first time. Follow along at `https://huggingface.co/spaces/your-hf-username/minusone`.

### 2. Publish the website

1. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. **Actions → Publish website → Run workflow**.

Your site is live at `https://<your-github-username>.github.io/<repo-name>/`. It is automatically
connected to your Space. (You can also change the server any time with the status button at the top
right of the site.)

---

## Good to know

**Speed.** The free Space has 2 CPU cores, so splitting takes roughly as long as the song itself
(a 4-minute song ≈ 4–6 minutes). Each song is only split once: the server keeps the last 40 songs and
your browser keeps your songs, so opening them again is instant.

**Sleeping.** A free Space goes to sleep after 48 hours without use. The site wakes it up
automatically; the first song after a long break waits an extra minute or two.

**YouTube blocking.** YouTube sometimes refuses downloads from cloud servers ("Sign in to confirm
you're not a bot"). When that happens you can:
- upload the audio file instead (always works), or
- give the server your YouTube cookies: install a "Get cookies.txt" browser extension, export
  cookies for youtube.com while signed in, and save the file's contents as a repository secret named
  `YT_COOKIES`, then run **Deploy stem server** again. Use a spare Google account for this.

**Keeping it private.** Anyone who knows your Space address could use it. To lock it, add a
repository secret `SPACE_ACCESS_KEY` (any password), run **Deploy stem server** again, and enter the
same key in the site's server settings on each of your devices.

**Use it fairly.** MinusOne is for personal practice. Only split music you have the right to use, and
respect YouTube's terms.

---

## How it works

```
site/      the website (GitHub Pages): plain HTML, CSS and JavaScript, no build step
  app.js            screens, server connection, song library (IndexedDB), mixer controls
  engine.js         loads stems, transport, WAV export
  mixer-worklet.js  real-time mixer on the audio thread: keeps all stems sample-locked,
                    loops, and time-stretches with SoundTouch for speed/key changes
server/    the stem server (Hugging Face Space, Docker)
  app.py            FastAPI: YouTube download (yt-dlp) → Demucs → MP3 stems, job queue with progress
.github/workflows/
  pages.yml         publishes site/ to GitHub Pages and points it at your Space
  space.yml         creates/updates the Hugging Face Space from server/
```

**Server API:** `GET /api/health`, `POST /api/split {"url": …}`, `POST /api/upload` (file),
`GET /api/jobs/{id}`, `GET /api/stems/{id}/{stem}.mp3`.

**Server settings** (Space → Settings → Variables and secrets): `MAX_MINUTES` (default 10),
`MAX_SONGS` (40), `DEMUCS_MODEL` (`htdemucs_6s`; `htdemucs` gives 4 stems, slightly faster),
`ACCESS_KEY`, `YT_COOKIES`, `ALLOWED_ORIGINS`.

**Run the server on your own computer instead** (faster with a good CPU or an NVIDIA GPU):

```bash
cd server
pip install torch -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 7860
```

Then set the site's server address to `http://<your-computer-ip>:7860`.

**Try the website locally:** `cd site && python -m http.server 8080`, then open http://localhost:8080.

## Credits

- [Demucs](https://github.com/adefossez/demucs) by Alexandre Défossez / Meta AI (MIT), for source separation
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (Unlicense), for downloading audio
- [SoundTouchJS](https://github.com/cutterbl/SoundTouchJS) (LGPL-2.1, in `site/vendor/`), for tempo and pitch
- Fonts: [Archivo](https://fonts.google.com/specimen/Archivo) and [Permanent Marker](https://fonts.google.com/specimen/Permanent+Marker) (SIL Open Font License)
