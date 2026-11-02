"""
MinusOne separation server.

Takes a YouTube link (or an uploaded audio file), downloads the audio with yt-dlp,
splits it into stems with Demucs (htdemucs_6s: vocals, drums, bass, guitar, piano, other)
and serves the stems as MP3 files to the MinusOne website.

Built to run free on a Hugging Face Space (Docker, CPU basic), but runs anywhere:
    uvicorn app:app --host 0.0.0.0 --port 7860

Environment variables (all optional):
    DEMUCS_MODEL     Demucs model name (default htdemucs_6s)
    MAX_MINUTES      Longest song accepted (default 10)
    MAX_UPLOAD_MB    Largest upload accepted (default 80)
    MAX_SONGS        Finished songs kept on disk before the oldest are deleted (default 40)
    ALLOWED_ORIGINS  Comma-separated origins allowed to call the API (default *)
    ACCESS_KEY       If set, requests must send this key (header X-Access-Key)
    YT_COOKIES       Netscape-format YouTube cookies, used when YouTube blocks the server
    DATA_DIR         Where songs are stored (default /tmp/minusone)
    MOCK_SEPARATOR   1 = fake the separation with ffmpeg filters (for testing without Demucs)
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

# ---------------------------------------------------------------- settings

MODEL = os.environ.get("DEMUCS_MODEL", "htdemucs_6s")
MAX_SECONDS = int(float(os.environ.get("MAX_MINUTES", "10")) * 60)
MAX_UPLOAD = int(float(os.environ.get("MAX_UPLOAD_MB", "80")) * 1024 * 1024)
MAX_SONGS = int(os.environ.get("MAX_SONGS", "40"))
ACCESS_KEY = os.environ.get("ACCESS_KEY", "").strip()
MOCK = os.environ.get("MOCK_SEPARATOR", "") == "1"
DATA = Path(os.environ.get("DATA_DIR") or (Path(__file__).resolve().parent / "data"))
SONGS = DATA / "songs"
WORK = DATA / "work"
for d in (SONGS, WORK):
    d.mkdir(parents=True, exist_ok=True)

COOKIE_FILE = None
if os.environ.get("YT_COOKIES", "").strip():
    COOKIE_FILE = DATA / "cookies.txt"
    COOKIE_FILE.write_text(os.environ["YT_COOKIES"].strip() + "\n")

# Demucs stem name -> what the website calls it (order = channel order on the mixer)
STEMS = [("vocals", "vocals"), ("drums", "drums"), ("bass", "bass"),
         ("guitar", "guitar"), ("piano", "keys"), ("other", "other")]
if MODEL != "htdemucs_6s":                      # 4-stem models have no guitar/piano
    STEMS = [s for s in STEMS if s[0] not in ("guitar", "piano")]

YT_ID = re.compile(r"(?:youtube\.com/(?:watch\?(?:.*&)?v=|shorts/|embed/|live/|v/)|youtu\.be/|music\.youtube\.com/watch\?(?:.*&)?v=)([A-Za-z0-9_-]{11})")

# ---------------------------------------------------------------- device (GPU or CPU)

DEVICE = {"name": "checking", "gpu": False, "kind": "cpu"}


RUNNER = Path(__file__).resolve().parent / "split_runner.py"


def detect_device():
    """Find the fastest device for Demucs: NVIDIA (CUDA), then any DirectX 12 GPU (DirectML), then CPU.
    Each check runs in a separate process because a PyTorch build can't be unloaded once loaded."""
    if MOCK:
        DEVICE.update(name="test mode", gpu=False, kind="cpu")
        return
    notes = []
    for kind in ("cuda", "dml"):
        try:
            out = subprocess.run([sys.executable, str(RUNNER), "--detect", kind], capture_output=True,
                                 text=True, timeout=240).stdout.strip().splitlines()
            info = json.loads(out[-1]) if out else {}
        except Exception as e:
            info = {"kind": "none", "error": str(e)[:200]}
        if info.get("kind") == kind:
            DEVICE.update(name=info.get("name") or kind.upper(), gpu=True, kind=kind,
                          index=info.get("index"))
            print("Demucs device:", DEVICE, flush=True)
            return
        if info.get("error"):
            notes.append(f"{kind}: {info['error']}")
    DEVICE.update(name="processor (CPU)", gpu=False, kind="cpu", notes=notes)
    print("Demucs device:", DEVICE, flush=True)


threading.Thread(target=detect_device, daemon=True).start()

# ---------------------------------------------------------------- jobs

