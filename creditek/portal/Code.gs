// ============================================================
// CREDITEK — Google Apps Script Backend v2.0
// Portal B2B · WhatsApp Business API + HISTORIAL
// Autor: Oscar Pacheco · comercial@crediteksas.com
// ============================================================

// ⚙️ CONFIGURACIÓN — Reemplaza los valores marcados con ⬅️
var CONFIG = {
  PHONE_NUMBER_ID: '1171114292752516',
  WA_ACCESS_TOKEN: 'EAAVLHpnYaZAABR4T7rY65WcUpVxjUGYzcjMwQRWVIkmoEKE40d9N1rcnaH5ayZBZAEbOT1Da8x4vBiFHunZASkDT4gdCpZAwQZANYpT69aJ6LaAQ6WFyrAcAW5VJBaIGjl214zLJmLqjTCYZAcL3YapBmp7xs5PqrcbMywRCdet7SRK1DbunfumeHQYW1YRFQ88',
  WA_TEMPLATE_NAME: 'test_variable',                 // ⬅️ Cambiar por la plantilla final de confirmación de pedido
  WA_LANGUAGE_CODE: 'es',                            // 'es' para español, 'es_CO' si falla
  WA_API_VERSION: 'v19.0',

  // Nombres de hojas en Google Sheets
  SHEET_TIENDAS: 'TIENDAS',
  SHEET_HISTORIAL: 'HISTORIAL',
  SHEET_CATALOGO: 'CATALOGO',

  // Emails de cierre de periodo (mantiene lógica actual)
  EMAIL_COMERCIAL: 'comercial@crediteksas.com',
  EMAIL_GESTION: 'gestion@crediteksas.com'
};

// ============================================================
// ENRUTAMIENTO — doGet y doPost
// ============================================================

