# MinusOne USB setup. Run once (double-click "Set up USB.bat") on a Windows PC with internet.
# Puts a private, portable Python and everything MinusOne needs next to MinusOne.exe,
# so the USB then works on any Windows 10/11 PC without installing anything.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$Host.UI.RawUI.WindowTitle = 'MinusOne USB setup'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$PyVersion = '3.12.10'
$Model = 'htdemucs_6s'

$App = $PSScriptRoot                       # <usb>\MinusOne\app
$Root = Split-Path -Parent $App            # <usb>\MinusOne
$UsbRuntime = Join-Path $Root 'runtime'
$Runtime = $UsbRuntime
$Py = Join-Path $Runtime 'python.exe'
$Models = Join-Path $Root 'models'

# SPEED: a USB stick is very slow at writing thousands of small files, and PyTorch alone is ~15,000
# files (half of them build-only headers). On a fresh setup everything is therefore downloaded and
# installed on this PC's own disk first, trimmed, and then copied to the USB in one go. Downloads use
# uv (several files at once) when it works, otherwise pip. Nothing is left on the PC afterwards.
$Work = Join-Path $env:LOCALAPPDATA 'MinusOne-setup'
$Tmp = Join-Path $Work 'temp'
$Stage = Join-Path $Work 'runtime'
$env:UV_CACHE_DIR = Join-Path $Work 'cache'
$env:PIP_CACHE_DIR = Join-Path $Work 'pip-cache'
$env:PIP_NO_COMPILE = '1'                  # don't write a .pyc for every file; Python makes the ones it needs
$env:PIP_DISABLE_PIP_VERSION_CHECK = '1'
$env:UV_LINK_MODE = 'copy'
$Uv = $null

# Run a program without letting its warning messages stop the script (PowerShell 5.1 quirk)
function Invoke-Quiet([scriptblock]$Block) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Block 2>&1 | Out-Null } catch {} finally { $ErrorActionPreference = $old }
}

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Fail($msg) { Say ''; Say "  $msg" 'Red'; Say ''; exit 1 }
function Step($n, $msg) { Say ''; Say "  [$n/6] $msg" 'Cyan' }

# ---- PyTorch with DirectML: runs the AI on ANY graphics chip (Intel UHD/Iris/Arc, AMD Radeon, NVIDIA).
# NVIDIA PCs additionally get the CUDA engine (fastest) when the USB has room for it (~5 GB).
$TorchPin = '2.4.1'          # newest PyTorch that Microsoft's torch-directml supports
$TorchVisionPin = '0.19.1'