jobs = {}                      # id -> dict
queue = deque()
lock = threading.Lock()
wake = threading.Event()


def song_dir(song_id):
    return SONGS / song_id


def meta_path(song_id):
    return song_dir(song_id) / "meta.json"


def is_finished(song_id):
    p = meta_path(song_id)
    if not p.is_file():
        return False
    meta = json.loads(p.read_text())
    return all((song_dir(song_id) / f"{web}.mp3").is_file() for _, web in meta.get("stems_raw", STEMS))


def public_job(job, request: Optional[Request] = None):
    out = {k: job.get(k) for k in ("id", "status", "stage", "progress", "title", "duration",
                                   "source", "youtube_id", "error", "model")}
    out["device"] = DEVICE["name"]
    out["gpu"] = DEVICE["gpu"]
    out["accel"] = DEVICE.get("kind")
    out["engine"] = job.get("engine")
    out["cloud_model"] = job.get("cloud_model")
    out["cloud_error"] = job.get("cloud_error")
    if job["status"] == "queued":
        with lock:
            ids = [j for j in queue]
        out["queue_position"] = ids.index(job["id"]) + 1 if job["id"] in ids else 0
    if job["status"] == "done":
        out["stems"] = [{"name": web, "url": f"/api/stems/{job['id']}/{web}.mp3"} for _, web in STEMS]
    return out


def load_finished(song_id):
    meta = json.loads(meta_path(song_id).read_text())
    meta.update(status="done", stage="Ready", progress=100, error=None)
    return meta


def new_job(song_id, **fields):
    job = {"id": song_id, "status": "queued", "stage": "Waiting in line", "progress": 0,
           "title": None, "duration": None, "error": None, "model": MODEL,
           "created": time.time(), **fields}
    with lock:
        jobs[song_id] = job
        queue.append(song_id)
    wake.set()
    return job


def update(job, **fields):
    with lock:
        job.update(fields)


# ---------------------------------------------------------------- download

class FriendlyError(Exception):
    pass


def ydl_opts(extra=None):
    opts = {"quiet": True, "no_warnings": True, "noplaylist": True, "socket_timeout": 30,
            "retries": 3}
    if COOKIE_FILE:
        opts["cookiefile"] = str(COOKIE_FILE)
    if extra:
        opts.update(extra)
    return opts


def explain_youtube_error(err):
    msg = str(err)
    low = msg.lower()
    if "sign in to confirm" in low or "not a bot" in low:
        return ("YouTube blocked the server from downloading this video. Upload the audio file instead, "
                "or add YouTube cookies to the server (see the setup guide).")
    if "private video" in low:
        return "This video is private."
    if "age" in low and ("restrict" in low or "confirm your age" in low):
        return "This video is age-restricted. Upload the audio file instead."
    if "unavailable" in low or "not available" in low:
        return "This video is unavailable in the server's region or has been removed."
    if "live event" in low or "is live" in low:
        return "Live streams can't be split. Try again once the stream has ended."
    return "YouTube download failed: " + msg.splitlines()[-1][:200]


def download_youtube(job, video_id, dest):
    import yt_dlp
    url = f"https://www.youtube.com/watch?v={video_id}"
    try:
        with yt_dlp.YoutubeDL(ydl_opts()) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as e:
        raise FriendlyError(explain_youtube_error(e))
    if info.get("is_live"):
        raise FriendlyError("Live streams can't be split. Try again once the stream has ended.")
    duration = info.get("duration") or 0
    if duration and duration > MAX_SECONDS:
        raise FriendlyError(f"This video is {duration // 60} minutes long. The limit is "
                            f"{MAX_SECONDS // 60} minutes.")
    update(job, title=info.get("title"), duration=duration, artist=info.get("uploader"))

    def hook(d):
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            if total:
                update(job, progress=round(min(99, d.get("downloaded_bytes", 0) * 100 / total)))

    out_tmpl = str(dest / "source.%(ext)s")
    try:
        with yt_dlp.YoutubeDL(ydl_opts({"format": "bestaudio/best", "outtmpl": out_tmpl,
                                        "progress_hooks": [hook]})) as ydl:
            ydl.download([url])
    except Exception as e:
        raise FriendlyError(explain_youtube_error(e))
    files = [p for p in dest.glob("source.*") if p.suffix not in (".part", ".ytdl")]
    if not files:
        raise FriendlyError("YouTube download finished but no audio file was found.")
    return files[0]


# ---------------------------------------------------------------- separation