function doGet(e) {
  var action = e.parameter.action || '';
  var result;

  try {
    if (action === 'catalogo') {
      result = leerCatalogo_();
    } else if (action === 'leer' || action === 'leer_pedidos') {
      result = leerPedidos_();
    } else if (action === 'historial') {
      result = leerHistorial_(e.parameter.tienda || '');
    } else if (action === 'tiendas') {
      result = leerTiendas_();
    } else if (action === 'ping') {
      result = { ok: true, version: '2.0', ts: new Date().toISOString() };
    } else {
      result = { ok: false, error: 'Accion no reconocida: ' + action };
    }
  } catch (err) {
    result = { ok: false, error: err.message };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var result;

  try {
    var action = e.parameter.action || 'guardar';
    var body = JSON.parse(e.postData.contents);

    if (action === 'guardar' || action === 'guardar_pedido') {
      result = guardarPedido_(body);
    } else if (action === 'catalogo') {
      result = guardarCatalogo_(body);
    } else if (action === 'cierre_periodo') {
      result = cerrarPeriodo_(body);
    } else {
      result = { ok: false, error: 'Accion POST no reconocida: ' + action };
    }
  } catch (err) {
    result = { ok: false, error: err.message };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// GUARDAR PEDIDO — Función principal del flujo
// ============================================================

function guardarPedido_(items) {
  if (!items || !items.length) {
    return { ok: false, error: 'Pedido vacio' };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tiendaNombre = items[0].tienda;
  var ciudad = items[0].ciudad;
  var fecha = new Date();

  // Usar número de pedido enviado por frontend, o generar uno nuevo
  var numeroPedido = items[0].numeroPedido || generarNumeroPedido_();

  // ── 1. Guardar en hoja de pedidos pendientes por tienda ──
  var sheetNombre = tiendaNombre + ' - ' + ciudad;
  var sheet = ss.getSheetByName(sheetNombre);
  if (!sheet) {
    sheet = ss.insertSheet(sheetNombre);
    sheet.appendRow(['Fecha', 'No. Pedido', 'Producto', 'Proveedor', 'Cantidad', 'Precio Proveedor', 'Precio Tienda']);
    sheet.getRange(1, 1, 1, 7)
      .setFontWeight('bold')
      .setBackground('#0B1E3D')
      .setFontColor('#00C4CC');
  }

  items.forEach(function(item) {
    sheet.appendRow([
      Utilities.formatDate(fecha, 'America/Bogota', 'yyyy-MM-dd HH:mm'),
      numeroPedido,
      item.producto || '',
      item.proveedor || '',
      Number(item.cantidad) || 0,
      Number(item.precioProveedor) || 0,
      Number(item.precioCredilek) || 0
    ]);
  });

  // ── 2. Registrar en HISTORIAL ──
  guardarEnHistorial_(items, numeroPedido, fecha, tiendaNombre, ciudad);

  // ── 3. Enviar confirmación por WhatsApp ──
  var resultWA = enviarConfirmacionWA_(items, numeroPedido, tiendaNombre, ciudad);

  return {
    ok: true,
    numeroPedido: numeroPedido,
    tienda: tiendaNombre,
    ciudad: ciudad,
    whatsapp: resultWA
  };
}

// ============================================================
// WHATSAPP BUSINESS API
// ============================================================

function enviarConfirmacionWA_(items, numeroPedido, tiendaNombre, ciudad) {
  try {
    // Verificar configuración
    if (CONFIG.WA_ACCESS_TOKEN === 'PEGA_AQUI_TU_TOKEN_60_DIAS') {
      Logger.log('WhatsApp: Token no configurado. Omitiendo envio.');
      return { enviado: false, motivo: 'Token no configurado' };
    }
    if (CONFIG.WA_TEMPLATE_NAME === 'PEGA_AQUI_NOMBRE_PLANTILLA') {
      Logger.log('WhatsApp: Plantilla no configurada. Omitiendo envio.');
      return { enviado: false, motivo: 'Plantilla no configurada' };
    }

    // Obtener teléfono del encargado desde hoja TIENDAS
    var telefono = obtenerTelefonoTienda_(tiendaNombre, ciudad);
    if (!telefono) {
      Logger.log('WhatsApp: No hay telefono registrado para ' + tiendaNombre + ' / ' + ciudad);
      return { enviado: false, motivo: 'Sin telefono registrado para ' + tiendaNombre };
    }

    var totalUnidades = items.reduce(function(s, i) { return s + Number(i.cantidad); }, 0);
    var totalValor = items.reduce(function(s, i) {
      return s + (Number(i.precioCredilek) * Number(i.cantidad));
    }, 0);

    // Formatear valor en pesos colombianos
    var valorFormateado = '$' + Math.round(totalValor).toLocaleString('es-CO');

    // Payload para WhatsApp Cloud API
    // test_variable usa 1 sola variable {{1}} — empaquetamos todo el resumen ahí
    // Cuando se apruebe conf_pedido_b2b (4 variables), cambiar WA_TEMPLATE_NAME y activar el bloque de abajo
    var resumenCompleto = '✅ Pedido ' + numeroPedido + ' | Tienda: ' + tiendaNombre +
                          ' | ' + String(totalUnidades) + ' uds | Total: ' + valorFormateado;

    var parameters;
    if (CONFIG.WA_TEMPLATE_NAME === 'test_variable') {
      // Plantilla de prueba: solo {{1}}
      parameters = [{ type: 'text', text: resumenCompleto }];
    } else {
      // Plantilla de producción conf_pedido_b2b: {{1}} {{2}} {{3}} {{4}}
      parameters = [
        { type: 'text', text: tiendaNombre },
        { type: 'text', text: numeroPedido },
        { type: 'text', text: String(totalUnidades) },
        { type: 'text', text: valorFormateado }
      ];
    }

    var payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: telefono.toString().replace(/[\s+\-().]/g, ''), // limpiar a solo dígitos
      type: 'template',
      template: {
        name: CONFIG.WA_TEMPLATE_NAME,
        language: { code: CONFIG.WA_LANGUAGE_CODE },
        components: [{ type: 'body', parameters: parameters }]
      }
    };

    var url = 'https://graph.facebook.com/' + CONFIG.WA_API_VERSION + '/' +
              CONFIG.PHONE_NUMBER_ID + '/messages';

    var response = UrlFetchApp.fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + CONFIG.WA_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    var statusCode = response.getResponseCode();
    var responseText = response.getContentText();
    var responseBody = JSON.parse(responseText);

    Logger.log('WhatsApp [' + statusCode + '] → ' + tiendaNombre + ' (' + telefono + '): ' + responseText);

    if (statusCode === 200 && responseBody.messages) {
      // Actualizar estado en HISTORIAL
      actualizarEstadoWA_(numeroPedido, 'WA_ENVIADO');
      return {
        enviado: true,
        messageId: responseBody.messages[0].id,
        telefono: telefono
      };
    } else {
      var errorMsg = responseBody.error ? responseBody.error.message : 'Error desconocido';
      actualizarEstadoWA_(numeroPedido, 'WA_ERROR');
      return { enviado: false, error: errorMsg, statusCode: statusCode };
    }

  } catch (err) {
    Logger.log('Error critico WhatsApp: ' + err.message);
    return { enviado: false, error: err.message };
  }
}

function obtenerTelefonoTienda_(tiendaNombre, ciudad) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.SHEET_TIENDAS);
  if (!sheet) {
    Logger.log('Hoja TIENDAS no existe. Ejecuta inicializarTiendas() primero.');
    return null;
  }

  var data = sheet.getDataRange().getValues();
  // Buscar por nombre + ciudad para evitar duplicados (ej: Creditel Chinú vs Creditel Coveñas)
  for (var i = 1; i < data.length; i++) {
    var nombreSheet = String(data[i][1]).trim();
    var ciudadSheet = String(data[i][2]).trim();
    var tel         = String(data[i][3]).trim();

    var coincideNombre = nombreSheet === tiendaNombre.trim();
    var coincideCiudad = !ciudad || ciudadSheet === ciudad.trim();

    if (coincideNombre && coincideCiudad && tel !== '') {
      return tel;
    }
  }
  // Fallback: buscar solo por nombre si no se encontró con ciudad
  for (var j = 1; j < data.length; j++) {
    if (String(data[j][1]).trim() === tiendaNombre.trim()) {
      var t = String(data[j][3]).trim();
      return t !== '' ? t : null;
    }
  }
  return null;
}

// ============================================================
// HISTORIAL
// ============================================================

function guardarEnHistorial_(items, numeroPedido, fecha, tiendaNombre, ciudad) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hist = ss.getSheetByName(CONFIG.SHEET_HISTORIAL);

  if (!hist) {
    hist = ss.insertSheet(CONFIG.SHEET_HISTORIAL);
    var headers = ['Fecha', 'No. Pedido', 'Tienda', 'Ciudad', 'Productos', 'Total Unidades', 'Valor Total COP', 'Estado WA'];
    hist.appendRow(headers);
    hist.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold')
      .setBackground('#0B1E3D')
      .setFontColor('#00C4CC');
    hist.setFrozenRows(1);
    // Formato moneda en columna G
    hist.getRange('G:G').setNumberFormat('$#,##0');
  }

  var totalUnidades = items.reduce(function(s, i) { return s + Number(i.cantidad); }, 0);
  var totalValor = items.reduce(function(s, i) {
    return s + (Number(i.precioCredilek) * Number(i.cantidad));
  }, 0);
  var productos = items.map(function(i) {
    return i.producto + ' ×' + i.cantidad;
  }).join(' | ');

  hist.appendRow([
    Utilities.formatDate(fecha, 'America/Bogota', 'yyyy-MM-dd HH:mm'),
    numeroPedido,
    tiendaNombre,
    ciudad,
    productos,
    totalUnidades,
    totalValor,
    'PENDIENTE'
  ]);
}

