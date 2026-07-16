const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

puppeteer.use(StealthPlugin());

let NITS = [
  '14946203', '14946211', '9929290', '42678447', '7378106', '28132874', '45871507', '27706737', '25227696', '326445', '1817129K', '1726328K', '38505800', '23451866', '27654966', '16139879', '20284373', '15972364', '59415800', '5139341', '23438495', '26532476', '27622193', '61447463'
];

// Cargar NITs desde nits.json si existe
const nitsPath = path.join(__dirname, 'nits.json');
if (fs.existsSync(nitsPath)) {
  try {
    const customNits = JSON.parse(fs.readFileSync(nitsPath, 'utf8'));
    if (Array.isArray(customNits) && customNits.length > 0) {
      NITS = customNits;
      console.log(`📋 NITs cargados desde archivo: ${NITS.length} registros`);
    }
  } catch (e) {
    console.error('⚠️ Error al cargar nits.json, usando lista por defecto.');
  }
}

const BASE_URL = 'https://sistema.rgae.gob.gt/consulta-proveedores/proveedor';

// ─── Configuración persistente ────────────────────────────────────────────────
// Lee config.json si existe; los valores del archivo se usan como default.
// Variables de entorno (enviadas por server.js al lanzar) tienen prioridad.
const CONFIG_PATH = path.join(__dirname, 'config.json');
let _cfg = {};
try {
  if (fs.existsSync(CONFIG_PATH)) {
    _cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }
} catch (e) {
  console.warn('⚠️  No se pudo leer config.json, usando valores por defecto.');
}

// Prioridad: variable de entorno > config.json > valor hardcoded
const TIMEOUT_GENERAL = parseFloat(process.env.TIMEOUT_GENERAL) || _cfg.timeoutGeneral || 30;
const TIMEOUT_WAIT_CLOUDFLARE = parseFloat(process.env.TIMEOUT_WAIT_CLOUDFLARE) || _cfg.timeoutCloudflare || 1;
const TIMEOUT_FAST_FAIL_MS = parseInt(process.env.TIMEOUT_FAST_FAIL_MS) || _cfg.timeoutFastFailMs || 500;
const PAUSA_ENTRE_REINTENTOS_MS = parseInt(process.env.PAUSA_ENTRE_REINTENTOS_MS) || _cfg.pausaEntreReintentos || 100;
const MAX_REINTENTOS_CFG = parseInt(process.env.MAX_REINTENTOS) || _cfg.maxReintentos || 10;

console.log(`⚙️  Config → General:${TIMEOUT_GENERAL}s | Cloudflare:${TIMEOUT_WAIT_CLOUDFLARE}s | FastFail:${TIMEOUT_FAST_FAIL_MS}ms | Pausa:${PAUSA_ENTRE_REINTENTOS_MS}ms | MaxReintentos:${MAX_REINTENTOS_CFG}`);

// Derivados (no tocar)
const TIMEOUT_PAGINA_CARGA = TIMEOUT_GENERAL;
const TIMEOUT_ESPERA_POST_CARGA = 0.5;
const TIMEOUT_RESOLVER_CAPTCHA = TIMEOUT_GENERAL;

// Limitar a ~10 registros por minuto (1 registro cada 6 segundos) para evitar bloqueos
const TIMEOUT_ENTRE_NITS = 2.5;
const TIMEOUT_ENTRE_NITS_RAPIDO = parseFloat(process.env.TIMEOUT_ENTRE_NITS_RAPIDO) || _cfg.timeoutEntreNitsRapido || 2.5;
const TIMEOUT_NAVEGACION_INICIAL = TIMEOUT_GENERAL;


/**
 * Aborta la navegación actual cargando about:blank y espera brevemente.
 * Evita que Cloudflare deje la página congelada bloqueando el siguiente intento.
 */
async function abortarNavegacion(page) {
  try {
    await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 3000 });
  } catch (_) { /* ignorar errores al abortar */ }
}