def run(cmd, **kw):
    return subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kw)


def to_wav(src, dst, limit=MAX_SECONDS):
    """Normalise any input to 44.1 kHz stereo WAV (also enforces the length limit)."""
    try:
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-t", str(limit),
             "-vn", "-ac", "2", "-ar", "44100", str(dst)])
    except subprocess.CalledProcessError as e:
        raise FriendlyError("That file couldn't be read as audio. Try an MP3, WAV, M4A or FLAC file.") from e
    try:
        import wave
        with wave.open(str(dst), "rb") as w:
            return w.getnframes() / float(w.getframerate())
    except Exception:
        return None


def separate_demucs(job, wav, outdir):
    kind = DEVICE.get("kind", "cpu")
    cmd = [sys.executable, str(RUNNER), "--accel", kind, "--", "-n", MODEL, "--mp3", "--mp3-bitrate", "256",
           "--filename", "{stem}.{ext}", "-o", str(outdir), str(wav)]
    if kind == "dml":
        cmd[5:5] = ["--overlap", "0.15"]         # integrated GPUs: a little less overlap, ~10% faster
    if not DEVICE["gpu"]:
        cmd[5:5] = ["--overlap", "0.1"]          # CPU only: less overlap between chunks, ~15% faster
        if (os.cpu_count() or 1) >= 4:
            cmd[5:5] = ["-j", "2"]               # and process two chunks in parallel
    threads = os.cpu_count() or 2
    env = dict(os.environ, OMP_NUM_THREADS=str(threads), MKL_NUM_THREADS=str(threads))
    if DEVICE.get("index") is not None:
        env["MINUSONE_DML_INDEX"] = str(DEVICE["index"])
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env)
    pct = re.compile(rb"(\d{1,3})%\|")
    tail = deque(maxlen=30)
    buf = b""
    while True:
        chunk = proc.stdout.read(256)
        if not chunk:
            break
        buf += chunk
        parts = re.split(rb"[\r\n]", buf)
        buf = parts.pop()
        for line in parts:
            if line.strip():
                tail.append(line.decode(errors="ignore"))
            m = pct.search(line)
            if m:
                update(job, progress=min(99, int(m.group(1))))
    if proc.wait() != 0:
        raise RuntimeError("Demucs failed:\n" + "\n".join(tail))
    folder = outdir / MODEL.replace("hf://", "").replace("/", "_")
    return {name: folder / f"{name}.mp3" for name, _ in STEMS}


def separate_mock(job, wav, outdir):
    """Stand-in for Demucs: band-split the song with ffmpeg so every stem is audibly different."""
    filters = {"vocals": "bandpass=f=1500:width_type=o:w=1.5", "drums": "highpass=f=4000",
               "bass": "lowpass=f=180", "guitar": "bandpass=f=700:width_type=o:w=1",
               "piano": "bandpass=f=2500:width_type=o:w=1", "other": "volume=0.3"}
    folder = outdir / "mock"
    folder.mkdir(parents=True, exist_ok=True)
    out = {}
    for i, (name, _) in enumerate(STEMS):
        dst = folder / f"{name}.mp3"
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-af", filters[name],
             "-b:a", "256k", str(dst)])
        out[name] = dst
        update(job, progress=round((i + 1) * 100 / len(STEMS)))
        time.sleep(0.3)
    return out


# ---------------------------------------------------------------- splitting engines & settings
#   local  = Demucs on this computer (NVIDIA GPU when available, otherwise the processor)
#   cloud  = MVSEP (mvsep.com) cloud GPUs with the user's free API key; this PC does almost nothing
#   auto   = local on an NVIDIA GPU, cloud when there is no GPU but a key and internet, else local

SETTINGS_PATH = DATA / "settings.json"
MVSEP_API = os.environ.get("MVSEP_API", "https://mvsep.com/api").rstrip("/")
CLOUD_MODELS = [   # tried in order; both give vocals, drums, bass, guitar, piano, other
    {"sep_type": "63", "label": "BS-RoFormer SW"},
    {"sep_type": "20", "add_opt1": "2", "label": "Demucs 6-stem"},
]


def load_settings():
    try:
        return {"engine": "auto", "mvsep_token": "", **json.loads(SETTINGS_PATH.read_text())}
    except Exception:
        return {"engine": "auto", "mvsep_token": ""}


SETTINGS = load_settings()


def save_settings():
    SETTINGS_PATH.write_text(json.dumps(SETTINGS))