function actualizarEstadoWA_(numeroPedido, estado) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var hist = ss.getSheetByName(CONFIG.SHEET_HISTORIAL);
    if (!hist) return;

    var data = hist.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (data[i][1] === numeroPedido) {
        hist.getRange(i + 1, 8).setValue(estado); // Columna H = Estado WA
        return;
      }
    }
  } catch (err) {
    Logger.log('Error actualizando estado WA: ' + err.message);
  }
}

function leerHistorial_(tienda) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hist = ss.getSheetByName(CONFIG.SHEET_HISTORIAL);
  if (!hist) return { ok: true, pedidos: [] };

  var data = hist.getDataRange().getValues();
  if (data.length <= 1) return { ok: true, pedidos: [] };

  var headers = data[0];
  var rows = data.slice(1).map(function(row) {
    var obj = {};
    headers.forEach(function(h, i) {
      obj[h] = row[i] instanceof Date
        ? Utilities.formatDate(row[i], 'America/Bogota', 'yyyy-MM-dd HH:mm')
        : row[i];
    });
    return obj;
  });

  if (tienda) {
    rows = rows.filter(function(r) { return r['Tienda'] === tienda; });
  }

  // Más reciente primero
  rows.reverse();

  return { ok: true, pedidos: rows };
}

// ============================================================
// GENERADOR DE NÚMERO DE PEDIDO — CRD-YYYYMMDD-XXX
// ============================================================

