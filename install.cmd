@echo off
rem MinimalTube installer for Windows: double-click this file (and again if you move this folder).
rem install.ps1 does the work; this starts it past PowerShell's script policy, and keeps the
rem window open so the result can be read.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