def cloud_token():
    return (os.environ.get("MVSEP_TOKEN", "") or SETTINGS.get("mvsep_token", "")).strip()


def online():
    import socket
    from urllib.parse import urlparse
    u = urlparse(MVSEP_API)
    try:
        socket.create_connection((u.hostname, u.port or (443 if u.scheme == "https" else 80)), timeout=4).close()
        return True
    except OSError:
        return False


def choose_engine(wait=True):
    pref = SETTINGS.get("engine", "auto")
    if pref == "local":
        return "local"
    if pref == "cloud":
        return "cloud" if cloud_token() else "local"
    if wait:                                    # auto: need to know whether there is a GPU first
        for _ in range(120):
            if DEVICE["name"] != "checking":
                break
            time.sleep(0.5)
    if DEVICE["gpu"]:
        return "local"
    if cloud_token() and (not wait or online()):
        return "cloud"
    return "local"


STEM_WORDS = [("drums", r"drum"), ("bass", r"bass"), ("guitar", r"guitar"), ("piano", r"piano|keys|keyboard"),
              ("other", r"other"), ("vocals", r"vocal|voice|sing")]


def match_stem(text):
    t = text.lower()
    if re.search(r"instrum|no[_ -]?vocal|karaoke|backing", t):
        return None
    for name, pat in STEM_WORDS:
        if re.search(pat, t):
            return name
    return None


def separate_cloud(job, wav, outdir):
    import requests
    from urllib.parse import unquote, urlparse
    token = cloud_token()
    outdir.mkdir(parents=True, exist_ok=True)
    mp3 = outdir / "upload.mp3"
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-b:a", "320k", str(mp3)])
    update(job, stage="Sending the song to the cloud splitter", progress=2)

    hash_, used, last = None, None, ""
    for model in CLOUD_MODELS:
        data = {"api_token": token, "sep_type": model["sep_type"], "output_format": "0"}
        if "add_opt1" in model:
            data["add_opt1"] = model["add_opt1"]
        try:
            with open(mp3, "rb") as f:
                r = requests.post(f"{MVSEP_API}/separation/create", data=data,
                                  files={"audiofile": ("song.mp3", f, "audio/mpeg")}, timeout=600)
            j = r.json()
        except requests.RequestException as e:
            raise FriendlyError(f"Couldn't reach the cloud splitter ({e.__class__.__name__}).")
        except ValueError:
            raise FriendlyError(f"The cloud splitter answered with an error ({r.status_code}).")
        if j.get("success"):
            hash_, used = j["data"]["hash"], model
            break
        last = str((j.get("data") or {}).get("message") or j.get("message") or j)[:200]
        if re.search(r"token|api key|unauthor|not.*registered|login", last, re.I):
            raise FriendlyError("MVSEP didn't accept your key. Check it in Splitting settings.")
    if not hash_:
        raise FriendlyError("The cloud splitter refused this song: " + last)
    update(job, cloud_model=used["label"], model="cloud: " + used["label"],
           stage="Waiting in the cloud splitter's queue", progress=5)

    t0 = started = time.time()
    while True:
        time.sleep(4)
        try:
            g = requests.get(f"{MVSEP_API}/separation/get", params={"hash": hash_}, timeout=60).json()
        except Exception:
            if time.time() - t0 > 3600:
                raise FriendlyError("Lost contact with the cloud splitter.")
            continue
        d = g.get("data") or {}
        status = (g.get("status") or d.get("status") or "").lower()
        if status == "done":
            files = d.get("files") or []
            break
        if status in ("failed", "not_found", "error"):
            raise FriendlyError("The cloud splitter couldn't split this song" +
                                (": " + str(d.get("message"))[:150] if d.get("message") else "."))
        if status == "waiting":
            started = time.time()
            update(job, stage="Waiting in the cloud splitter's queue", progress=5)
        else:   # processing / distributing / merging
            elapsed = time.time() - started
            update(job, stage=f"Splitting on the cloud GPUs ({used['label']})",
                   progress=min(95, 10 + int(elapsed * 1.5)))
        if time.time() - t0 > 3 * 3600:
            raise FriendlyError("The cloud splitter is taking too long. Try again later.")

    update(job, stage="Downloading the instruments from the cloud", progress=96)
    out = {}
    for f in files:
        if isinstance(f, dict):
            url = f.get("url") or f.get("download") or f.get("link") or ""
            label = " ".join(str(f.get(k, "")) for k in ("type", "name", "download"))
        else:
            url, label = str(f), ""
        if not url.startswith("http"):
            continue
        stem = match_stem(label + " " + unquote(urlparse(url).path.rsplit("/", 1)[-1]))
        if not stem or stem in out:
            continue
        dst = outdir / f"{stem}.mp3"
        with requests.get(url, stream=True, timeout=300) as resp:
            resp.raise_for_status()
            with open(dst, "wb") as fh:
                for chunk in resp.iter_content(1 << 16):
                    fh.write(chunk)
        out[stem] = dst
    if not out:
        raise FriendlyError("The cloud splitter finished but returned no instruments.")
    for name, _ in STEMS:                       # any part the model didn't produce: silent track
        if name not in out:
            dst = outdir / f"{name}.mp3"
            run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
                 "-t", str(job.get("duration") or 1), "-b:a", "64k", str(dst)])
            out[name] = dst
    return out


