@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0manage-services.ps1" %*
exit /b %ERRORLEVEL%