@echo off
setlocal enabledelayedexpansion
echo ========================================
echo   RGAE Scraper - EJECUTAR TODO
echo ========================================
echo.

echo [1/3] Iniciando servidor web...
start /b node server.js
timeout /t 2 /nobreak >nul

echo [2/3] Ejecutando scraper...
echo    Se abrira Chrome. Resuelva el captcha.
echo    Cuando termine, cierre el navegador.
echo.
node index.js

echo [3/3] Abriendo navegador...
start http://localhost:5500/index.html

echo.
echo ========================================
echo   LISTO! Vea los resultados en:
echo   http://localhost:5500
echo ========================================
pause