function Test-NvidiaGpu {
  if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { return $true }
  try { return [bool](Get-CimInstance Win32_VideoController -ErrorAction Stop | Where-Object { $_.Name -match 'NVIDIA' }) } catch { return $false }
}
function Invoke-Py([string[]]$PyArgs) {
  # run python, return its output lines, never let warnings stop the script
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = $null
  try { $out = & $Py @PyArgs 2>&1 } catch {}
  $script:PyExit = $LASTEXITCODE
  $ErrorActionPreference = $old
  return @($out | ForEach-Object { "$_" })
}
function Test-TorchLoads {
  $out = Invoke-Py @('-c', "import torch, torch_directml; torch.zeros(2).sum().item(); print(torch.__version__)")
  $script:TorchError = ($out | Where-Object { $_ -match 'Error|error|DLL|dll' } | Select-Object -Last 3) -join "`n    "
  $script:TorchVersion = ($out | Select-Object -Last 1)
  return ($script:PyExit -eq 0)
}
function Get-FreeGB([string]$Path = $Root) {
  $d = Get-PSDrive -Name ($Path.Substring(0, 1)) -ErrorAction SilentlyContinue
  if ($d) { return [math]::Round($d.Free / 1GB, 1) } else { return 99 }
}
function Use-Runtime([string]$Dir) {
  $script:Runtime = $Dir
  $script:Py = Join-Path $Dir 'python.exe'
}
function Install-Pkgs([string[]]$PkgArgs) {
  # uv first (parallel downloads, fast installs), pip if uv isn't available or fails
  if ($script:Uv) {
    & $script:Uv pip install --python $script:Py @PkgArgs
    if ($LASTEXITCODE -eq 0) { return $true }
    Say '  (fast installer had a problem, using pip for this step)' 'DarkGray'
  }
  $pipArgs = @($PkgArgs | ForEach-Object { $_ })
  & $script:Py -m pip install --no-compile @pipArgs
  return ($LASTEXITCODE -eq 0)
}
function Get-Uv {
  # uv lives in the temp folder only; it is not copied to the USB
  $uvDir = Join-Path $Tmp 'uv'
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & $Py -m pip install --quiet --target $uvDir uv 2>&1 | Out-Null } catch {}
  $ErrorActionPreference = $old
  $exe = Get-ChildItem $uvDir -Recurse -Filter 'uv.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($exe) {
    $v = Invoke-Quiet { & $exe.FullName --version }
    if ($LASTEXITCODE -eq 0) { $script:Uv = $exe.FullName; Say '  Using the fast installer (uv).' 'Gray'; return }
  }
  Say '  Using pip.' 'Gray'
}
function Remove-TorchCompletely([string]$Where = '') {
  # pip can leave files behind, and PyTorch loads every DLL in its folder, so delete the folders outright.
  $sp = if ($Where) { $Where } else { Join-Path $Runtime 'Lib\site-packages' }
  if (-not $Where) { Invoke-Py @('-m', 'pip', 'uninstall', '-y', 'torch', 'torchvision', 'torch-directml') | Out-Null }
  foreach ($n in 'torch', 'torchvision', 'torch_directml', 'functorch', 'torchgen') {
    $item = Join-Path $sp $n
    if (Test-Path $item) { Remove-Item -Recurse -Force $item -ErrorAction SilentlyContinue }
  }
  foreach ($pat in 'torch-*.dist-info', 'torchvision-*.dist-info', 'torch_directml-*.dist-info') {
    Get-ChildItem $sp -Directory -Filter $pat -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path (Join-Path $sp 'torch')) {
    Fail 'Could not delete the old PyTorch folder (a file may be in use). Close MinusOne, restart the PC and run setup again.'
  }
}
function Remove-BuildOnlyFiles([string]$TorchDir) {
  Remove-Item -Recurse -Force (Join-Path $TorchDir 'include') -ErrorAction SilentlyContinue
  Get-ChildItem (Join-Path $TorchDir 'lib') -Filter '*.lib' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
}
function Install-UsbTorch {
  if ((Test-TorchLoads) -and ($script:TorchVersion -like "$TorchPin*")) {
    Say "  PyTorch $TorchPin with DirectML is already installed." 'Gray'
    return
  }
  Say '  Installing PyTorch with DirectML, so splitting uses whatever graphics chip the PC has...' 'Cyan'
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    Remove-TorchCompletely
    $ok = Install-Pkgs @("torch==$TorchPin", "torchvision==$TorchVisionPin", 'torch-directml', 'numpy>=1.26,<2.3')
    if ($ok -and (Test-TorchLoads)) {
      Remove-BuildOnlyFiles (Join-Path $Runtime 'Lib\site-packages\torch')
      Say "  PyTorch $TorchPin with DirectML installed." 'Green'
      return
    }
    Say "  PyTorch didn't load:" 'Yellow'
    Say "    $script:TorchError" 'DarkGray'
    if ($attempt -eq 1) { Say '  Trying once more...' 'Yellow' }
  }
  Fail 'PyTorch will not load. Take a screenshot of this window and send it to Claude.'
}
function Install-CudaExtra {
  # Optional: NVIDIA's own engine is 2-4x faster than DirectML on NVIDIA cards, but needs ~5 GB.
  if (-not (Test-NvidiaGpu)) { return }
  $cuda = Join-Path $Runtime 'cuda'
  $runner = Join-Path $App 'server\split_runner.py'
  if (Test-Path (Join-Path $cuda 'torch')) {
    $r = (Invoke-Py @($runner, '--detect', 'cuda')) | Select-Object -Last 1
    if ($r -match '"kind": "cuda"') { Say '  NVIDIA CUDA engine already installed.' 'Gray'; return }
    Remove-Item -Recurse -Force $cuda -ErrorAction SilentlyContinue
  }
  $free = Get-FreeGB
  if ($free -lt 6.5) {
    Say "  NVIDIA card found. Its extra-fast CUDA engine needs about 6.5 GB free and this USB has $free GB," 'Gray'
    Say '  so NVIDIA PCs will use DirectML too (still uses the graphics card, just not quite as fast).' 'Gray'
    return
  }
  Say '  NVIDIA card found: adding its extra-fast CUDA engine (about 3 GB download)...' 'Cyan'
  foreach ($cu in 'cu128', 'cu126', 'cu130') {
    $ok = Install-Pkgs @('--no-deps', '--upgrade', '--target', $cuda, 'torch', '--index-url', "https://download.pytorch.org/whl/$cu")
    if ($ok) {
      Remove-BuildOnlyFiles (Join-Path $cuda 'torch')
      $r = (Invoke-Py @($runner, '--detect', 'cuda')) | Select-Object -Last 1
      if ($r -match '"kind": "cuda"') { Say "  CUDA engine ready ($cu)." 'Green'; return }
    }
    Remove-Item -Recurse -Force $cuda -ErrorAction SilentlyContinue
  }
  Say '  The CUDA engine could not be added; NVIDIA PCs will use DirectML instead.' 'Yellow'
}

