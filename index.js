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

// Constantes de Tiempo (en segundos) — configurables desde la UI
const TIMEOUT_GENERAL = parseFloat(process.env.TIMEOUT_GENERAL) || 4;
const TIMEOUT_WAIT_CLOUDFLARE = parseFloat(process.env.TIMEOUT_WAIT_CLOUDFLARE) || 20;

// No alterar los de abajo solo cambiar los valores  TIMEOUT_GENERAL y TIMEOUT_WAIT_CLOUDFLARE

const TIMEOUT_PAGINA_CARGA = TIMEOUT_GENERAL;
const TIMEOUT_ESPERA_POST_CARGA = 0.3;
const TIMEOUT_RESOLVER_CAPTCHA = TIMEOUT_GENERAL;
const TIMEOUT_ENTRE_NITS = 0.3;
const TIMEOUT_NAVEGACION_INICIAL = TIMEOUT_GENERAL;
  console.log("TIMEOUT_GENERAL" + TIMEOUT_GENERAL);
  console.log("TIMEOUT_WAIT_CLOUDFLARE" + TIMEOUT_WAIT_CLOUDFLARE)
async function extraerDatos(page, nit, index, total, skipNavigation = false) {
  const MAX_RETRIES = 5;
  let attempt = 0;
  let datos = null;
  const urlPublica = `${BASE_URL}/${nit}?source=guatecompras`;
  const prefix = `[${index}/${total}] ${nit} → `;


  // Timeouts dinámicos
  let timeoutNavegacion = TIMEOUT_PAGINA_CARGA;  // segundos
  let timeoutSelector = TIMEOUT_WAIT_CLOUDFLARE;                       // segundos (usado en waitForSelector)

  while (attempt <= MAX_RETRIES) {
    try {
      if (page.isClosed()) {
        throw new Error('La página del navegador se cerró inesperadamente.');
      }

      if (!skipNavigation || attempt > 0) {
        await page.goto(urlPublica, { waitUntil: 'networkidle2', timeout: timeoutNavegacion * 1000 });
      }

      // Esperar a que la página pase el reto de Cloudflare
      await page.waitForSelector('input[readonly]', { timeout: timeoutSelector * 1000 });

      // Esperar un momento de seguridad adicional para que se rellene el valor de los inputs
      await new Promise(r => setTimeout(r, TIMEOUT_ESPERA_POST_CARGA * 1000));


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
        if (msg.includes('Waiting for selector') || msg.includes('waiting failed') || msg.includes('timeout') || msg.includes('TimeoutError')) {
          return '(timeout)';
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
      const esTimeout = mensajeAmigable === '(timeout)';

      let logMensaje = `${prefix} ❌ Error en intento ${attempt + 1}: ${mensajeAmigable}`;

      // Escalado progresivo de timeouts ante timeout
      if (esTimeout && attempt < MAX_RETRIES) {
        if (attempt === 0) {
          // Para el segundo intento (intento 2), aumentamos 50%
          timeoutNavegacion = Math.round(TIMEOUT_PAGINA_CARGA * 2);
          timeoutSelector = Math.round(25 * 3);
          logMensaje += ` (aumentando espera a ${timeoutNavegacion}s para reintento)`;
        } else if (attempt === 1) {
          // Para el tercer intento (intento 3), aumentamos 100% (el doble)
          timeoutNavegacion = TIMEOUT_PAGINA_CARGA * 2.5;
          timeoutSelector = 25 * 3.5;
          logMensaje += ` (aumentando espera a ${timeoutNavegacion}s para reintento)`;
        }
        else if (attempt === 2) {
          // Para el tercer intento (intento 3), aumentamos 100% (el doble)
          timeoutNavegacion = TIMEOUT_PAGINA_CARGA * 3;
          timeoutSelector = 25 * 4;
          logMensaje += ` (aumentando espera a ${timeoutNavegacion}s para reintento)`;
        }
        else if (attempt === 3) {
          // Para el tercer intento (intento 3), aumentamos 100% (el doble)
          timeoutNavegacion = TIMEOUT_PAGINA_CARGA * 3.5;
          timeoutSelector = 25 * 4.5;
          logMensaje += ` (aumentando espera a ${timeoutNavegacion}s para reintento)`;
        }
         else if (attempt === 4) {
          // Para el tercer intento (intento 3), aumentamos 100% (el doble)
          timeoutNavegacion = TIMEOUT_PAGINA_CARGA * 4;
          timeoutSelector = 25 * 5;
          logMensaje += ` (aumentando espera a ${timeoutNavegacion}s para reintento)`;
        }
      }


      console.log(logMensaje);


      attempt++;
      if (attempt > MAX_RETRIES) {
        return { nit, url: urlPublica, status: 'ERROR', data: null, error: mensajeAmigable };
      }
      await new Promise(r => setTimeout(r, 2000));
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
  await page.goto(`${BASE_URL}/${NITS[0]}?source=guatecompras`, { waitUntil: 'networkidle2', timeout: TIMEOUT_NAVEGACION_INICIAL * 1000 });

  console.log(`\n⏳ Espera ${TIMEOUT_RESOLVER_CAPTCHA} segundos para resolver el captcha...`);
  console.log('⚠️  IMPORTANTE: NO CIERRES el navegador. Se cerrará solo al terminar.');

  await new Promise(r => setTimeout(r, TIMEOUT_RESOLVER_CAPTCHA * 1000));

  console.log('📡 Extrayendo datos...\n');
  console.log('--- INICIANDO BUCLE DE EXTRACCIÓN ---');

  const resultados = [];

  for (let i = 0; i < NITS.length; i++) {
    const isFirst = (i === 0);
    const resultado = await extraerDatos(page, NITS[i], i + 1, NITS.length, isFirst);
    resultados.push(resultado);
    await new Promise(r => setTimeout(r, TIMEOUT_ENTRE_NITS * 1000));
  }

  await browser.close();

  fs.writeFileSync('proveedores_rgae.json', JSON.stringify(resultados, null, 2));
  console.log('\n💾 JSON guardado');
  exportarExcel(resultados);

  const encontrados = resultados.filter(r => r.status === 'ENCONTRADO').length;
  console.log(`\n📋 RESUMEN: ${encontrados}/${resultados.length}\n`);
}

main().catch(console.error);
