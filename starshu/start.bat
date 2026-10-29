@echo off
setlocal
cd /d "%~dp0"

echo.
echo  ========================================
echo    Starshu Startup Script
echo  ========================================
echo.

node scripts\start.js

set EXITCODE=%errorlevel%
if not "%EXITCODE%"=="0" (
    echo.
    echo [ERROR] Startup failed (exit code %EXITCODE%).
    echo [HINT] If npm install failed, check network, Node version, and build tools.
    echo.
    pause
)
endlocal