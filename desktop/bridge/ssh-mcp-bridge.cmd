@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0SSH-MCP Desktop.exe" "%~dp0resources\app.asar\build\index.js"
exit /b %errorlevel%
