@echo off
title 4chan Soundpost Maker
echo ==================================================
echo  Starting 4chan Soundpost Maker...
echo ==================================================
echo.

:: 1. Check Node.js installation
where node >nul 2>nul
if %errorlevel% neq 0 goto :NoNode

:: 2. Install dependencies if node_modules doesn't exist
if not exist node_modules goto :InstallDeps
goto :CheckYtdlp

:InstallDeps
echo node_modules not found. Installing dependencies...
call npm.cmd install
if %errorlevel% neq 0 goto :NpmError
echo.
goto :CheckYtdlp

:CheckYtdlp
:: 3. Download yt-dlp.exe if missing
where yt-dlp >nul 2>nul
if %errorlevel% neq 0 goto :DownloadYtdlp
goto :StartServer

:DownloadYtdlp
if exist yt-dlp.exe goto :StartServer
echo yt-dlp is missing. Downloading the latest version of yt-dlp.exe...
powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile 'yt-dlp.exe'"
if %errorlevel% neq 0 goto :DownloadError
echo Download complete.
echo.
goto :StartServer

:StartServer
:: 4. Ensure uploads/outputs folders exist
if not exist uploads mkdir uploads
if not exist outputs mkdir outputs

:: 5. Start the server
echo Launching server...
cmd /c npm start
pause
exit /b 0

:NoNode
echo ERROR: Node.js is not installed!
echo Please download and install Node.js from https://nodejs.org/
echo.
pause
exit /b 1

:NpmError
echo.
echo ERROR: Failed to install npm packages.
pause
exit /b 1

:DownloadError
echo ERROR: Failed to download yt-dlp.exe.
echo Please download it manually from:
echo https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe
echo and place it in this folder.
pause
exit /b 1