Say ''
Say '  MinusOne USB setup' 'White'
Say '  ------------------' 'DarkGray'
Say "  Installing to: $Root"
Say '  This downloads about 1 GB and takes roughly 5-20 minutes, mostly copying to the USB.'
Say '  Keep this window open until it says the USB is ready.'

$drive = Get-PSDrive -Name ($Root.Substring(0, 1)) -ErrorAction SilentlyContinue
# Space: everything except the optional NVIDIA engine fits in about 2.5 GB.
$haveTorch = Test-Path (Join-Path $Runtime 'Lib\site-packages\torch')
if (-not $haveTorch -and (Get-FreeGB) -lt 2.5) {
  Fail ("Not enough space: MinusOne needs about 2.5 GB free on " + $Root.Substring(0, 2) + ".")
}
New-Item -ItemType Directory -Force $Tmp, $Models | Out-Null

# Fresh setup (no working Python on the USB yet) + room on this PC: build on the PC's disk, copy at the end.
$Staged = $false
$usbHasPython = Test-Path (Join-Path $UsbRuntime 'python.exe')
if ($usbHasPython -and -not ((Test-TorchLoads) -and ($script:TorchVersion -like "$TorchPin*"))) {
  # a half-finished or broken earlier setup: start over (the fast way) instead of repairing it on the USB
  Say '  The earlier setup on this USB is incomplete, so it will be rebuilt.' 'Yellow'
  Remove-Item -Recurse -Force $UsbRuntime -ErrorAction SilentlyContinue
  $usbHasPython = Test-Path (Join-Path $UsbRuntime 'python.exe')
}
$sysDrive = $env:LOCALAPPDATA
if (-not $usbHasPython -and $sysDrive -and ($sysDrive.Substring(0, 1) -ne $Root.Substring(0, 1)) -and ((Get-FreeGB $sysDrive) -ge 4)) {
  Remove-Item -Recurse -Force $Stage -ErrorAction SilentlyContinue
  Use-Runtime $Stage
  $Staged = $true
  Say '  Fast mode: building on this PC first, then copying to the USB in one go.' 'Gray'
}

function Get-File($url, $out) {
  for ($i = 1; $i -le 3; $i++) {
    try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $out; return } catch {
      if ($i -eq 3) { Fail "Download failed: $url`n  $($_.Exception.Message)" }
      Start-Sleep -Seconds 3
    }
  }
}