def process(job):
    sid = job["id"]
    work = WORK / sid
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    try:
        if job.get("youtube_id"):
            update(job, status="downloading", stage="Downloading audio from YouTube", progress=0)
            src = download_youtube(job, job["youtube_id"], work)
        else:
            src = Path(job["upload_path"])
        update(job, status="preparing", stage="Preparing audio", progress=0)
        wav = work / "mix.wav"
        dur = to_wav(src, wav)
        if dur and not job.get("duration"):
            update(job, duration=round(dur))

        engine = choose_engine()
        update(job, status="separating", stage="Splitting into instruments", progress=0, engine=engine)
        stems = None
        if engine == "cloud":
            try:
                stems = separate_cloud(job, wav, work / "cloud")
            except FriendlyError as e:
                print("cloud split failed, using this PC:", e, flush=True)
                update(job, engine="local", progress=0, cloud_error=str(e),
                       stage="Cloud splitter unavailable (" + str(e)[:80] + "). Splitting on this PC instead")
        if stems is None:
            update(job, engine="local")
            stems = (separate_mock if MOCK else separate_demucs)(job, wav, work / "out")

        update(job, status="saving", stage="Saving stems", progress=100)
        final = song_dir(sid)
        tmp = SONGS / (sid + ".tmp")
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir()
        for name, web in STEMS:
            shutil.move(str(stems[name]), tmp / f"{web}.mp3")
        meta = {k: job.get(k) for k in ("id", "title", "duration", "artist", "source", "youtube_id", "model")}
        meta["stems_raw"] = STEMS
        meta["finished"] = time.time()
        (tmp / "meta.json").write_text(json.dumps(meta))
        shutil.rmtree(final, ignore_errors=True)
        tmp.rename(final)
        update(job, status="done", stage="Ready", progress=100)
        prune()
    except FriendlyError as e:
        update(job, status="error", stage="Failed", error=str(e))
    except Exception as e:
        print("JOB FAILED", sid, repr(e), file=sys.stderr, flush=True)
        update(job, status="error", stage="Failed",
               error="Separation failed on the server. " + str(e).splitlines()[0][:200])
    finally:
        shutil.rmtree(work, ignore_errors=True)
        if job.get("upload_path"):
            shutil.rmtree(Path(job["upload_path"]).parent, ignore_errors=True)


def prune():
    done = sorted((p for p in SONGS.iterdir() if p.is_dir() and (p / "meta.json").is_file()),
                  key=lambda p: p.stat().st_mtime, reverse=True)
    for old in done[MAX_SONGS:]:
        shutil.rmtree(old, ignore_errors=True)


def worker():
    while True:
        wake.wait()
        with lock:
            sid = queue.popleft() if queue else None
            if not queue:
                wake.clear()
        if sid:
            process(jobs[sid])


threading.Thread(target=worker, daemon=True).start()

# ---------------------------------------------------------------- API

app = FastAPI(title="MinusOne separation server")
origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST"],
                   allow_headers=["*"], max_age=3600)


def check_key(key):
    if ACCESS_KEY and key != ACCESS_KEY:
        raise HTTPException(401, "This server needs an access key. Add it in the website's server settings.")


class SplitRequest(BaseModel):
    url: str


@app.get("/")
def root():
    return {"name": "MinusOne separation server", "model": MODEL, "health": "/api/health"}


