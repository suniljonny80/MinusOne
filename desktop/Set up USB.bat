@echo off
rem One-time setup: downloads portable Python and the MinusOne AI onto this USB (about 2 GB).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\setup-usb.ps1"
echo.
pause