async function extraerDatos(page, nit, index, total, skipNavigation = false) {
  const MAX_RETRIES = MAX_REINTENTOS_CFG;
  let attempt = 0;
  let datos = null;
  const urlPublica = `${BASE_URL}/${nit}?source=guatecompras`;
  const prefix = `[${index}/${total}] ${nit} → `;

  // Timeout fijo corto: detecta rápido si Cloudflare congela y reintenta
  const timeoutNavegacionMs = TIMEOUT_FAST_FAIL_MS;           // ms — directo, sin multiplicar
  const timeoutSelectorMs = TIMEOUT_WAIT_CLOUDFLARE * 1000; // ms — espera el challenge

  while (attempt <= MAX_RETRIES) {
    try {
      if (page.isClosed()) {
        throw new Error('La página del navegador se cerró inesperadamente.');
      }

      await page.goto(urlPublica, { waitUntil: 'domcontentloaded', timeout: timeoutNavegacionMs });

      // ─── Detección rápida de "Verificando acceso" atascado ───────────────
      const POLL_INTERVAL_MS = 300;
      const maxPolls = Math.ceil(timeoutSelectorMs / POLL_INTERVAL_MS);
      let cfExito = false;

      for (let p = 0; p < maxPolls; p++) {
        const estado = await page.evaluate(() => {
          const hayInput = !!document.querySelector('input[readonly]');
          const texto = document.body ? document.body.innerText : '';
          const verificando = texto.includes('Verificando acceso') || texto.includes('Verifying you are human');
          return { hayInput, verificando };
        });

        if (estado.hayInput) {
          cfExito = true;
          break;
        }

        if (estado.verificando && p > maxPolls / 2) {
          throw new Error('Cloudflare atascado en "Verificando acceso" (checkbox no marcado)');
        }

        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      }

      if (!cfExito) {
        throw new Error('Timeout esperando input[readonly] (Cloudflare no resuelto)');
      }

      // Esperar un momento de seguridad adicional para que se rellene el valor de los inputs
      await new Promise(r => setTimeout(r, TIMEOUT_ESPERA_POST_CARGA * 1000));

      // Verificar si hay un mensaje de carga interno del sistema
      const estaCargandoInfo = await page.evaluate(() => {
        return document.body && document.body.innerText.includes('Cargando información del proveedor');
      });

      if (estaCargandoInfo) {
        console.log(`${prefix} ⏳ El sistema indica 'Cargando información del proveedor', esperando 8 segundos extra...`);
        await new Promise(r => setTimeout(r, 8000));
      }


      datos = await page.evaluate(() => {
        const resultado = {};
        const inputs = document.querySelectorAll('input[readonly]');
        inputs.forEach(input => {
          try {
            const label = input.closest('.form-group')?.querySelector('.control-label');
            const labelText = label?.innerText?.trim() || '';
            const value = input.value?.trim() || '';
            if (labelText && value) {
              resultado[labelText] = value;
            }
          } catch (e) { }
        });

        const bodyText = document.body.innerText;

        // Representantes
        const representantes = [];
        const repSection = bodyText.match(/Representante\(s\) Legal\(es\)[\s\S]*?(?=Comercios|En Especialidades)/g);
        if (repSection) {
          const lines = repSection[0].split('\n').filter(l => l.match(/^\d/) || l.match(/Guatemala/));
          lines.forEach(line => {
            const parts = line.split('\t');
            if (parts.length >= 3 && parts[0].match(/^\d/)) {
              representantes.push({
                nit: parts[0].trim(),
                pais: parts[1]?.trim() || '',
                pasaporte: parts[2]?.trim() || '',
                nombre: parts[3]?.trim() || ''
              });
            }
          });
        }
        resultado['Representantes'] = representantes;

        // Comercios
        const comercios = [];
        const comerSection = bodyText.match(/Comercios\s+Nombre Comercial\s+Dirección[\s\S]+?(?=Especialidades|Solicitudes)/g);
        if (comerSection) {
          const lines = comerSection[0].split('\n').filter(l => l.trim() && !l.includes('Nombre Comercial') && !l.includes('Dirección') && !l.includes('Comercios'));
          lines.forEach(line => {
            const parts = line.split('\t');
            if (parts.length >= 2) {
              comercios.push({
                nombre: parts[0].trim(),
                direccion: parts[1]?.trim() || ''
              });
            }
          });
        }
        resultado['Comercios'] = comercios;

        // Especialidades
        const especialidades = [];
        const especSection = bodyText.match(/Especialidades\s+Código\s+Nombre[\s\S]+?(?=Solicitudes)/g);
        if (especSection) {
          const lines = especSection[0].split('\n').filter(l => l.trim() && !l.includes('Código') && !l.includes('Nombre') && !l.includes('Especialidades'));
          lines.forEach(line => {
            const parts = line.split('\t');
            if (parts.length >= 2) {
              especialidades.push({
                codigo: parts[0].trim(),
                nombre: parts[1]?.trim() || ''
              });
            }
          });
        }
        resultado['Especialidades'] = especialidades;

        // Solicitudes
        const solicitudes = [];
        const solicSection = bodyText.match(/Solicitudes Aprobadas[\s\S]+$/g);
        if (solicSection) {
          const lines = solicSection[0].split('\n').filter(l => l.match(/^[A-Z]{3,4}\d+/) || l.includes('Finalizada') || l.includes('En proceso'));
          lines.forEach(line => {
            const parts = line.split('\t');
            if (parts.length >= 4 && parts[0].match(/^[A-Z]{3,4}\d+/)) {
              solicitudes.push({
                numero: parts[0].trim(),
                tipo: parts[1]?.trim() || '',
                estado: parts[2]?.trim() || '',
                fechaAprobacion: parts[3]?.trim() || '',
                constancia: parts[4]?.trim() || '',
                resolucion: parts[5]?.trim() || ''
              });
            }
          });
        }
        resultado['Solicitudes'] = solicitudes;

        return resultado;
      });

      const nombre = datos['Nombre o razón social'];
      if (nombre && nombre !== 'Sin nombre') {
        console.log(`${prefix} ✅ OK: ${nombre}${attempt > 0 ? ` (reintento ${attempt})` : ''}`);
        return { nit, url: urlPublica, status: 'ENCONTRADO', data: datos };
      }

      // Si la página cargó pero el nombre está vacío: NIT no registrado en RGAE
      console.log(`${prefix} ❌ NIT no registrado o sin datos en RGAE.`);
      return { nit, url: urlPublica, status: 'ENCONTRADO', data: datos };

    } catch (err) {
      // Convertir errores técnicos de Puppeteer en mensajes amigables
      const esMensajeAmigable = (msg) => {
        if (msg.includes('Waiting for selector') || msg.includes('waiting failed') || msg.includes('timeout') || msg.includes('TimeoutError') || msg.includes('Cloudflare atascado') || msg.includes('Cloudflare no resuelto')) {
          return '(timeout/cloudflare)';
        }
        if (msg.includes('net::ERR_') || msg.includes('Navigation failed')) {
          return 'Error de conexión al cargar la página';
        }
        if (msg.includes('closed') || msg.includes('detached')) {
          return 'El navegador se cerró inesperadamente';
        }
        return msg;
      };

      const mensajeAmigable = esMensajeAmigable(err.message || '');
      const esTimeout = mensajeAmigable === '(timeout/cloudflare)';

      console.log(`${prefix} ⚡ Reintento ${attempt + 1}: ${mensajeAmigable} — abortando y reintentando...`);

      // Verificar si hay un Error 1015 de Cloudflare antes de abortar navegación
      try {
        const pageText = await page.evaluate(() => document.body ? document.body.innerText : '');
        if (pageText.includes('Error 1015') || pageText.toLowerCase().includes('rate limit')) {
          console.log(`${prefix} 🚨 BLOQUEO DETECTADO: Error 1015 (Rate Limit). Abortando el scraper completo.`);
          return { nit, url: urlPublica, status: 'RATE_LIMIT', data: null, error: 'Cloudflare Error 1015: Rate Limit' };
        }
      } catch (e) { }

      // Si Cloudflare congeló la página, abortamos la navegación actual
      // antes de reintentar para no quedar bloqueados.
      if (esTimeout) {
        await abortarNavegacion(page);
      }

      attempt++;
      if (attempt > MAX_RETRIES) {
        console.log(`${prefix} 🚫 Máximo de reintentos alcanzado.`);
        return { nit, url: urlPublica, status: 'ERROR', data: null, error: mensajeAmigable };
      }

      // Pausa corta antes del siguiente intento
      await new Promise(r => setTimeout(r, PAUSA_ENTRE_REINTENTOS_MS));
    }
  }
}

