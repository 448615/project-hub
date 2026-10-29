@echo off
setlocal

rem ============================================================
rem  Project Hub launcher for Windows (double-click to run).
rem  This file is ASCII only on purpose to avoid encoding bugs.
rem  Python preference: WorkBuddy python -> PATH python -> py -> user install
rem ============================================================

set "PY="

rem 1) WorkBuddy managed python (this machine's known location) - preferred
if exist "%USERPROFILE%\.workbuddy\binaries\python\versions" (
    for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\python\versions\*") do (
        if exist "%%D\python.exe" (
            set "PY=%%D\python.exe"
            goto :launch
        )
    )
)

rem 2) python on PATH (note: the Microsoft Store alias can be a 0-byte
rem    stub that where finds but that cannot run, so this is a fallback)
where python >nul 2>nul
if not errorlevel 1 (
    set "PY=python"
    goto :launch
)

rem 3) Windows Python launcher (py)
where py >nul 2>nul
if not errorlevel 1 (
    set "PY=py -3"
    goto :launch
)

rem 4) Standard user install location
if exist "%LOCALAPPDATA%\Programs\Python" (
    for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python*") do (
        if exist "%%D\python.exe" (
            set "PY=%%D\python.exe"
            goto :launch
        )
    )
)

rem If we get here, no python was found
echo Python was not found on this computer.
echo Please install Python from python.org and check "Add Python to PATH".
pause
exit /b 1

:launch
rem Run start.py with the default port so it does not stop to ask.
rem %~dp0 is the folder of this bat file (ends with a backslash).
%PY% "%~dp0start.py" 8000
if errorlevel 1 pause
