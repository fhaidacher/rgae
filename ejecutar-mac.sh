#!/bin/bash

# ========================================
#   RGAE Scraper - EJECUTAR EN MACOS
# ========================================

echo "----------------------------------------"
echo "  RGAE Scraper - macOS Runner"
echo "----------------------------------------"
echo ""

# 1. Iniciar servidor web en segundo plano
echo "[1/3] Iniciando servidor web..."
node server.js &
SERVER_PID=$!

# Esperar un momento a que el servidor suba
sleep 2

# 2. Ejecutar scraper
echo "[2/3] Ejecutando scraper..."
echo "   Se abrirá Chrome. Resuelva el captcha si es necesario."
echo "   Cuando termine, el proceso continuará."
echo ""
node index.js

# 3. Abrir el navegador en la interfaz
echo "[3/3] Abriendo interfaz en el navegador..."
open http://localhost:5500/index.html

echo ""
echo "========================================"
echo "  ¡LISTO! Resultados disponibles en:"
echo "  http://localhost:5500"
echo "========================================"
echo ""
echo "Presione Ctrl+C para detener el servidor web (PID: $SERVER_PID)"

# Mantener el script vivo para que el servidor siga corriendo hasta que el usuario lo detenga
wait $SERVER_PID
