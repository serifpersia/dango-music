@echo off
setlocal

if "%~1"=="" goto menu

set "mode=%~1"
goto resolve

:menu
echo.
echo   Dango Music
echo.
echo   1^) Development   hot reload
echo   2^) Production    pre-built
echo.
set /p choice="Enter your choice (1 or 2): "
echo.
set "mode=%choice%"

:resolve
if /i "%mode%"=="1" set "mode=dev"
if /i "%mode%"=="dev" goto dev
if /i "%mode%"=="2" set "mode=prod"
if /i "%mode%"=="prod" goto prod

echo Invalid choice. Try: run.bat, run.bat dev, or run.bat prod.
pause
exit /b 1

:dev
echo --^> Development mode. Ctrl+R toggles the overlay, Ctrl+Shift+Q quits.
node start.js dev %2 %3
exit /b %errorlevel%

:prod
echo --^> Installing dependencies...
call pnpm install --silent
echo --^> Production mode. Ctrl+R toggles the overlay, Ctrl+Shift+Q quits.
node start.js prod %2 %3
exit /b %errorlevel%