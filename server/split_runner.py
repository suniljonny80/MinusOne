"""
Runs Demucs on the best device this PC has:
  cuda  NVIDIA GPU (needs the CUDA build of PyTorch; on the USB it lives in runtime/cuda)
  dml   any DirectX 12 graphics via DirectML: Intel UHD/Iris/Arc, AMD Radeon, NVIDIA
  cpu   the processor

    python split_runner.py --detect cuda|dml           -> prints {"kind": ..., "name": ...}
    python split_runner.py --accel dml -- <demucs args> -> runs `demucs` on that device
    python split_runner.py --serve MODEL [--no-cuda]    -> warm worker (see serve() below)

DirectML can't do complex-number maths, which Demucs uses for its spectrogram. Demucs already moves
those steps to the CPU for Apple (mps) and Intel XPU devices; this runner adds DirectML's device type
("privateuseone") to those checks, so the neural network runs on the GPU and the STFT on the CPU.
"""
import importlib.util
import json
import os
import sys
from pathlib import Path


def cuda_dir():
    d = os.environ.get("MINUSONE_CUDA_DIR") or str(Path(sys.executable).resolve().parent / "cuda")
    return d if os.path.isdir(os.path.join(d, "torch")) else None


def use_cuda_build():
    d = cuda_dir()
    if d and d not in sys.path:
        sys.path.insert(0, d)


def pick_dml_device():
    import torch_directml
    n = torch_directml.device_count()
    if n < 1:
        return None, None
    names = [torch_directml.device_name(i) for i in range(n)]

    def score(i):
        nm = names[i].lower()
        if "basic render" in nm or "microsoft" in nm:
            return -1                                    # software renderer: slower than the CPU
        if any(k in nm for k in ("nvidia", "geforce", "rtx", "radeon", "amd", "arc")):
            return 2                                     # dedicated / strong GPUs first
        return 1                                         # integrated Intel graphics etc.
    best = max(range(n), key=score)
    if score(best) < 0:
        return None, None
    return best, names[best]


def detect(only):
    """Check one kind of device. Each check runs in its own process (see the server), because a PyTorch
    build can't be unloaded again once imported."""
    try:
        if only == "cuda":
            use_cuda_build()
            import torch
            if torch.cuda.is_available():
                return {"kind": "cuda", "name": torch.cuda.get_device_name(0)}
            return {"kind": "none"}
        if only == "dml":
            import torch
            import torch_directml
            idx, name = pick_dml_device()
            if idx is None:
                return {"kind": "none"}
            dev = torch_directml.device(idx)
            (torch.ones(8, device=dev) * 2).sum().item()      # make sure it really works
            return {"kind": "dml", "name": name, "index": idx}
    except Exception as e:
        return {"kind": "none", "error": f"{e.__class__.__name__}: {e}"[:300]}
    return {"kind": "none"}


def load_patched(name):
    """Import a demucs module with DirectML added to its "move complex maths to the CPU" checks."""
    spec = importlib.util.find_spec(name)
    src = Path(spec.origin).read_text(encoding="utf-8")
    patched = (src.replace('["mps", "xpu"]', '["mps", "xpu", "privateuseone"]')
                  .replace("['mps', 'xpu']", "['mps', 'xpu', 'privateuseone']"))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    exec(compile(patched, spec.origin, "exec"), mod.__dict__)
    return mod, patched != src


def run(accel, args):
    if accel == "cuda":
        use_cuda_build()
        import demucs.separate
        return demucs.separate.main(args + ["-d", "cuda"])
    if accel == "dml":
        import torch_directml  # noqa: F401  registers the DirectML device with PyTorch
        idx = int(os.environ.get("MINUSONE_DML_INDEX", "-1"))
        if idx < 0:
            idx, _ = pick_dml_device()
        import demucs  # noqa: F401
        for m in ("demucs.spec", "demucs.hdemucs", "demucs.htdemucs"):
            load_patched(m)
        import demucs.separate
        return demucs.separate.main(args + ["-d", f"privateuseone:{idx or 0}"])
    import demucs.separate
    return demucs.separate.main(args + ["-d", "cpu"])


# ---------------------------------------------------------------- warm worker
# Loading PyTorch and the model from a USB stick takes 10-40 seconds. The server starts one worker when
# the app opens: it picks the device, loads the model and runs a short warm-up in the background, then
# splits every song without loading anything again. Protocol: one JSON object per line.
#   stdin : {"wav": path, "out": folder, "overlap": 0.15, "jobs": 0}
#   stdout: {"ready": {"kind","name","index"}} once, then per job {"progress": n} ... {"done": {stem: path}}
#           or {"error": "..."}.  {"retry_without_cuda": true} = start again with --no-cuda.

def say(**msg):
    sys.__stdout__.write("@@" + json.dumps(msg) + "\n")
    sys.__stdout__.flush()


