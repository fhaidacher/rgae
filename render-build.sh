#!/usr/bin/env bash
# exit on error
set -o errexit

npm install
# npm run build # if you have a build step

# Install Chromium if not present (Render doesn't have it by default in some environments)
# If using a Dockerfile, this isn't needed. But for Web Service:
# Store the path for index.js to use
echo "PUPPETEER_EXECUTABLE_PATH=$(which google-chrome-stable || which chromium-browser)" >> .env