function exportarExcel(resultados) {
  // Hoja principal - exportar todos los campos del formulario
  const filas = resultados.map((r) => {
    const d = r.data ?? {};
    const rep = d['Representantes']?.[0] || {};
    const comer = d['Comercios']?.[0] || {};
    return {
      NIT: d['NIT'] || r.nit || '',
      Nombre: d['Nombre o razón social'] || '',
      Estado: d['Estado Actual'] || '',
      FechaInscripcion: d['Fecha de Inscripción'] || '',
      FechaPrecalif: d['Fecha Última Precalificación'] || '',
      TipoPrecalif: d['Tipo de Precalificación'] || '',
      Vigencia: d['Vigencia de Última Precalificación'] || '',
      NoConstancia: d['No. Constancia'] || '',
      NoResolucion: d['No. Resolución'] || '',
      Representante1: rep.nombre || '',
      Representante1NIT: rep.nit || '',
      Representante1Pais: rep.pais || '',
      Comercio1Nombre: comer.nombre || '',
      Comercio1Direccion: comer.direccion || '',
      URL: r.url,
      Error: r.error || '',
    };
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(filas);
  ws['!cols'] = [
    { wch: 15 }, { wch: 50 }, { wch: 20 }, { wch: 15 },
    { wch: 15 }, { wch: 45 }, { wch: 18 }, { wch: 20 },
    { wch: 25 }, { wch: 35 }, { wch: 18 }, { wch: 35 },
    { wch: 40 }, { wch: 60 }, { wch: 40 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Proveedores');

  // Hoja Representantes
  const reps = [];
  resultados.forEach(r => {
    if (r.data?.Representantes) {
      r.data.Representantes.forEach(rep => {
        reps.push({ NIT: r.nit, ...rep });
      });
    }
  });
  if (reps.length > 0) {
    const wsRep = XLSX.utils.json_to_sheet(reps);
    XLSX.utils.book_append_sheet(wb, wsRep, 'Representantes');
  }

  // Hoja Comercios
  const comer = [];
  resultados.forEach(r => {
    if (r.data?.Comercios) {
      r.data.Comercios.forEach(c => {
        comer.push({ NIT: r.nit, ...c });
      });
    }
  });
  if (comer.length > 0) {
    const wsComer = XLSX.utils.json_to_sheet(comer);
    XLSX.utils.book_append_sheet(wb, wsComer, 'Comercios');
  }

  // Hoja Especialidades
  const espec = [];
  resultados.forEach(r => {
    if (r.data?.Especialidades) {
      r.data.Especialidades.forEach(e => {
        espec.push({ NIT: r.nit, ...e });
      });
    }
  });
  if (espec.length > 0) {
    const wsEspec = XLSX.utils.json_to_sheet(espec);
    XLSX.utils.book_append_sheet(wb, wsEspec, 'Especialidades');
  }

  // Hoja Solicitudes
  const solic = [];
  resultados.forEach(r => {
    if (r.data?.Solicitudes) {
      r.data.Solicitudes.forEach(s => {
        solic.push({ NIT: r.nit, ...s });
      });
    }
  });
  if (solic.length > 0) {
    const wsSolic = XLSX.utils.json_to_sheet(solic);
    XLSX.utils.book_append_sheet(wb, wsSolic, 'Solicitudes');
  }

  XLSX.writeFile(wb, 'proveedores_rgae.xlsx');
  console.log(`📊 Excel exportado con ${wb.SheetNames.length} hojas`);
}

async function main() {
  console.log(`\n🚀 RGAE Scraper — ${NITS.length} NITs\n`);

  console.log('🌐 Abriendo navegador Chrome...');

  const isWindows = process.platform === 'win32';

  let headlessMode;
  if (process.env.HEADLESS === 'true') {
    headlessMode = true;
  } else if (isWindows) {
    headlessMode = false;
  } else {
    headlessMode = 'new';
  }

  const launchOptions = {
    headless: headlessMode,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      ...(isWindows && !headlessMode ? ['--window-position=0,0', '--window-size=1200,1000'] : [])
    ],
  };

  // Configuración de rutas por defecto según el sistema operativo
  const winDefaultPath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const macDefaultPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;

  if (envPath) {
    launchOptions.executablePath = envPath;
    console.log(`   Usando Chrome en: ${envPath}`);
  } else if (isWindows && fs.existsSync(winDefaultPath)) {
    launchOptions.executablePath = winDefaultPath;
    console.log(`   Usando Chrome por defecto en Windows: ${winDefaultPath}`);
  } else if (process.platform === 'darwin' && fs.existsSync(macDefaultPath)) {
    launchOptions.executablePath = macDefaultPath;
    console.log(`   Usando Chrome por defecto en macOS: ${macDefaultPath}`);
  } else {
    console.log('   Usando Chrome por defecto del sistema o descargado por Puppeteer');
  }

  console.log(`   Modo Headless: ${headlessMode}`);

  const browser = await puppeteer.launch(launchOptions);

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  console.log('   Navegando al primer NIT...');
  await page.goto(`${BASE_URL}/${NITS[0]}?source=guatecompras`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_NAVEGACION_INICIAL * 1000 });

  console.log(`\n⏳ Tienes hasta ${TIMEOUT_RESOLVER_CAPTCHA} segundos para resolver el captcha...`);
  console.log('⚠️  IMPORTANTE: NO CIERRES el navegador. Se cerrará solo al terminar.');

  // Auto-clicker para marcar el checkbox de Cloudflare automáticamente (versión humana)
  const autoClickCaptcha = setInterval(async () => {
    try {
      const iframes = await page.$$('iframe');
      for (const iframe of iframes) {
        const box = await iframe.boundingBox();
        // El widget de Cloudflare Turnstile suele medir aprox 300x65 px
        if (box && box.width > 200 && box.height > 40) {
          // El checkbox suele estar a unos 40px del borde izquierdo, centrado verticalmente
          const targetX = box.x + 40;
          const targetY = box.y + (box.height / 2);

          // Simular movimiento humano hacia el checkbox
          await page.mouse.move(targetX, targetY, { steps: 15 });

          // Pausa como lo haría un humano antes de dar click
          await new Promise(r => setTimeout(r, 150));

          // Click físico real
          await page.mouse.down();
          await new Promise(r => setTimeout(r, 80));
          await page.mouse.up();

          break; // Solo hacer clic en el primero que cumpla
        }
      }
    } catch (e) { }
  }, 2000);

  const FAST_FAIL_POLL_MS = 500;
  const maxPollsInicial = Math.ceil((TIMEOUT_RESOLVER_CAPTCHA * 1000) / FAST_FAIL_POLL_MS);
  let captchaResuelto = false;

  for (let intento = 0; intento < maxPollsInicial; intento++) {
    const estado = await page.evaluate(() => {
      const hayInput = !!document.querySelector('input[readonly]');
      const texto = document.body ? document.body.innerText : '';
      const verificando = texto.includes('Verificando acceso') || texto.includes('Verifying you are human');
      return { hayInput, verificando };
    });

    if (estado.hayInput) {
      captchaResuelto = true;
      console.log('✅ Captcha resuelto detectado. Iniciando extracción inmediatamente...\n');
      break;
    }

    // Si sigue atascado en "Verificando acceso" tras 5 segundos, recargamos la página
    // para forzar un nuevo intento del challenge en vez de esperar pasivamente.
    if (estado.verificando && intento > 0 && intento % 10 === 0) {
      console.log('⚡ Cloudflare atascado en "Verificando acceso" — recargando página para reintentar...');
      try {
        await page.goto(`${BASE_URL}/${NITS[0]}?source=guatecompras`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_FAST_FAIL_MS });
      } catch (_) { /* ignorar timeout de recarga */ }
    }

    await new Promise(r => setTimeout(r, FAST_FAIL_POLL_MS));
  }

  if (!captchaResuelto) {
    console.log('⚠️ Tiempo de captcha agotado. Iniciando bucle de todos modos...\n');
  }

  console.log('📡 Preparando navegador para Fast Fail...');
  await page.goto('about:blank');

  console.log('📡 Extrayendo datos...\n');
  console.log('--- INICIANDO BUCLE DE EXTRACCIÓN ---');

  const now = new Date();
  const dateStr = now.getFullYear() + '-' +
    String(now.getMonth() + 1).padStart(2, '0') + '-' +
    String(now.getDate()).padStart(2, '0') + '.' +
    String(now.getHours()).padStart(2, '0') + '.' +
    String(now.getMinutes()).padStart(2, '0')
  const backupFileName = `proveedores_rgae_${dateStr}.json`;

  const resultados = [];

  for (let i = 0; i < NITS.length; i++) {
    const isFirst = (i === 0);
    const resultado = await extraerDatos(page, NITS[i], i + 1, NITS.length, isFirst);
    resultados.push(resultado);

    // Guardar instantáneamente el NIT si fue exitoso en el archivo con fecha
    if (resultado.status === 'ENCONTRADO') {
      const exitosos = resultados.filter(r => r.status === 'ENCONTRADO');
      fs.writeFileSync('./backups/' + backupFileName, JSON.stringify(exitosos, null, 2));
    }

    if (resultado.status === 'RATE_LIMIT') {
      console.log('\n🛑 Scraper abortado debido a un bloqueo de Cloudflare (Error 1015 / Rate Limit).');
      break;
    }

    // Pausa corta si el NIT se extrajo sin reintentos (todo fluyó bien),
    // pausa completa si hubo que reintentar (protege contra rate-limit de Cloudflare).
    const pausaMs = resultado.status === 'ENCONTRADO'
      ? TIMEOUT_ENTRE_NITS_RAPIDO * 1000
      : TIMEOUT_ENTRE_NITS * 1000;

    await new Promise(r => setTimeout(r, pausaMs));

  }

  await browser.close();

  const encontradosFinales = resultados.filter(r => r.status === 'ENCONTRADO').length;

  if (encontradosFinales > 1) {
    fs.writeFileSync('proveedores_rgae.json', JSON.stringify(resultados, null, 2));
    console.log('\n💾 JSON guardado con éxito.');
    exportarExcel(resultados);
  } else {
    console.log('\n⚠️ Scraper finalizado con 1 o 0 resultados. No se sobrescribirá el archivo JSON ni el Excel principal para proteger tus datos.');
  }

  console.log(`\n📋 RESUMEN: ${encontradosFinales}/${resultados.length}\n`);
}

main().catch(console.error);
