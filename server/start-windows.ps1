# MinusOne stem server for Windows.
# Double-click "Start MinusOne Server.bat" to run this.
#
# First run: installs Python packages into server\.venv (separate from your other projects),
# downloads the Demucs model, ffmpeg and Cloudflare's tunnel tool. This takes 5-15 minutes.
# Every run: starts the server, opens a free public HTTPS tunnel to it, opens the website
# already connected, and shows a QR code for your phone.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$Host.UI.RawUI.WindowTitle = 'MinusOne server - keep this window open'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Site  = 'https://suniljonny80.github.io/MinusOne/'
$Model = 'htdemucs_6s'
$Port  = 7860

$Root = $PSScriptRoot
$Venv = Join-Path $Root '.venv'
$Py   = Join-Path $Venv 'Scripts\python.exe'
$Bin  = Join-Path $Root 'bin'
New-Item -ItemType Directory -Force $Bin | Out-Null
Set-Location $Root

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Fail($msg) {
  Say ''
  Say $msg 'Red'
  Say ''
  exit 1
}

Say ''
Say '  MinusOne server' 'White'
Say '  ---------------' 'DarkGray'

# ------------------------------------------------------------------ 1. Python
function Find-Python {
  $tries = @(@('py', '-3.12'), @('py', '-3.11'), @('py', '-3.13'), @('py', '-3.10'), @('py', '-3'), @('python'))
  foreach ($t in $tries) {
    $exe = $t[0]
    $extra = @($t | Select-Object -Skip 1)
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
    try {
      $v = & $exe @extra -c "import sys; print(sys.version_info[0]*100+sys.version_info[1])" 2>$null
      if ($LASTEXITCODE -eq 0 -and $v -and [int]$v -ge 310) { return , $t }
    } catch {}
  }
  return $null
}

if (-not (Test-Path $Py)) {
  $found = Find-Python
  if (-not $found) {
    Fail ("Python 3.10 or newer was not found.`n" +
          "Install Python 3.12 from https://www.python.org/downloads/ (tick 'Add python.exe to PATH'), then run this again.")
  }
  Say "  Setting up a private Python environment (one time)..." 'Cyan'
  $exe = $found[0]
  $extra = @($found | Select-Object -Skip 1)
  & $exe @extra -m venv $Venv
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $Py)) { Fail 'Could not create the Python environment.' }
}

$env:PATH = "$Venv\Scripts;$Bin;$env:PATH"
$env:PYTHONIOENCODING = 'utf-8'

# ------------------------------------------------------------------ 2. packages
$reqHash = (Get-FileHash (Join-Path $Root 'requirements.txt')).Hash
$marker = Join-Path $Venv 'minusone-installed.txt'
$installed = (Test-Path $marker) -and ((Get-Content $marker -Raw).Trim() -eq $reqHash)
if (-not $installed) {
  Say '  Installing packages (one time, 5-15 minutes)...' 'Cyan'
  & $Py -m pip install --upgrade pip --quiet
  $hasTorch = $false
  if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
    Say '  NVIDIA graphics card found: installing the GPU version of PyTorch (much faster splitting).' 'Cyan'
    & $Py -m pip install torch --index-url https://download.pytorch.org/whl/cu126
    $hasTorch = ($LASTEXITCODE -eq 0)
    if (-not $hasTorch) { Say '  GPU version failed, using the CPU version instead.' 'Yellow' }
  }
  if (-not $hasTorch) {
    & $Py -m pip install torch
    if ($LASTEXITCODE -ne 0) { Fail 'Installing PyTorch failed. Check your internet connection and try again.' }
  }
  & $Py -m pip install -r requirements.txt 'qrcode[pil]' imageio-ffmpeg
  if ($LASTEXITCODE -ne 0) { Fail 'Installing packages failed. Check your internet connection and try again.' }
  Set-Content $marker $reqHash
} else {
  # YouTube changes often; keep the downloader current.
  & $Py -m pip install --quiet --upgrade 'yt-dlp[default]' 2>$null | Out-Null
}

# ------------------------------------------------------------------ 3. ffmpeg
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Say '  Adding ffmpeg...' 'Cyan'
  & $Py -c "import imageio_ffmpeg, shutil, sys; shutil.copy(imageio_ffmpeg.get_ffmpeg_exe(), sys.argv[1])" (Join-Path $Bin 'ffmpeg.exe')
  if ($LASTEXITCODE -ne 0) { Fail 'Could not set up ffmpeg.' }
}

# ------------------------------------------------------------------ 4. AI model
$modelMarker = Join-Path $Venv "model-$Model.txt"
if (-not (Test-Path $modelMarker)) {
  Say '  Downloading the instrument-splitting AI model (one time, about 80 MB)...' 'Cyan'
  & $Py -c "from demucs.pretrained import get_model; get_model('$Model'); print('model ready')"
  if ($LASTEXITCODE -ne 0) { Fail 'Downloading the AI model failed. Check your internet connection and try again.' }
  Set-Content $modelMarker 'ok'
}

