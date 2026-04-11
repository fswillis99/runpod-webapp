@echo off
cd /d "%~dp0"

:: Check if npm is available
where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo ERROR: npm not found.
    echo Please install Node.js from https://nodejs.org and restart this window.
    echo.
    pause
    exit /b 1
)

npm start
pause