@app.get("/api/health")
def health(x_access_key: str = Header(default="")):
    with lock:
        busy = sum(1 for j in jobs.values() if j["status"] not in ("done", "error", "queued"))
        waiting = len(queue)
    return {"ok": True, "model": MODEL, "stems": [w for _, w in STEMS], "busy": busy, "queued": waiting,
            "max_minutes": MAX_SECONDS // 60, "needs_key": bool(ACCESS_KEY),
            "key_ok": (not ACCESS_KEY) or x_access_key == ACCESS_KEY, "mock": MOCK,
            "device": DEVICE["name"], "gpu": DEVICE["gpu"], "accel": DEVICE.get("kind"),
            "engine_pref": SETTINGS.get("engine", "auto"), "cloud_key": bool(cloud_token()),
            "will_use": choose_engine(wait=False) if DEVICE["name"] != "checking" else "checking"}


class SettingsRequest(BaseModel):
    engine: Optional[str] = None
    mvsep_token: Optional[str] = None


@app.get("/api/settings")
def get_settings(x_access_key: str = Header(default="")):
    check_key(x_access_key)
    tok = cloud_token()
    return {"engine": SETTINGS.get("engine", "auto"), "cloud_key": bool(tok),
            "key_hint": ("…" + tok[-4:]) if len(tok) >= 4 else "", "device": DEVICE["name"], "gpu": DEVICE["gpu"]}


@app.post("/api/settings")
def set_settings(req: SettingsRequest, x_access_key: str = Header(default="")):
    check_key(x_access_key)
    if req.engine is not None:
        if req.engine not in ("auto", "local", "cloud"):
            raise HTTPException(400, "Unknown splitting choice.")
        SETTINGS["engine"] = req.engine
    if req.mvsep_token is not None:
        SETTINGS["mvsep_token"] = req.mvsep_token.strip()
    save_settings()
    return get_settings(x_access_key)


@app.post("/api/split")
def split(req: SplitRequest, x_access_key: str = Header(default="")):
    check_key(x_access_key)
    m = YT_ID.search(req.url.strip())
    if not m:
        raise HTTPException(400, "That doesn't look like a YouTube link. Paste a link like "
                                 "https://www.youtube.com/watch?v=… or https://youtu.be/…")
    vid = m.group(1)
    sid = f"yt-{vid}-{MODEL}"
    if is_finished(sid):
        return public_job(load_finished(sid))
    with lock:
        job = jobs.get(sid)
    if job and job["status"] not in ("error", "done"):
        return public_job(job)
    job = new_job(sid, source="youtube", youtube_id=vid)
    return public_job(job)


@app.post("/api/upload")
async def upload(file: UploadFile = File(...), x_access_key: str = Header(default="")):
    check_key(x_access_key)
    tmpdir = WORK / ("up-" + uuid.uuid4().hex)
    tmpdir.mkdir(parents=True)
    path = tmpdir / ("upload" + Path(file.filename or "song").suffix[:8])
    h = hashlib.sha1()
    size = 0
    with open(path, "wb") as f:
        while True:
            chunk = await file.read(1 << 20)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_UPLOAD:
                shutil.rmtree(tmpdir, ignore_errors=True)
                raise HTTPException(413, f"That file is over {MAX_UPLOAD // (1024 * 1024)} MB.")
            h.update(chunk)
            f.write(chunk)
    sid = f"up-{h.hexdigest()[:16]}-{MODEL}"
    if is_finished(sid):
        shutil.rmtree(tmpdir, ignore_errors=True)
        return public_job(load_finished(sid))
    with lock:
        job = jobs.get(sid)
    if job and job["status"] not in ("error", "done"):
        shutil.rmtree(tmpdir, ignore_errors=True)
        return public_job(job)
    title = Path(file.filename or "Uploaded song").stem.replace("_", " ")
    job = new_job(sid, source="upload", upload_path=str(path), title=title)
    return public_job(job)


@app.get("/api/jobs/{sid}")
def job_status(sid: str):
    with lock:
        job = jobs.get(sid)
    if job:
        return public_job(job)
    if re.fullmatch(r"[\w.-]+", sid) and is_finished(sid):
        return public_job(load_finished(sid))
    raise HTTPException(404, "This song isn't on the server any more. Split it again.")


@app.get("/api/stems/{sid}/{name}.mp3")
def stem(sid: str, name: str):
    if not re.fullmatch(r"[\w.-]+", sid) or name not in [w for _, w in STEMS]:
        raise HTTPException(404, "Unknown stem.")
    path = song_dir(sid) / f"{name}.mp3"
    if not path.is_file():
        raise HTTPException(404, "This song isn't on the server any more. Split it again.")
    return FileResponse(path, media_type="audio/mpeg",
                        headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.exception_handler(HTTPException)
async def http_error(request, exc):
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)