# ------------------------------------------------------------------ 5. tunnel tool
$Cf = Join-Path $Bin 'cloudflared.exe'
if (-not (Test-Path $Cf)) {
  Say '  Downloading Cloudflare tunnel (one time)...' 'Cyan'
  $arch = if ([Environment]::Is64BitOperatingSystem) { 'amd64' } else { '386' }
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-$arch.exe" -OutFile $Cf
  } catch { Fail "Could not download cloudflared: $($_.Exception.Message)" }
}

# ------------------------------------------------------------------ 6. start the server
$env:DATA_DIR = Join-Path $Root 'data'
$env:DEMUCS_MODEL = $Model
if (-not $env:MAX_MINUTES) { $env:MAX_MINUTES = '15' }
$serverLog = Join-Path $Root 'server.log'
$server = $null
$tunnel = $null

function Test-Health {
  try { Invoke-RestMethod -TimeoutSec 3 "http://127.0.0.1:$Port/api/health" | Out-Null; return $true } catch { return $false }
}

try {
  if (Test-Health) {
    Say "  A MinusOne server is already running on port $Port, reusing it." 'Yellow'
  } else {
    Say '  Starting the server...' 'Cyan'
    $server = Start-Process -FilePath $Py -WorkingDirectory $Root -NoNewWindow -PassThru `
      -ArgumentList '-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', "$Port" `
      -RedirectStandardError $serverLog -RedirectStandardOutput (Join-Path $Root 'server.out.log')
    $ok = $false
    for ($i = 0; $i -lt 90; $i++) {
      Start-Sleep -Seconds 1
      if ($server.HasExited) { break }
      if (Test-Health) { $ok = $true; break }
    }
    if (-not $ok) {
      Say ''
      if (Test-Path $serverLog) { Get-Content $serverLog -Tail 25 | ForEach-Object { Say "  $_" 'DarkGray' } }
      Fail 'The server did not start. The lines above show why.'
    }
  }

  # ---------------------------------------------------------------- 7. public tunnel
  Say '  Opening a secure tunnel so your phone and other devices can reach it...' 'Cyan'
  $tunnelLog = Join-Path $Root 'tunnel.log'
  Remove-Item $tunnelLog -ErrorAction SilentlyContinue
  $tunnel = Start-Process -FilePath $Cf -NoNewWindow -PassThru `
    -ArgumentList 'tunnel', '--no-autoupdate', '--url', "http://127.0.0.1:$Port" `
    -RedirectStandardError $tunnelLog -RedirectStandardOutput (Join-Path $Root 'tunnel.out.log')
  $url = $null
  for ($i = 0; $i -lt 60 -and -not $url; $i++) {
    Start-Sleep -Seconds 1
    if ($tunnel.HasExited) { break }
    try {
      $text = Get-Content $tunnelLog -Raw -ErrorAction Stop
      $m = [regex]::Match($text, 'https://[a-z0-9-]+\.trycloudflare\.com')
      if ($m.Success) { $url = $m.Value }
    } catch {}
  }
  $tunnelOk = [bool]$url
  if (-not $url) {
    Say '  The tunnel did not start, so only this PC can use MinusOne right now.' 'Yellow'
    Say '  (Check your internet connection or firewall, then restart.)' 'Yellow'
    $url = "http://127.0.0.1:$Port"
  }

  # give the new tunnel address a moment to become reachable
  for ($i = 0; $i -lt 20; $i++) {
    try { Invoke-RestMethod -TimeoutSec 5 "$url/api/health" | Out-Null; break } catch { Start-Sleep -Seconds 2 }
  }

  $link = $Site + '?server=' + [uri]::EscapeDataString($url)
  $qr = Join-Path $Root 'phone-qr.png'
  & $Py -c "import qrcode, sys; qrcode.make(sys.argv[1], border=2).save(sys.argv[2])" $link $qr 2>$null

  Say ''
  Say '  MinusOne is ready.' 'Green'
  Say ''
  Say "  Server address:  $url" 'White'
  Say "  Website:         $link" 'White'
  Say ''
  Say '  On your phone: scan the QR code that just opened.' 'Gray'
  Say '  The address changes each time you start the server, so scan it again after a restart.' 'DarkGray'
  Say ''
  Say '  Keep this window open while you practise. Close it to stop the server.' 'Yellow'
  Say ''

  Start-Process $link
  if (Test-Path $qr) { Start-Process $qr }

  while ($true) {
    Start-Sleep -Seconds 2
    if ($server -and $server.HasExited) {
      Say '  The server stopped unexpectedly:' 'Red'
      if (Test-Path $serverLog) { Get-Content $serverLog -Tail 25 | ForEach-Object { Say "  $_" 'DarkGray' } }
      break
    }
    if ($tunnelOk -and $tunnel.HasExited) {
      Say '  The tunnel closed. Restart MinusOne to get a new address.' 'Red'
      break
    }
  }
}
finally {
  foreach ($p in @($tunnel, $server)) {
    if ($p -and -not $p.HasExited) { try { Stop-Process -Id $p.Id -Force } catch {} }
  }
}
