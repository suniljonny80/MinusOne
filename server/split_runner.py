"""
Runs Demucs on the best device this PC has:
  cuda  NVIDIA GPU (needs the CUDA build of PyTorch; on the USB it lives in runtime/cuda)
  dml   any DirectX 12 graphics via DirectML: Intel UHD/Iris/Arc, AMD Radeon, NVIDIA
  cpu   the processor

    python split_runner.py --detect cuda|dml           -> prints {"kind": ..., "name": ...}
    python split_runner.py --accel dml -- <demucs args> -> runs `demucs` on that device

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


if __name__ == "__main__":
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
