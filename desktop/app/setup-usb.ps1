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

# ---- PyTorch: GPU build when an NVIDIA card is present (5-20x faster splitting), CPU build otherwise
function Test-NvidiaGpu {
  if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { return $true }
  try { return [bool](Get-CimInstance Win32_VideoController -ErrorAction Stop | Where-Object { $_.Name -match 'NVIDIA' }) } catch { return $false }
}
function Get-TorchBuild {
  # 'none' = not installed, 'cpu' = CPU-only build, otherwise the CUDA version
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $v = $null
  try { $v = & $Py -c "import torch; print(torch.version.cuda or 'cpu')" 2>$null } catch {}
  $code = $LASTEXITCODE
  $ErrorActionPreference = $old
  if ($code -ne 0 -or -not $v) { return 'none' }
  return ("$v" -split "`n")[-1].Trim()
}
function Install-Torch {
  $gpu = Test-NvidiaGpu
  $current = Get-TorchBuild
  if ($gpu) {
    if ($current -ne 'none' -and $current -ne 'cpu') { Say "  GPU version of PyTorch already installed (CUDA $current)."; return }
    Say '  NVIDIA graphics card found: installing the GPU version of PyTorch (about 2.5 GB download).' 'Cyan'
    if ($current -eq 'cpu') { & $Py -m pip uninstall -y torch }
    foreach ($cu in 'cu128', 'cu126', 'cu130') {
      & $Py -m pip install --no-cache-dir torch --index-url "https://download.pytorch.org/whl/$cu"
      if ($LASTEXITCODE -eq 0) { Say "  GPU PyTorch installed ($cu)." 'Green'; return }
      Say "  The $cu build didn't install, trying another..." 'Yellow'
    }
    Say '  The GPU version could not be installed, so the CPU version will be used.' 'Yellow'
  } elseif ($current -ne 'none') {
    return
  }
  & $Py -m pip install --no-cache-dir torch
  if ($LASTEXITCODE -ne 0) { Fail 'Installing PyTorch failed. Check your internet connection and try again.' }
}


Say ''
Say '  MinusOne USB setup' 'White'
Say '  ------------------' 'DarkGray'
Say "  Installing to: $Root"
Say '  This downloads 2-5 GB and takes 10-40 minutes (USB sticks are slow to write).'
Say '  Keep this window open until it says the USB is ready.'

$drive = Get-PSDrive -Name ($Root.Substring(0, 1)) -ErrorAction SilentlyContinue
$needGB = if (Test-NvidiaGpu) { 9 } else { 4 }
if ($drive -and ($drive.Free + 0) -lt ($needGB * 1GB) -and -not (Test-Path (Join-Path $Runtime 'Lib\site-packages\torch'))) {
  Fail ("Not enough space: MinusOne needs about $needGB GB free on " + $Root.Substring(0, 2) + ".")
}
New-Item -ItemType Directory -Force $Tmp, $Models | Out-Null

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
  Install-Torch
  # proxy_tools (used by the app window) only ships as source; the portable Python can't build it
  # in pip's isolated mode, so install the build tools first and build it directly.
  & $Py -m pip install --upgrade --no-cache-dir setuptools wheel
  & $Py -m pip install --no-cache-dir --no-build-isolation proxy_tools
  if ($LASTEXITCODE -ne 0) { Fail 'Installing the app window helper failed. Run setup again.' }
  & $Py -m pip install --upgrade --no-cache-dir -r (Join-Path $App 'server\requirements.txt') 'pywebview>=6' imageio-ffmpeg

  # PyTorch needs Microsoft's Visual C++ runtime, which many PCs don't have. Keep a copy on the USB,
  # next to python.exe, so it works on any PC (Microsoft allows shipping these files with an app).
  & $Py -m pip install --upgrade --no-cache-dir msvc-runtime
  if ($LASTEXITCODE -ne 0) { Fail 'Installing the Visual C++ runtime failed. Run setup again.' }
  foreach ($dll in 'vcruntime140.dll', 'vcruntime140_1.dll', 'vcruntime140_threads.dll') {
    $src = Join-Path $Runtime "Scripts\$dll"
    if (Test-Path $src) { Copy-Item $src (Join-Path $Runtime $dll) -Force }
  }
  if ($LASTEXITCODE -ne 0) { Fail 'Installing packages failed. Check your internet connection and run setup again.' }

  # -------------------------------------------------------------- 4. ffmpeg
  Step 4 'ffmpeg (audio converter)'
  $bin = Join-Path $Runtime 'bin'
  New-Item -ItemType Directory -Force $bin | Out-Null
  & $Py -c "import imageio_ffmpeg, shutil, sys; shutil.copy(imageio_ffmpeg.get_ffmpeg_exe(), sys.argv[1])" (Join-Path $bin 'ffmpeg.exe')
  if ($LASTEXITCODE -ne 0) { Fail 'Setting up ffmpeg failed.' }

  # -------------------------------------------------------------- 5. AI model
  Step 5 'Instrument-splitting AI model (about 80 MB)'
  $env:HF_HOME = Join-Path $Models 'hf'
  $env:TORCH_HOME = Join-Path $Models 'torch'
  & $Py -c "from demucs.pretrained import get_model; get_model('$Model'); print('  model ready')"
  if ($LASTEXITCODE -ne 0) { Fail 'Downloading the AI model failed. Check your internet connection and run setup again.' }

  # quick self-test of the pieces the app needs
  & $Py -c "import fastapi, uvicorn, yt_dlp, webview, demucs, numpy, torch; torch.zeros(4).sum().item(); print('  self-test passed (PyTorch ' + torch.__version__ + ', ' + ('GPU: ' + torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU') + ')')"
  if ($LASTEXITCODE -ne 0) { Fail 'Self-test failed. Run setup again.' }
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
