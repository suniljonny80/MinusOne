@echo off
rem Starts the MinusOne stem server and opens the website. Keep the window open while you practise.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-windows.ps1"
echo.
pause
