@echo off
cd /d "%~dp0"

if not exist audiobooks mkdir audiobooks
if not exist data mkdir data

echo Starting OperaLibre...
echo OperaLibre will be available at http://localhost:4000.
echo Close this window or press Ctrl+C to stop the server.
echo.

operalibre-server.exe
echo.
echo OperaLibre stopped. Press any key to close this window.
pause >nul