function generarNumeroPedido_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hist = ss.getSheetByName(CONFIG.SHEET_HISTORIAL);
  var fechaStr = Utilities.formatDate(new Date(), 'America/Bogota', 'yyyyMMdd');
  var contador = 1;

  if (hist) {
    var data = hist.getDataRange().getValues();
    var prefijo = 'CRD-' + fechaStr + '-';
    data.slice(1).forEach(function(row) {
      if (String(row[1]).indexOf(prefijo) === 0) contador++;
    });
  }

  return 'CRD-' + fechaStr + '-' + String(contador).padStart(3, '0');
}

// ============================================================
// TIENDAS — Hoja maestra con teléfonos
// ============================================================

function leerTiendas_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.SHEET_TIENDAS);
  if (!sheet) return { ok: true, tiendas: [] };

  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return { ok: true, tiendas: [] };

  var headers = data[0];
  var tiendas = data.slice(1).map(function(row) {
    var obj = {};
    headers.forEach(function(h, i) { obj[h] = row[i]; });
    return obj;
  });

  return { ok: true, tiendas: tiendas };
}

/**
 * Ejecuta manualmente en Apps Script para crear la hoja TIENDAS con las 11 tiendas.
 * Menú: Ejecutar → inicializarTiendas
 */
function inicializarTiendas() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var existing = ss.getSheetByName(CONFIG.SHEET_TIENDAS);
  if (existing) {
    var confirm = Browser.msgBox('La hoja TIENDAS ya existe. ¿Recrearla?', Browser.Buttons.YES_NO);
    if (confirm !== 'yes') return;
    ss.deleteSheet(existing);
  }

  var sheet = ss.insertSheet(CONFIG.SHEET_TIENDAS);
  var headers = ['tienda_id', 'nombre', 'ciudad', 'telefono_encargado', 'email_encargado', 'activa'];
  sheet.appendRow(headers);
  sheet.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold')
    .setBackground('#0B1E3D')
    .setFontColor('#00C4CC');

  // 10 tiendas con teléfonos reales (formato WhatsApp: 57 + número colombiano)
  var tiendas = [
    ['CRD-TOL-01', 'Cellfiao Tolú',       'Tolú',           '573112889758', 'luisa.medrano@crediteksas.com',   'SI'],
    ['CRD-COR-01', 'Móvil Shoping',       'Corozal',        '573014991556', 'andrea.velez@crediteksas.com',    'SI'],
    ['CRD-COR-02', 'Celfiao Tecnología',  'Corozal',        '573113052878', 'katty.puello@crediteksas.com',    'SI'],
    ['CRD-COR-03', 'Creditel Store',      'Corozal',        '573144220401', 'wendy.perez@crediteksas.com',     'SI'],
    ['CRD-CHI-01', 'Chinú Cell',          'Chinú',          '573234052533', 'luis.marin@crediteksas.com',      'SI'],
    ['CRD-CHI-02', 'Creditel Chinú',      'Chinú',          '573052044046', 'yajaira.salas@crediteksas.com',   'SI'],
    ['CRD-CHI-03', 'Sonivox Chinú',       'Chinú',          '573052044046', 'vanessa.salas@crediteksas.com',   'SI'],
    ['CRD-CIE-01', 'OroCell',             'Ciénaga de Oro', '573006177114', 'carmen.viggiani@crediteksas.com', 'SI'],
    ['CRD-CIE-02', 'KrediSinu',           'Ciénaga de Oro', '573021297349', 'digna.pantoja@crediteksas.com',   'SI'],
    ['CRD-COV-01', 'Creditel Coveñas',    'Coveñas',        '573008529877', 'yulimar.briceno@crediteksas.com', 'SI']
  ];

  tiendas.forEach(function(row) { sheet.appendRow(row); });

  // Formato de columna telefono_encargado como texto para evitar que Google Sheets corte ceros
  sheet.getRange('D:D').setNumberFormat('@');

  sheet.autoResizeColumns(1, headers.length);

  Browser.msgBox(
    '✅ Hoja TIENDAS creada con 11 tiendas.\n\n' +
    '⚠️ Completa la columna D (telefono_encargado) con los números WhatsApp.\n' +
    'Formato: 573241234567 (código país + número, sin + ni espacios)'
  );
}

