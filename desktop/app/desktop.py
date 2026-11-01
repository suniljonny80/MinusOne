"""
MinusOne desktop app (portable, runs from a USB stick).

Started by MinusOne.exe with the portable Python in ..\\runtime. It:
  1. starts the stem server on 127.0.0.1 (same server as the website uses),
  2. serves the MinusOne screens from the same address,
  3. opens them in a native app window (Microsoft Edge WebView2).

Everything is kept next to the exe, so the USB can be moved between PCs:
  data\\      songs library (window storage) and server cache
  models\\    the Demucs AI model
  Exports\\   mixes you save
"""
import importlib.util
import os
import socket
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path

APP = Path(__file__).resolve().parent          # <usb>\MinusOne\app
ROOT = APP.parent                              # <usb>\MinusOne
RUNTIME = ROOT / "runtime"
DATA = ROOT / "data"
MODELS = ROOT / "models"
EXPORTS = ROOT / "Exports"
PORT = 47860                                   # fixed, so the window's saved songs stay attached to it

for d in (DATA, MODELS, EXPORTS):
    d.mkdir(parents=True, exist_ok=True)

# pythonw has no console: send output to a log file on the USB
if sys.stdout is None or sys.stderr is None or "pythonw" in Path(sys.executable).name.lower():
    log = open(DATA / "minusone.log", "a", encoding="utf-8", buffering=1)
    sys.stdout = sys.stderr = log
print(f"\n=== MinusOne starting {time.ctime()} from {ROOT}", flush=True)


def message_box(text, title="MinusOne", flags=0x40):
    if os.name == "nt":
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, str(text), title, flags)
    else:
        print(title, text)


# Child programs (ffmpeg, demucs, deno) must not flash console windows.
if os.name == "nt":
    _Popen = subprocess.Popen

    class _QuietPopen(_Popen):
        def __init__(self, *args, **kwargs):
            kwargs["creationflags"] = kwargs.get("creationflags", 0) | 0x08000000  # CREATE_NO_WINDOW
            super().__init__(*args, **kwargs)

    subprocess.Popen = _QuietPopen

# Portable environment: everything relative to the USB
os.environ["PATH"] = os.pathsep.join([str(RUNTIME / "Scripts"), str(RUNTIME / "bin"), str(RUNTIME),
                                      os.environ.get("PATH", "")])
os.environ.setdefault("DATA_DIR", str(DATA / "server"))
os.environ.setdefault("HF_HOME", str(MODELS / "hf"))
os.environ.setdefault("TORCH_HOME", str(MODELS / "torch"))
os.environ.setdefault("DEMUCS_MODEL", "htdemucs_6s")
os.environ.setdefault("MAX_MINUTES", "15")
os.environ.setdefault("PYTHONIOENCODING", "utf-8")
if (MODELS / "hf").is_dir() and any((MODELS / "hf").rglob("*.safetensors")):
    os.environ.setdefault("HF_HUB_OFFLINE", "1")   # model already on the USB: never wait for the network


def port_in_use(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def build_app():
    from fastapi import Request
    from fastapi.responses import JSONResponse, Response
    from fastapi.staticfiles import StaticFiles

    spec = importlib.util.spec_from_file_location("minusone_server", APP / "server" / "app.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    api = mod.app
    state = {"last_seen": time.time()}

    @api.middleware("http")
    async def seen(request, call_next):
        state["last_seen"] = time.time()
        return await call_next(request)

    @api.get("/config.js")
    def config_js():
        js = ("window.MINUSONE_CONFIG = { server: window.location.origin, desktop: true, repo: '' };\n")
        return Response(js, media_type="application/javascript", headers={"Cache-Control": "no-store"})

    @api.post("/api/export")
    async def export(request: Request, name: str = "MinusOne mix.wav"):
        safe = "".join(c for c in name if c not in '\\/:*?"<>|').strip() or "MinusOne mix.wav"
        if not safe.lower().endswith(".wav"):
            safe += ".wav"
        target = EXPORTS / safe
        stem, n = target.stem, 2
        while target.exists():
            target = EXPORTS / f"{stem} ({n}).wav"
            n += 1
        target.write_bytes(await request.body())
        if os.name == "nt":
            try:
                subprocess.Popen(["explorer", "/select,", str(target)])
            except Exception:
                pass
        return JSONResponse({"saved": str(target), "folder": "Exports", "name": target.name})

    # the server's own "/" status page would hide the app's main screen
    api.router.routes[:] = [r for r in api.router.routes if getattr(r, "path", None) != "/"]
    api.mount("/", StaticFiles(directory=str(APP / "site"), html=True), name="site")
    return api, state


def update_ytdlp_in_background():
    """YouTube changes often. Refresh yt-dlp at most once a week, quietly, if online."""
    stamp = DATA / "ytdlp-updated.txt"
    try:
        if stamp.exists() and time.time() - stamp.stat().st_mtime < 7 * 86400:
            return
        socket.create_connection(("pypi.org", 443), timeout=3).close()
    except OSError:
        return

    def run():
        py = RUNTIME / "python.exe"
        if not py.exists():
            return
        r = subprocess.run([str(py), "-m", "pip", "install", "-q", "-U", "yt-dlp[default]"],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=600)
        if r.returncode == 0:
            stamp.write_text(time.ctime())
    threading.Thread(target=run, daemon=True).start()


def kill_children_and_exit():
    if os.name == "nt":
        # end any running separation (demucs/ffmpeg) along with this process
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(os.getpid())],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os._exit(0)


def main():
    if port_in_use(PORT):
        message_box("MinusOne is already open on this PC.\n\nLook for its window on the taskbar.")
        return
    port = PORT
    import uvicorn
    api, state = build_app()
    server = uvicorn.Server(uvicorn.Config(api, host="127.0.0.1", port=port, log_level="warning",
                                           access_log=False, log_config=None))
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(200):
        if server.started:
            break
        time.sleep(0.05)
    url = f"http://127.0.0.1:{port}/"
    print("serving", url, flush=True)
    update_ytdlp_in_background()

    if os.environ.get("MINUSONE_NO_WINDOW") == "1":      # testing without a GUI
        while True:
            time.sleep(3600)

    try:
        import webview
        webview.create_window("MinusOne", url, width=1320, height=880, min_size=(860, 620),
                              background_color="#22262A", text_select=False)
        icon = APP / "minusone.ico"
        webview.start(private_mode=False, storage_path=str(DATA / "window"),
                      icon=str(icon) if icon.exists() else None)
    except Exception:
        # No WebView2 on this PC: fall back to the default browser and stay alive while it is used.
        print("window failed, using browser:\n" + traceback.format_exc(), flush=True)
        import webbrowser
        webbrowser.open(url)
        while time.time() - state["last_seen"] < 30 * 60:
            time.sleep(15)
    kill_children_and_exit()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        tb = traceback.format_exc()
        print(tb, flush=True)
        message_box("MinusOne couldn't start.\n\n" + tb[-1500:] +
                    "\n\nIf this keeps happening, run 'Set up USB.bat' again.", flags=0x10)
        os._exit(1)