def pick_device(no_cuda):
    """Same order as the separate checks: NVIDIA CUDA, then any DirectX 12 GPU, then the processor."""
    notes = []
    if not no_cuda and cuda_dir():
        use_cuda_build()
        import torch
        if torch.cuda.is_available():
            return {"kind": "cuda", "name": torch.cuda.get_device_name(0), "device": "cuda"}, notes
        return None, notes                                # CUDA build loaded but unusable: restart without
    import torch
    try:
        if torch.cuda.is_available():                    # PC server venv with the CUDA build of PyTorch
            return {"kind": "cuda", "name": torch.cuda.get_device_name(0), "device": "cuda"}, notes
    except Exception as e:
        notes.append(f"cuda: {e}"[:200])
    try:
        import torch_directml
        idx, name = pick_dml_device()
        if idx is not None:
            dev = torch_directml.device(idx)
            (torch.ones(8, device=dev) * 2).sum().item()
            import demucs  # noqa: F401
            for m in ("demucs.spec", "demucs.hdemucs", "demucs.htdemucs"):
                load_patched(m)
            return {"kind": "dml", "name": name, "index": idx, "device": dev}, notes
        notes.append("dml: no usable DirectX 12 graphics")
    except ImportError:
        pass
    except Exception as e:
        notes.append(f"dml: {e.__class__.__name__}: {e}"[:300])
    return {"kind": "cpu", "name": "processor (CPU)", "device": "cpu"}, notes


def serve(model_name, no_cuda=False):
    real_stdout = sys.stdout
    sys.stdout = sys.stderr                                 # library prints must not mix with messages
    info, notes = pick_device(no_cuda)
    if info is None:
        say(retry_without_cuda=True)
        return
    import torch
    threads = os.cpu_count() or 2
    torch.set_num_threads(threads)
    from demucs.api import Separator, save_audio
    from concurrent.futures import ThreadPoolExecutor

    state = {"last": -1, "seg": 0}

    def on_chunk(d):
        if d.get("state") != "end":
            return
        length = d.get("audio_length") or 1
        models = d.get("models") or 1
        part = (d.get("model_idx_in_bag", 0) + min(1.0, (d.get("segment_offset", 0) + state["seg"]) / length)) / models
        pct = min(99, int(part * 100))
        if pct > state["last"]:
            state["last"] = pct
            say(progress=pct)

    repo = Path(os.environ["MINUSONE_MODEL_REPO"]) if os.environ.get("MINUSONE_MODEL_REPO") else None
    sep = Separator(model=model_name, repo=repo, device=info["device"], progress=False, callback=on_chunk,
                    overlap=0.25, jobs=0)
    sep.model.eval()
    try:                                                    # warm-up: first GPU run compiles its kernels
        with torch.no_grad():
            sep.update_parameter(callback=None)
            sep.separate_tensor(torch.zeros(sep.audio_channels, sep.samplerate * 2), sep.samplerate)
    except Exception as e:
        if info["kind"] == "dml":                           # graphics driver can't run it: use the processor
            notes.append(f"dml failed: {e.__class__.__name__}: {e}"[:300])
            info = {"kind": "cpu", "name": "processor (CPU)", "device": "cpu"}
            sep = Separator(model=model_name, repo=repo, device="cpu", progress=False, overlap=0.25, jobs=0)
        else:
            raise
    sep.update_parameter(callback=on_chunk)
    try:
        seconds = getattr(sep.model, "max_allowed_segment", None) or getattr(sep.model, "segment", 8)
        state["seg"] = int(float(seconds) * sep.samplerate)
    except Exception:
        state["seg"] = sep.samplerate * 8
    say(ready={"kind": info["kind"], "name": info["name"], "index": info.get("index"), "notes": notes})

    encoder = ThreadPoolExecutor(max_workers=min(6, threads))
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            job = json.loads(line)
            state["last"] = -1
            sep.update_parameter(overlap=float(job.get("overlap", 0.25)), jobs=int(job.get("jobs", 0)))
            with torch.no_grad():
                _, stems = sep.separate_audio_file(Path(job["wav"]))
            out = Path(job["out"])
            out.mkdir(parents=True, exist_ok=True)
            paths = {name: str(out / f"{name}.mp3") for name in stems}
            # MP3 encoding of the six stems runs in parallel; preset 3 = high quality, ~2x faster than 2
            list(encoder.map(lambda kv: save_audio(kv[1].cpu(), paths[kv[0]], sep.samplerate,
                                                   bitrate=int(job.get("bitrate", 256)), preset=3),
                             stems.items()))
            say(done=paths)
        except Exception as e:
            import traceback
            traceback.print_exc()
            say(error=f"{e.__class__.__name__}: {e}"[:500])
    real_stdout.flush()


if __name__ == "__main__":
    if sys.argv[1:2] == ["--serve"]:
        serve(sys.argv[2] if len(sys.argv) > 2 else "htdemucs_6s", "--no-cuda" in sys.argv)
        sys.exit(0)
    argv = sys.argv[1:]
    if argv[:1] == ["--detect"]:
        print(json.dumps(detect(argv[1] if len(argv) > 1 else "cuda")), flush=True)
        sys.exit(0)
    accel = "cpu"
    if argv[:1] == ["--accel"]:
        accel, argv = argv[1], argv[2:]
    if argv[:1] == ["--"]:
        argv = argv[1:]
    run(accel, argv)
