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
$Runtime = Join-Path $Root 'runtime'
$Py = Join-Path $Runtime 'python.exe'
$Models = Join-Path $Root 'models'
$Tmp = Join-Path $Root 'setup-temp'

# Run a program without letting its warning messages stop the script (PowerShell 5.1 quirk)
function Invoke-Quiet([scriptblock]$Block) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Block 2>&1 | Out-Null } catch {} finally { $ErrorActionPreference = $old }
}

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Fail($msg) { Say ''; Say "  $msg" 'Red'; Say ''; exit 1 }
function Step($n, $msg) { Say ''; Say "  [$n/5] $msg" 'Cyan' }

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
function Get-FreeGB {
  $d = Get-PSDrive -Name ($Root.Substring(0, 1)) -ErrorAction SilentlyContinue
  if ($d) { return [math]::Round($d.Free / 1GB, 1) } else { return 99 }
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
    & $Py -m pip install --no-cache-dir "torch==$TorchPin" "torchvision==$TorchVisionPin" torch-directml "numpy>=1.26,<2.3"
    if ($LASTEXITCODE -eq 0 -and (Test-TorchLoads)) {
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
    & $Py -m pip install --no-cache-dir --no-deps --upgrade --target $cuda torch --index-url "https://download.pytorch.org/whl/$cu"
    if ($LASTEXITCODE -eq 0) {
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
Say '  This downloads 2-5 GB and takes 10-40 minutes (USB sticks are slow to write).'
Say '  Keep this window open until it says the USB is ready.'

$drive = Get-PSDrive -Name ($Root.Substring(0, 1)) -ErrorAction SilentlyContinue
# Space: everything except the optional NVIDIA engine fits in about 2.5 GB.
$haveTorch = Test-Path (Join-Path $Runtime 'Lib\site-packages\torch')
if (-not $haveTorch -and (Get-FreeGB) -lt 2.5) {
  Fail ("Not enough space: MinusOne needs about 2.5 GB free on " + $Root.Substring(0, 2) + ".")
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

  # -------------------------------------------------------------- 3. packages
  Step 3 'MinusOne packages (PyTorch, Demucs, yt-dlp, app window). This is the long part...'
  $env:PIP_NO_WARN_SCRIPT_LOCATION = '1'
  Say "  Free space on the USB: $(Get-FreeGB) GB" 'Gray'

  # PyTorch needs Microsoft's Visual C++ runtime, which many PCs don't have. Put a copy on the USB
  # next to python.exe BEFORE installing PyTorch, so it works on any PC (Microsoft allows this).
  & $Py -m pip install --upgrade --no-cache-dir msvc-runtime
  if ($LASTEXITCODE -ne 0) { Fail 'Installing the Visual C++ runtime failed. Run setup again.' }
  foreach ($dll in 'vcruntime140.dll', 'vcruntime140_1.dll', 'vcruntime140_threads.dll') {
    $src = Join-Path $Runtime "Scripts\$dll"
    if (Test-Path $src) { Copy-Item $src (Join-Path $Runtime $dll) -Force }
  }

  Install-UsbTorch

  # proxy_tools (used by the app window) only ships as source; the portable Python can't build it
  # in pip's isolated mode, so install the build tools first and build it directly.
  & $Py -m pip install --upgrade --no-cache-dir setuptools wheel
  & $Py -m pip install --no-cache-dir --no-build-isolation proxy_tools
  if ($LASTEXITCODE -ne 0) { Fail 'Installing the app window helper failed. Run setup again.' }
  & $Py -m pip install --upgrade --no-cache-dir -r (Join-Path $App 'server\requirements.txt') 'pywebview>=6' imageio-ffmpeg
  if ($LASTEXITCODE -ne 0) { Fail 'Installing packages failed. Check your internet connection and run setup again.' }

  Install-CudaExtra

  # -------------------------------------------------------------- 4. ffmpeg
  Step 4 'ffmpeg (audio converter)'
  $bin = Join-Path $Runtime 'bin'
  New-Item -ItemType Directory -Force $bin | Out-Null
  & $Py -c "import imageio_ffmpeg, shutil, sys; shutil.copy(imageio_ffmpeg.get_ffmpeg_exe(), sys.argv[1])" (Join-Path $bin 'ffmpeg.exe')
  if ($LASTEXITCODE -ne 0) { Fail 'Setting up ffmpeg failed.' }

  # -------------------------------------------------------------- 5. AI model
  Step 5 'Instrument-splitting AI model (about 80 MB)'
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

Say ''
Say '  The USB is ready.' 'Green'
Say ''
Say '  Double-click MinusOne.exe to open MinusOne, on this PC or any other Windows 10/11 PC.' 'White'
Say '  Songs you split and mixes you save stay on the USB.' 'Gray'
Say ''
$open = Read-Host '  Open MinusOne now? (Y/n)'
if ($open -notmatch '^[nN]') { Start-Process (Join-Path $Root 'MinusOne.exe') -WorkingDirectory $Root }
