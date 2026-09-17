@echo off
cd /d "%~dp0"

echo ============================================
echo   Gujjar Penthouse - setting up and starting
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js is not installed on this PC.
    echo Please install it from https://nodejs.org ^(choose the LTS version^),
    echo then double-click this file again.
    echo.
    pause
    exit /b 1
)

if not exist node_modules (
    echo Installing the app's pieces - this only happens once and takes a minute...
    call npm install
    if errorlevel 1 (
        echo.
        echo Something went wrong during install. Scroll up to see the error,
        echo or send it to Claude for help.
        echo.
        pause
        exit /b 1
    )
)

echo.
echo Starting the app...
echo Once you see "running on http://localhost:3000", open that address in your browser.
echo Keep this window open while you use the app. Close it to stop the app.
echo.

call npm start

pause
