@echo off
setlocal
chcp 65001 >nul
title Vocabulary Service
cd /d "%~dp0" || goto startup_failed
echo Starting vocabulary service...
set "NODE_FOUND="
set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE_EXE%" for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_FOUND set "NODE_FOUND=%%N"
if not exist "%NODE_EXE%" if defined NODE_FOUND set "NODE_EXE=%NODE_FOUND%"
if not exist "%NODE_EXE%" (
  echo Node.js 20 or newer was not found. Please install it and retry.
  pause
  exit /b 1
)
"%NODE_EXE%" "%~dp0reading-server.cjs" --open %*
set "SERVER_EXIT=%ERRORLEVEL%"
if "%SERVER_EXIT%"=="0" exit /b 0
:startup_failed
echo.
echo Vocabulary service could not start. See the error above.
echo Press any key to close this window.
pause >nul
exit /b 1
