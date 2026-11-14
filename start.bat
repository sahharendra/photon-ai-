@echo off
title PHOTON AI
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required to run PHOTON AI.
  pause
  exit /b 1
)
if not defined NODE_ENV set "NODE_ENV=development"
set "PHOTON_ADMIN_NO_AUTH=1"
if not defined PORT set "PORT=3001"
echo Starting PHOTON AI on http://localhost:%PORT% ...
node server.js
pause