// ============================================================
// CATÁLOGO
// ============================================================

function leerCatalogo_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.SHEET_CATALOGO);
  if (!sheet) return { ok: true, productos: [] };

  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return { ok: true, productos: [] };

  var headers = data[0];
  var productos = data.slice(1).map(function(row, i) {
    var obj = { id: i };
    headers.forEach(function(h, j) { obj[h] = row[j]; });
    return obj;
  }).filter(function(p) { return p.nombre && p.precioVenta > 0; });

  return { ok: true, productos: productos };
}

function guardarCatalogo_(productos) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.SHEET_CATALOGO);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_CATALOGO);
  } else {
    sheet.clearContents();
  }

  sheet.appendRow(['proveedor', 'nombre', 'precioCompra', 'precioVenta', 'marca', 'categoria']);
  sheet.getRange(1, 1, 1, 6)
    .setFontWeight('bold')
    .setBackground('#0B1E3D')
    .setFontColor('#00C4CC');

  productos.forEach(function(p) {
    sheet.appendRow([p.proveedor, p.nombre, p.precioCompra, p.precioVenta, p.marca, p.categoria]);
  });

  return { ok: true, total: productos.length };
}

// ============================================================
// PEDIDOS PENDIENTES (lógica original preservada)
// ============================================================

function leerPedidos_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  var pedidos = [];

  var hojasSistema = [
    CONFIG.SHEET_TIENDAS,
    CONFIG.SHEET_HISTORIAL,
    CONFIG.SHEET_CATALOGO,
    'Hoja 1', 'Sheet1', 'RESUMEN'
  ];

  sheets.forEach(function(sheet) {
    var nombre = sheet.getName();
    // Excluir hojas del sistema
    if (hojasSistema.indexOf(nombre) !== -1) return;
    // Las hojas de tiendas tienen formato "Tienda - Ciudad"
    if (nombre.indexOf(' - ') === -1) return;

    var data = sheet.getDataRange().getValues();
    if (data.length <= 1) return;

    data.slice(1).forEach(function(row) {
      if (!row[2]) return; // sin producto
      pedidos.push({
        fecha:           row[0] instanceof Date
                           ? Utilities.formatDate(row[0], 'America/Bogota', 'yyyy-MM-dd HH:mm')
                           : row[0],
        numeroPedido:    row[1] || '',
        tienda:          nombre.split(' - ')[0],
        ciudad:          nombre.split(' - ')[1] || '',
        producto:        row[2],
        proveedor:       row[3],
        cantidad:        row[4],
        precioProveedor: row[5],
        precioCredilek:  row[6]
      });
    });
  });

  return { ok: true, pedidos: pedidos };
}

// ============================================================
// CIERRE DE PERIODO — Email consolidado (lógica original)
// ============================================================