try {
  # -------------------------------------------------------------- 1. portable Python
  Step 1 "Portable Python $PyVersion"
  if (-not (Test-Path $Py)) {
    $zip = Join-Path $Tmp 'python.zip'
    Get-File "https://www.python.org/ftp/python/$PyVersion/python-$PyVersion-embed-amd64.zip" $zip
    New-Item -ItemType Directory -Force $Runtime | Out-Null
    Expand-Archive -Path $zip -DestinationPath $Runtime -Force
  }
  # let the portable Python use installed packages
  $pth = Get-ChildItem $Runtime -Filter 'python*._pth' | Select-Object -First 1
  if (-not $pth) { Fail 'The portable Python looks incomplete. Delete the runtime folder and run setup again.' }
  $zipName = (Get-ChildItem $Runtime -Filter 'python3*.zip' | Select-Object -First 1).Name
  Set-Content -Path $pth.FullName -Encoding ASCII -Value @($zipName, '.', 'Lib\site-packages', 'import site')
  New-Item -ItemType Directory -Force (Join-Path $Runtime 'Lib\site-packages') | Out-Null

  # -------------------------------------------------------------- 2. pip
  Step 2 'Package installer'
  if (-not (Test-Path (Join-Path $Runtime 'Lib\site-packages\pip\__init__.py'))) {
    $getpip = Join-Path $Tmp 'get-pip.py'
    Get-File 'https://bootstrap.pypa.io/get-pip.py' $getpip
    & $Py $getpip --no-warn-script-location --quiet
    if ($LASTEXITCODE -ne 0) { Fail 'Installing pip failed.' }
  }
  Get-Uv

  # -------------------------------------------------------------- 3. packages
  Step 3 'MinusOne packages (PyTorch, Demucs, yt-dlp, app window). This is the long part...'
  $env:PIP_NO_WARN_SCRIPT_LOCATION = '1'
  Say "  Free space on the USB: $(Get-FreeGB) GB" 'Gray'

  # PyTorch needs Microsoft's Visual C++ runtime, which many PCs don't have. Put a copy on the USB
  # next to python.exe BEFORE installing PyTorch, so it works on any PC (Microsoft allows this).
  if (-not (Install-Pkgs @('--upgrade', 'msvc-runtime'))) { Fail 'Installing the Visual C++ runtime failed. Run setup again.' }
  foreach ($dll in 'vcruntime140.dll', 'vcruntime140_1.dll', 'vcruntime140_threads.dll') {
    $src = Join-Path $Runtime "Scripts\$dll"
    if (Test-Path $src) { Copy-Item $src (Join-Path $Runtime $dll) -Force }
  }

  Install-UsbTorch

  # proxy_tools (used by the app window) only ships as source; the portable Python can't build it
  # in pip's isolated mode, so install the build tools first and build it directly.
  if (-not (Test-Path (Join-Path $Runtime 'Lib\site-packages\proxy_tools'))) {
    $null = Install-Pkgs @('--upgrade', 'setuptools', 'wheel')
    if (-not (Install-Pkgs @('--no-build-isolation', 'proxy_tools'))) { Fail 'Installing the app window helper failed. Run setup again.' }
  }
  # Pin PyTorch: Demucs accepts any PyTorch, and an upgrade would replace the DirectML-compatible 2.4.1
  $pins = Join-Path $Tmp 'pins.txt'
  Set-Content -Encoding ascii $pins "torch==$TorchPin`r`ntorchvision==$TorchVisionPin`r`nnumpy>=1.26,<2.3"
  if (-not (Install-Pkgs @('--upgrade', '-c', $pins, '-r', (Join-Path $App 'server\requirements.txt'), 'pywebview>=6', 'imageio-ffmpeg'))) {
    Fail 'Installing packages failed. Check your internet connection and run setup again.'
  }
  if (-not ((Test-TorchLoads) -and ($script:TorchVersion -like "$TorchPin*"))) {
    Say '  PyTorch was changed by another package; putting the right one back...' 'Yellow'
    Install-UsbTorch
  }

  Install-CudaExtra

  # -------------------------------------------------------------- 4. ffmpeg
  Step 4 'ffmpeg (audio converter)'
  $bin = Join-Path $Runtime 'bin'
  New-Item -ItemType Directory -Force $bin | Out-Null
  if (-not (Test-Path (Join-Path $bin 'ffmpeg.exe'))) {
    & $Py -c "import imageio_ffmpeg, shutil, sys; shutil.copy(imageio_ffmpeg.get_ffmpeg_exe(), sys.argv[1])" (Join-Path $bin 'ffmpeg.exe')
    if ($LASTEXITCODE -ne 0) { Fail 'Setting up ffmpeg failed.' }
  }
  # imageio-ffmpeg's own copy isn't needed any more (ffmpeg.exe is in runtime\bin): saves ~80 MB on the USB
  Remove-Item -Recurse -Force (Join-Path $Runtime 'Lib\site-packages\imageio_ffmpeg\binaries') -ErrorAction SilentlyContinue

  # -------------------------------------------------------------- 5. copy to the USB
  Step 5 'Copying to the USB'
  if ($Staged) {
    # Load everything the app uses once on the fast disk, so Python saves the compiled files the app
    # needs (makes the first start from the USB faster), then copy the whole folder in one go.
    $null = Invoke-Py @('-c', "import fastapi, uvicorn, yt_dlp, webview, demucs.api, demucs.separate, numpy, torch, torch_directml, requests, multipart")
    $mb = [math]::Round(((Get-ChildItem $Stage -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum) / 1MB)
    $free = Get-FreeGB
    if (($mb / 1024) -gt ($free - 0.2)) { Fail "Not enough space on the USB: MinusOne needs $([math]::Round($mb / 1024, 1)) GB and $free GB is free." }
    Say "  Copying $mb MB to the USB. USB sticks are slow to write, so this is the longest step..." 'Cyan'
    Remove-Item -Recurse -Force $UsbRuntime -ErrorAction SilentlyContinue
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & robocopy $Stage $UsbRuntime /E /MT:8 /R:2 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
    $rc = $LASTEXITCODE
    $ErrorActionPreference = $old
    if ($rc -ge 8) { Fail "Copying to the USB failed (robocopy code $rc). Check the USB isn't full or write-protected, then run setup again." }
    Use-Runtime $UsbRuntime
    if (-not (Test-TorchLoads)) { Say "    $script:TorchError" 'DarkGray'; Fail 'The copy on the USB does not work. Run setup again.' }
    Remove-Item -Recurse -Force $Stage -ErrorAction SilentlyContinue
    Say '  Copied.' 'Green'
  } else {
    Say '  Installed straight onto the USB.' 'Gray'
  }

  # -------------------------------------------------------------- 6. AI model
  Step 6 'Instrument-splitting AI model (about 80 MB)'
  if (-not (Test-TorchLoads)) { Install-UsbTorch }
  $env:HF_HOME = Join-Path $Models 'hf'
  $env:TORCH_HOME = Join-Path $Models 'torch'
  & $Py -c "from demucs.pretrained import get_model; get_model('$Model'); print('  model ready')"
  if ($LASTEXITCODE -ne 0) { Fail 'Downloading the AI model failed. Check your internet connection and run setup again.' }

  # quick self-test of the pieces the app needs
  $t = Invoke-Py @('-c', "import fastapi, uvicorn, yt_dlp, webview, demucs, numpy, torch, torch_directml; print('ok')")
  if ($script:PyExit -ne 0) { Say ($t -join "`n") 'DarkGray'; Fail 'Self-test failed. Run setup again.' }
  $runner = Join-Path $App 'server\split_runner.py'
  $gpu = $null
  foreach ($k in 'cuda', 'dml') {
    $r = (Invoke-Py @($runner, '--detect', $k)) | Select-Object -Last 1
    if ($r -match '"kind": "(cuda|dml)", "name": "([^"]+)"') { $gpu = "$($Matches[2]) ($(if ($Matches[1] -eq 'cuda') { 'CUDA' } else { 'DirectML' }))"; break }
  }
  if ($gpu) { Say "  Self-test passed. On this PC songs split on: $gpu" 'Green' }
  else { Say '  Self-test passed. This PC has no usable graphics chip, so songs split on the processor.' 'Yellow' }
}
finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
# done: remove the build folder and download cache from this PC
Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue

Say ''
Say '  The USB is ready.' 'Green'
Say ''
Say '  Double-click MinusOne.exe to open MinusOne, on this PC or any other Windows 10/11 PC.' 'White'
Say '  Songs you split and mixes you save stay on the USB.' 'Gray'
Say ''
$open = Read-Host '  Open MinusOne now? (Y/n)'
if ($open -notmatch '^[nN]') { Start-Process (Join-Path $Root 'MinusOne.exe') -WorkingDirectory $Root }
