const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PORT = 3000;

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

let currentScraper = null;
let currentRunId = 0;  // Incrementa con cada nueva ejecución

const server = http.createServer(async (req, res) => {
  // Skip logging to avoid output issues

  if (req.url === '/api/run-scraper' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      let timeoutGeneral = 30;
      let timeoutCloudflare = 1;
      let timeoutFastFailMs = 500;
      let pausaEntreReintentos = 100;
      let maxReintentos = 10;
      try {
        const parsed = JSON.parse(body);
        if (parsed.timeoutGeneral)       timeoutGeneral       = parseFloat(parsed.timeoutGeneral)       || 30;
        if (parsed.timeoutCloudflare)    timeoutCloudflare    = parseFloat(parsed.timeoutCloudflare)    || 1;
        if (parsed.timeoutFastFailMs)    timeoutFastFailMs    = parseInt(parsed.timeoutFastFailMs)      || 500;
        if (parsed.pausaEntreReintentos) pausaEntreReintentos = parseInt(parsed.pausaEntreReintentos)   || 100;
        if (parsed.maxReintentos)        maxReintentos        = parseInt(parsed.maxReintentos)           || 10;

        // Guardar en config.json para persistir entre ejecuciones
        const cfgPath = path.join(__dirname, 'config.json');
        fs.writeFileSync(cfgPath, JSON.stringify({
          timeoutGeneral, timeoutCloudflare, timeoutFastFailMs, pausaEntreReintentos, maxReintentos
        }, null, 2));

        console.log(`⚙️  Config guardada → General:${timeoutGeneral}s | CF:${timeoutCloudflare}s | FastFail:${timeoutFastFailMs}ms | Pausa:${pausaEntreReintentos}ms | Reintentos:${maxReintentos}`);
      } catch (e) { }

      // Si ya hay uno corriendo, lo terminamos de forma SÍNCRONA
      // para evitar que el proceso huérfano escriba en el log después de que el nuevo inicie.
      if (currentScraper) {
        const oldPid = currentScraper.pid;
        currentScraper.removeAllListeners('exit');
        currentScraper = null;

        if (process.platform === 'win32') {
          try {
            spawnSync('taskkill', ['/pid', String(oldPid), '/f', '/t']);
          } catch (e) { }
        } else {
          try { process.kill(-oldPid, 'SIGKILL'); } catch (e) { }
        }

        // Pausa para que el SO libere los handles del proceso muerto
        await new Promise(r => setTimeout(r, 500));
      }

      // Nuevo runId único para esta ejecución
      currentRunId = Date.now();

      const logPath = path.join(__dirname, 'scraper_log.txt');

      // Escribimos el marcador de inicio NOSOTROS (el server), no el proceso hijo.
      // Esto garantiza que sea la primera línea del log, antes de cualquier output del scraper.
      // El frontend usa este marcador para detectar una nueva ejecución y limpiar la pantalla.
      fs.writeFileSync(logPath, `__RUN_START__:${currentRunId}\n`);

      const out = fs.openSync(logPath, 'a'); // 'a' = append, para no borrar el marcador

      currentScraper = spawn('node', ['index.js'], {
        cwd: __dirname,
        detached: false,
        stdio: ['ignore', out, out],
        env: {
          ...process.env,
          TIMEOUT_GENERAL:           String(timeoutGeneral),
          TIMEOUT_WAIT_CLOUDFLARE:   String(timeoutCloudflare),
          TIMEOUT_FAST_FAIL_MS:      String(timeoutFastFailMs),
          PAUSA_ENTRE_REINTENTOS_MS: String(pausaEntreReintentos),
          MAX_REINTENTOS:            String(maxReintentos)
        }
      });

      currentScraper.on('exit', () => {
        currentScraper = null;
      });

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ status: 'started', runId: currentRunId }));
    });
    return;
  }

  if (req.url === '/api/status' && req.method === 'GET') {
    const jsonExists = fs.existsSync(path.join(__dirname, 'proveedores_rgae.json'));
    const xlsxExists = fs.existsSync(path.join(__dirname, 'proveedores_rgae.xlsx'));
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({
      jsonExists,
      xlsxExists,
      ready: jsonExists
    }));
    return;
  }

  if (req.url === '/api/log' && req.method === 'GET') {
    const logPath = path.join(__dirname, 'scraper_log.txt');
    let logContent = '';
    if (fs.existsSync(logPath)) {
      logContent = fs.readFileSync(logPath, 'utf8');
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({ log: logContent }));
    return;
  }

  if (req.url === '/api/running' && req.method === 'GET') {
    const logPath = path.join(__dirname, 'scraper_log.txt');
    let rawLog = '';
    if (fs.existsSync(logPath)) {
      rawLog = fs.readFileSync(logPath, 'utf8');
    }

    // Quitar la línea de marcador del contenido enviado al frontend
    const logContent = rawLog.replace(/^__RUN_START__:\d+\n/, '');

    const isRunning = currentScraper !== null;
    const jsonExists = fs.existsSync(path.join(__dirname, 'proveedores_rgae.json'));

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({
      running: isRunning,
      log: logContent,
      completed: jsonExists && !isRunning,
      runId: currentRunId
    }));
    return;
  }

  if (req.url === '/api/upload-nits' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.nits && Array.isArray(data.nits)) {
          fs.writeFileSync(path.join(__dirname, 'nits.json'), JSON.stringify(data.nits, null, 2));
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ status: 'success', count: data.nits.length }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ status: 'error', message: 'Invalid data format' }));
        }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ status: 'error', message: e.message }));
      }
    });
    return;
  }

  if (req.url === '/api/get-config' && req.method === 'GET') {
    const cfgPath = path.join(__dirname, 'config.json');
    let cfg = { timeoutGeneral: 30, timeoutCloudflare: 1, timeoutFastFailMs: 500, pausaEntreReintentos: 100, maxReintentos: 10 };
    try {
      if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch (e) { }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(cfg));
    return;
  }

  if (req.url === '/api/save-config' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const cfg = JSON.parse(body);
        fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(cfg, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ status: 'ok' }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ status: 'error', message: e.message }));
      }
    });
    return;
  }

  if (req.url === '/api/get-nits' && req.method === 'GET') {
    const nitsPath = path.join(__dirname, 'nits.json');
    let nits = [];
    if (fs.existsSync(nitsPath)) {
      try {
        nits = JSON.parse(fs.readFileSync(nitsPath, 'utf8'));
      } catch (e) { }
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ nits }));
    return;
  }

  console.log(`[${new Date().toLocaleTimeString()}] ${req.url}`);

  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, filePath);

  const ext = path.extname(filePath);
  const contentType = mimeTypes[ext] || 'text/plain';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        console.log(`  404 Not Found: ${filePath}`);
        res.writeHead(404);
        res.end('404 Not Found');
      } else {
        console.log(`  500 Error: ${err.code}`);
        res.writeHead(500);
        res.end('Server Error: ' + err.code);
      }
    } else {
      console.log(`  200 OK: ${contentType}`);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*'
      });
      res.end(content);
    }
  });
});

server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║   🌐 Servidor iniciado                      ║
║   📍 http://localhost:${PORT}                   ║
╚═══════════════════════════════════════════════════╝
  `);
  console.log('Presiona Ctrl+C para detener');
});