function cerrarPeriodo_(pedidos) {
  if (!pedidos || !pedidos.length) {
    return { ok: false, error: 'Sin pedidos para cerrar' };
  }

  // Agrupar por proveedor → ciudad
  var resumen = {};
  pedidos.forEach(function(p) {
    var key = p.proveedor || 'Sin proveedor';
    if (!resumen[key]) resumen[key] = {};
    if (!resumen[key][p.ciudad]) resumen[key][p.ciudad] = [];
    resumen[key][p.ciudad].push(p);
  });

  // Construir HTML del email
  var html = '<h2 style="color:#0B1E3D">Creditek — Cierre de Periodo</h2>';
  html += '<p style="color:#666">Fecha: ' + Utilities.formatDate(new Date(), 'America/Bogota', 'dd/MM/yyyy HH:mm') + '</p>';
  html += '<hr>';

  Object.keys(resumen).sort().forEach(function(proveedor) {
    html += '<h3 style="color:#0B1E3D;margin-top:20px">' + proveedor + '</h3>';
    Object.keys(resumen[proveedor]).sort().forEach(function(ciudad) {
      html += '<h4 style="color:#00C4CC;margin-left:16px">📍 ' + ciudad + '</h4>';
      html += '<table border="1" cellpadding="6" cellspacing="0" style="margin-left:32px;border-collapse:collapse;font-size:13px">';
      html += '<tr style="background:#0B1E3D;color:#00C4CC"><th>Tienda</th><th>Producto</th><th>Cant.</th><th>Precio</th><th>Subtotal</th></tr>';
      var totalProveedor = 0;
      resumen[proveedor][ciudad].forEach(function(p) {
        var sub = Number(p.precioProveedor) * Number(p.cantidad);
        totalProveedor += sub;
        html += '<tr><td>' + p.tienda + '</td><td>' + p.producto + '</td><td>' + p.cantidad + '</td>';
        html += '<td>$' + Math.round(Number(p.precioProveedor)).toLocaleString('es-CO') + '</td>';
        html += '<td>$' + Math.round(sub).toLocaleString('es-CO') + '</td></tr>';
      });
      html += '</table>';
    });
  });

  var total = pedidos.reduce(function(s, p) { return s + Number(p.precioProveedor) * Number(p.cantidad); }, 0);
  html += '<hr><h3>Total a pagar proveedores: $' + Math.round(total).toLocaleString('es-CO') + '</h3>';

  // Enviar email
  MailApp.sendEmail({
    to: CONFIG.EMAIL_COMERCIAL + ',' + CONFIG.EMAIL_GESTION,
    subject: 'Creditek · Cierre Periodo · ' + Utilities.formatDate(new Date(), 'America/Bogota', 'dd/MM/yyyy'),
    htmlBody: html
  });

  // Archivar pedidos (mover a hoja HISTORIAL con estado CERRADO)
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var histSheet = ss.getSheetByName(CONFIG.SHEET_HISTORIAL);
  if (histSheet) {
    pedidos.forEach(function(p) {
      // Marcar pedidos cerrados
      var data = histSheet.getDataRange().getValues();
      for (var i = 1; i < data.length; i++) {
        if (data[i][1] === p.numeroPedido) {
          histSheet.getRange(i + 1, 8).setValue('PERIODO_CERRADO');
        }
      }
    });
  }

  return { ok: true, emailEnviado: true, total: total };
}

// ============================================================
// UTILIDAD — Test rápido de WhatsApp (ejecutar manualmente)
// ============================================================

/**
 * Ejecuta este test para verificar que el token y la plantilla funcionan.
 * Menú: Ejecutar → testWhatsApp
 * Envía un mensaje de prueba al número de la cuenta de Creditek.
 */
function testWhatsApp() {
  var testItems = [
    { tienda: 'TEST', ciudad: 'TEST', producto: 'SAMSUNG A16 4/128GB', cantidad: 2, precioCredilek: 470000 }
  ];
  var result = enviarConfirmacionWA_(testItems, 'CRD-TEST-001', 'KrediSinu Technology', 'Ciénaga de Oro');
  Logger.log('Test WhatsApp: ' + JSON.stringify(result));
  Browser.msgBox('Resultado test WA:\n' + JSON.stringify(result, null, 2));
}
