@echo off
cd /d "%~dp0"
if not defined PORT set PORT=8766
start "" /min node "%~dp0server.mjs"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:%PORT%/"
