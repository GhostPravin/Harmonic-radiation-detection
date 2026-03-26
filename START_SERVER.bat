@echo off
title EV Charger IoT Server
echo ==========================================
echo   EV Charger IoT Dashboard Server
echo   Dashboard: http://localhost:3000
echo ==========================================
echo.
cd /d "%~dp0server"
node server.js
pause
