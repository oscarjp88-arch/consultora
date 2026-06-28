#!/usr/bin/env python3
"""
CREDITEK · Imágenes desde 6 fuentes colombianas/internacionales
Orden por marca: Alkosto, Falabella, Éxito, Ktronix, Amazon MX, Mercado Libre API
Umbral de similitud: 0.50 (más estricto que la versión anterior 0.35)
"""

import os, re, io, json, time, subprocess
from datetime import datetime
from urllib.parse import quote_plus

try:
    import requests
    from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from google.auth.transport.requests import Request
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaIoBaseUpload
except ImportError as e:
    print(f"✗ Falta: {e}")
    raise

# ── RUTAS ─────────────────────────────────────────────────────────────────────
REPO_PATH  = '/Users/oscarpacheco/consultora'
CREDS_PATH = f'{REPO_PATH}/credentials.json'
TOKEN_PATH = f'{REPO_PATH}/token.json'
DATA_DIR   = f'{REPO_PATH}/creditek/data'
SPECS_DIR  = f'{DATA_DIR}/specs'
IMGS_DIR   = f'{REPO_PATH}/creditek/assets/imagenes'
CATALOGO   = f'{DATA_DIR}/catalogo.json'

# ── DRIVE ─────────────────────────────────────────────────────────────────────
CARPETA_BASE = '1QtZ4K1770F3uXrbic9_wPZtfgy6U-58y'
SCOPES       = ['https://www.googleapis.com/auth/drive']

# ── MARCAS ────────────────────────────────────────────────────────────────────
MARCAS_RECONOCIDAS = {
    'SAMSUNG','APPLE','IPHONE','XIAOMI','MOTOROLA','MOTO','HONOR','OPPO',
    'REALME','INFINIX','TECNO','NOKIA','ZTE','HUAWEI','VIVO','ALCATEL',
    'POCO','TCL','IFFALCON','ITEL','JBL','BOSE','ACER','HP','ASUS',
    'LENOVO','IPAD','NUBIA',
}

UMBRAL = 0.50   # Similitud mínima — más alto = menos falsos positivos
DELAY  = 7      # Segundos entre productos

# ── AUTH DRIVE ────────────────────────────────────────────────────────────────
def autenticar_drive():
    creds = None
    if os.path.exists(TOKEN_PATH):
        creds = Credentials.from_authorized_user_file(TOKEN_PATH, SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(CREDS_PATH, SCOPES)
            creds = flow.run_local_server(port=0)
        with open(TOKEN_PATH, 'w') as f:
            f.write(creds.to_json())
    return build('drive', 'v3', credentials=creds)

def archivo_existe(svc, nombre, parent_id):
    q = f"name='{nombre}' and '{parent_id}' in parents and trashed=false"
    res = svc.files().list(q=q, fields='files(id)').execute().get('files', [])
    return res[0]['id'] if res else None

def buscar_o_crear_carpeta(svc, nombre, parent_id):
    q = (f"name='{nombre}' and '{parent_id}' in parents and "
         f"mimeType='application/vnd.google-apps.folder' and trashed=false")
    res = svc.files().list(q=q, fields='files(id)').execute().get('files', [])
    if res:
        return res[0]['id']
    meta = {'name': nombre, 'mimeType': 'application/vnd.google-apps.folder', 'parents': [parent_id]}
    return svc.files().create(body=meta, fields='id').execute()['id']

def subir_imagen(svc, nombre, bytes_img, parent_id):
    existente = archivo_existe(svc, nombre, parent_id)
    mime = 'image/webp' if bytes_img[:4] == b'RIFF' else 'image/jpeg'
    media = MediaIoBaseUpload(io.BytesIO(bytes_img), mimetype=mime, resumable=False)
    if existente:
        return svc.files().update(fileId=existente, media_body=media).execute()['id']
    meta = {'name': nombre, 'parents': [parent_id]}
    return svc.files().create(body=meta, media_body=media, fields='id').execute()['id']

# ── IMAGEN UTILS ──────────────────────────────────────────────────────────────
def _valida(bytes_img):
    if not bytes_img or len(bytes_img) < 15_000:
        return False
    hdr = bytes_img[:4]
    return (hdr[:3] == b'\xff\xd8\xff' or
            hdr == b'\x89PNG' or
            hdr == b'RIFF' or
            bytes_img[:6] in (b'GIF87a', b'GIF89a'))

def _descargar(url, referer=''):
    try:
        H = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                          'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Referer': referer,
            'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        }
        r = requests.get(url, headers=H, timeout=18)
        if r.status_code == 200 and len(r.content) > 5000:
            return r.content
    except Exception:
        pass
    return None

# ── SIMILITUD ─────────────────────────────────────────────────────────────────
def _palabras_clave(texto):
    SKIP = {'DE','LA','EL','CON','Y','A','EN','O','4G','5G','DS','SIM',
            'DUAL','PLUS','PRO','MAX','LITE','NEO','SERIES','CELULAR',
            'SMARTPHONE','TABLET','PORTÁTIL','LAPTOP','NOTEBOOK','PARLANTE',
            'CON','SIN','PARA','USB','TYPE','WIFI','GB','TB','RAM'}
    palabras = set(re.findall(r'[A-Z0-9]+', texto.upper()))
    return {p for p in palabras if p not in SKIP and not (p.isdigit() and len(p) <= 3)}

def _similitud(ref_limpia, titulo):
    ref_w = _palabras_clave(ref_limpia)
    tit_w = _palabras_clave(titulo)
    if not ref_w:
        return 0.0
    return len(ref_w & tit_w) / len(ref_w)

def _limpiar_para_busqueda(referencia):
    clean = re.sub(r'\s+\d+[/]?\d*\s*GB.*', '', referencia.strip(), flags=re.IGNORECASE)
    clean = re.sub(r'\s+\d+SIM.*', '', clean.strip(), flags=re.IGNORECASE)
    return clean.strip()

# ── IMAGEN PRINCIPAL GENÉRICA ─────────────────────────────────────────────────
def _mejor_imagen_pagina(page, referer=''):
    """
    Extrae la imagen de producto más grande de la página actual.
    Filtra por aspect ratio (cuadrada = producto) y tamaño mínimo.
    """
    try:
        page.evaluate("window.scrollBy(0, 300)")
        page.wait_for_timeout(700)
        mejor_bytes = None
        mejor_area  = 0
        for img in page.query_selector_all('img'):
            src = (img.get_attribute('src') or
                   img.get_attribute('data-src') or
                   img.get_attribute('data-zoom-image') or '')
            if not src.startswith('http'):
                continue
            sl = src.lower()
            if any(x in sl for x in ('logo', 'icon', 'sprite', 'banner', 'header', '.svg', 'pixel')):
                continue
            bb = img.bounding_box()
            if not bb:
                continue
            w, h = bb['width'], bb['height']
            if w < 150 or h < 150:
                continue
            ratio = max(w, h) / min(w, h) if min(w, h) > 0 else 99
            if ratio > 2.5:   # excluir banners horizontales
                continue
            area = w * h
            if area > mejor_area:
                b = _descargar(src, referer)
                if _valida(b):
                    mejor_area  = area
                    mejor_bytes = b
        return mejor_bytes
    except Exception:
        return None

# ── SPECS PARSERS ─────────────────────────────────────────────────────────────
def _parsear_specs_alkosto(body):
    specs = {}
    def _b(pat):
        m = re.search(pat, body, re.IGNORECASE)
        return m.group(1).strip() if m else ''
    pulg = _b(r'Tamaño Pantalla\s*\n?\s*([\d.,]+\s*Pulgadas?)')
    tipo = _b(r'Tipo de Pantalla\s*\n?\s*(\w+)')
    if pulg: specs['pantalla'] = f"{pulg}{(' ' + tipo) if tipo else ''}"
    ram  = _b(r'Memoria RAM\s*\n?\s*([\d.,]+\s*GB)')
    inte = _b(r'Memoria Interna\s*\n?\s*([\d.,]+\s*GB)')
    if ram or inte: specs['ram_almacenamiento'] = ' / '.join(filter(None, [ram, inte]))
    post = _b(r'Resolucion Camara Posterior 1\s*\n?\s*([\d.,]+\s*Megapixeles?)')
    fron = _b(r'Resolucion Camara Frontal 1\s*\n?\s*([\d.,]+\s*Megapixeles?)')
    if post: specs['camara'] = f"{post} posterior{(', ' + fron + ' frontal') if fron else ''}"
    bat  = _b(r'Capacidad Bater[ií]a\s*\n?\s*([\d.,]+\s*m?Ah?)')
    if bat: specs['bateria'] = bat
    gen  = _b(r'Generaci[oó]n\s*\n?\s*(\d+G)')
    if gen: specs['red'] = gen
    so   = _b(r'Version Sistema Operativo\s*\n?\s*([^\n]+)') or _b(r'Sistema Operativo\s*\n?\s*([^\n]+)')
    if so: specs['sistema'] = so.strip()
    return specs

def _parsear_specs_falabella(body):
    specs = {}
    def _b(pat):
        m = re.search(pat, body, re.IGNORECASE)
        return m.group(1).strip() if m else ''
    pulg = _b(r'pantalla\s+de\s+([\d.,]+\s*pulgadas?)') or _b(r'Tamaño.*?pantalla.*?([\d.,]+)"')
    if pulg: specs['pantalla'] = pulg
    ram  = _b(r'Memoria RAM\s*\n?\s*([\d.,]+\s*GB)') or (_b(r'(\d+)\s*GB\s+de\s+RAM') + ' GB' if _b(r'(\d+)\s*GB\s+de\s+RAM') else '')
    inte = _b(r'Capacidad de almacenamiento\s*\n?\s*([\d.,]+\s*GB)') or (_b(r'(\d+)\s*GB\s+de\s+almacenamiento') + ' GB' if _b(r'(\d+)\s*GB\s+de\s+almacenamiento') else '')
    if ram or inte: specs['ram_almacenamiento'] = ' / '.join(filter(None, [ram, inte]))
    post = _b(r'Cámara principal\s*\n?\s*([\d.,]+\s*MP)') or _b(r'cámara\s+de\s+([\d.,]+\s*MP)')
    if post: specs['camara'] = f"{post} posterior"
    bat  = _b(r'bater[ií]a\s+de\s+([\d.,]+\s*m?Ah?)') or _b(r'Capacidad Bater[ií]a\s*\n?\s*([\d.,]+\s*m?Ah?)')
    if bat: specs['bateria'] = bat
    gen  = _b(r'Generaci[oó]n\s*\n?\s*(\d+G)') or ('5G' if '5G' in body else ('4G' if '4G' in body else ''))
    if gen: specs['red'] = gen
    so   = _b(r'Sistema operativo espec[ií]fico\s*\n?\s*([^\n]+)') or _b(r'Sistema operativo\s*\n?\s*([^\n]+)')
    if so: specs['sistema'] = so.strip()
    return specs

# ── SCRAPER ALKOSTO ───────────────────────────────────────────────────────────
def buscar_alkosto(page, referencia, marca):
    try:
        ref_limpia = _limpiar_para_busqueda(referencia)
        query = re.sub(r'\s+', '+', ref_limpia.lower())
        page.goto(f'https://www.alkosto.com/search?text={query}',
                  wait_until='domcontentloaded', timeout=25000)
        page.wait_for_timeout(2500)
        links = page.query_selector_all('li.product__item a, .product__item a[href*="/p/"]')
        mejor_link, mejor_score = None, 0.0
        for link in links[:6]:
            titulo_el = link.query_selector(
                'span.product__item__info__name,.product__item__name,[class*=product__name]')
            titulo = titulo_el.inner_text() if titulo_el else (link.inner_text() or '')
            score = _similitud(ref_limpia, titulo)
            if score > mejor_score:
                mejor_score = score
                mejor_link = link
        if not mejor_link or mejor_score < UMBRAL:
            return None, {}
        href = mejor_link.get_attribute('href') or ''
        if href.startswith('/'):
            href = 'https://www.alkosto.com' + href
        page.goto(href.split('?')[0], wait_until='domcontentloaded', timeout=25000)
        page.wait_for_timeout(2000)
        imgs = page.query_selector_all('img[src*="cdn.dam.alkosto.com"]')
        img_url, mejor_area = '', 0
        for img in imgs:
            src = img.get_attribute('src') or ''
            bb  = img.bounding_box()
            if bb and bb['width'] > mejor_area:
                mejor_area = bb['width']
                img_url = src
        if not img_url:
            return None, {}
        bytes_img = _descargar(img_url, referer='https://www.alkosto.com')
        if not _valida(bytes_img):
            return None, {}
        return bytes_img, _parsear_specs_alkosto(page.inner_text('body'))
    except (PWTimeout, Exception):
        return None, {}

# ── SCRAPER FALABELLA ─────────────────────────────────────────────────────────
def buscar_falabella(page, referencia, marca):
    try:
        ref_limpia = _limpiar_para_busqueda(referencia)
        query = re.sub(r'\s+', '+', ref_limpia.lower())
        page.goto(f'https://www.falabella.com.co/falabella-co/search?Ntt={query}',
                  wait_until='domcontentloaded', timeout=25000)
        page.wait_for_timeout(3000)
        links = page.query_selector_all('a[href*="/falabella-co/product/"]')
        vistos = set()
        mejor_link, mejor_score = None, 0.0
        for link in links[:10]:
            href = (link.get_attribute('href') or '').split('?')[0]
            if href in vistos or not href:
                continue
            vistos.add(href)
            titulo = link.get_attribute('title') or link.inner_text() or ''
            score = _similitud(ref_limpia, titulo)
            if score > mejor_score:
                mejor_score = score
                mejor_link = link
        if not mejor_link or mejor_score < UMBRAL:
            return None, {}
        href = mejor_link.get_attribute('href') or ''
        href = href.split('?')[0]
        if not href.startswith('http'):
            href = 'https://www.falabella.com.co' + href
        page.goto(href, wait_until='domcontentloaded', timeout=25000)
        page.wait_for_timeout(2500)
        imgs = page.query_selector_all('img[src*="media.falabella.com"]')
        img_url, mejor_area = '', 0
        for img in imgs:
            src = img.get_attribute('src') or ''
            bb  = img.bounding_box()
            if bb and bb['width'] > mejor_area:
                mejor_area = bb['width']
                img_url = src
        if img_url:
            img_url = re.sub(r'w=\d+,h=\d+', 'w=1200,h=1200', img_url)
            if 'w=' not in img_url and '?' not in img_url:
                img_url += '/w=1200,h=1200,fit=pad'
        if not img_url:
            return None, {}
        bytes_img = _descargar(img_url, referer='https://www.falabella.com.co')
        if not _valida(bytes_img):
            return None, {}
        return bytes_img, _parsear_specs_falabella(page.inner_text('body'))
    except (PWTimeout, Exception):
        return None, {}

# ── SCRAPER ÉXITO ─────────────────────────────────────────────────────────────
def buscar_exito(page, referencia, marca):
    try:
        ref_limpia = _limpiar_para_busqueda(referencia)
        query = quote_plus(ref_limpia.lower())
        page.goto(f'https://www.exito.com/search?q={query}',
                  wait_until='domcontentloaded', timeout=28000)
        page.wait_for_timeout(3500)
        links = page.query_selector_all('a[href*="/p/"]')
        vistos = set()
        mejor_link, mejor_score = None, 0.0
        for link in links[:12]:
            href = (link.get_attribute('href') or '').split('?')[0]
            if href in vistos or not href:
                continue
            vistos.add(href)
            titulo = (link.get_attribute('aria-label') or
                      link.get_attribute('title') or
                      link.inner_text() or '')[:300]
            score = _similitud(ref_limpia, titulo)
            if score > mejor_score:
                mejor_score = score
                mejor_link = link
        if not mejor_link or mejor_score < UMBRAL:
            return None, {}
        href = mejor_link.get_attribute('href') or ''
        if not href.startswith('http'):
            href = 'https://www.exito.com' + href
        page.goto(href.split('?')[0], wait_until='domcontentloaded', timeout=28000)
        page.wait_for_timeout(2500)
        bytes_img = _mejor_imagen_pagina(page, referer='https://www.exito.com')
        if not _valida(bytes_img):
            return None, {}
        return bytes_img, {}
    except (PWTimeout, Exception):
        return None, {}

# ── SCRAPER KTRONIX ──────────────────────────────────────────────────────────
def buscar_ktronix(page, referencia, marca):
    try:
        ref_limpia = _limpiar_para_busqueda(referencia)
        query = quote_plus(ref_limpia.lower())
        page.goto(f'https://www.ktronix.com.co/buscar?q={query}',
                  wait_until='domcontentloaded', timeout=25000)
        page.wait_for_timeout(2500)
        links = page.query_selector_all(
            'a[href*="/p/"], a.product-item-link, '
            '.products-grid a, .product-name a, li.product-item a'
        )
        vistos = set()
        mejor_link, mejor_score = None, 0.0
        for link in links[:10]:
            href = (link.get_attribute('href') or '').split('?')[0]
            if href in vistos or not href:
                continue
            vistos.add(href)
            titulo = (link.get_attribute('title') or link.inner_text() or '')[:300]
            score = _similitud(ref_limpia, titulo)
            if score > mejor_score:
                mejor_score = score
                mejor_link = link
        if not mejor_link or mejor_score < UMBRAL:
            return None, {}
        href = mejor_link.get_attribute('href') or ''
        if not href.startswith('http'):
            href = 'https://www.ktronix.com.co' + href
        page.goto(href, wait_until='domcontentloaded', timeout=25000)
        page.wait_for_timeout(2000)
        bytes_img = _mejor_imagen_pagina(page, referer='https://www.ktronix.com.co')
        if not _valida(bytes_img):
            return None, {}
        return bytes_img, {}
    except (PWTimeout, Exception):
        return None, {}

# ── SCRAPER AMAZON MX ────────────────────────────────────────────────────────
def buscar_amazon(page, referencia, marca):
    try:
        ref_limpia = _limpiar_para_busqueda(referencia)
        query = quote_plus(ref_limpia)
        page.goto(f'https://www.amazon.com.mx/s?k={query}',
                  wait_until='domcontentloaded', timeout=30000)
        page.wait_for_timeout(2500)
        results = page.query_selector_all('[data-component-type="s-search-result"]')
        mejor_link, mejor_score = None, 0.0
        for result in results[:6]:
            titulo_el = result.query_selector('h2 span.a-text-normal, h2 span')
            titulo = titulo_el.inner_text() if titulo_el else ''
            score  = _similitud(ref_limpia, titulo)
            if score > mejor_score:
                mejor_score = score
                link_el = result.query_selector('h2 a')
                if link_el:
                    mejor_link = link_el
        if not mejor_link or mejor_score < UMBRAL:
            return None, {}
        href = mejor_link.get_attribute('href') or ''
        if not href.startswith('http'):
            href = 'https://www.amazon.com.mx' + href
        page.goto(href, wait_until='domcontentloaded', timeout=30000)
        page.wait_for_timeout(2500)
        img_el = page.query_selector('#landingImage, #imgBlkFront')
        if img_el:
            src = (img_el.get_attribute('data-old-hires') or
                   img_el.get_attribute('data-a-hires') or
                   img_el.get_attribute('src') or '')
            if src.startswith('http'):
                bytes_img = _descargar(src, referer='https://www.amazon.com.mx')
                if _valida(bytes_img):
                    return bytes_img, {}
        return None, {}
    except (PWTimeout, Exception):
        return None, {}

# ── SCRAPER MERCADO LIBRE API (sin Playwright) ────────────────────────────────
def buscar_mercadolibre(referencia, marca):
    try:
        ref_limpia = _limpiar_para_busqueda(referencia)
        query = quote_plus(ref_limpia)
        url = f'https://api.mercadolibre.com/sites/MCO/search?q={query}&limit=10'
        r = requests.get(url, timeout=12)
        if r.status_code != 200:
            return None
        items = r.json().get('results', [])
        for item in items:
            titulo = item.get('title', '')
            score  = _similitud(ref_limpia, titulo)
            if score < UMBRAL:
                continue
            thumb = item.get('thumbnail', '')
            if not thumb:
                continue
            img_url = (thumb
                       .replace('-I.jpg', '-O.jpg')
                       .replace('-I.webp', '-O.webp')
                       .replace('http://', 'https://'))
            bytes_img = _descargar(img_url)
            if _valida(bytes_img):
                return bytes_img
        return None
    except Exception:
        return None

# ── ORDEN DE FUENTES POR MARCA ────────────────────────────────────────────────
def _orden_fuentes(marca):
    """
    Devuelve lista de (nombre, fn_o_None) ordenada por probabilidad de éxito.
    None en fn = usar buscar_mercadolibre(ref, marca) en el loop.
    """
    if marca in {'JBL', 'BOSE', 'ASUS', 'HP', 'ACER', 'LENOVO'}:
        # Accesorios premium y computadores → Falabella y Amazon primero
        return [
            ('Falabella', buscar_falabella),
            ('Amazon',    buscar_amazon),
            ('Exito',     buscar_exito),
            ('Alkosto',   buscar_alkosto),
            ('ML',        None),
        ]
    elif marca in {'SAMSUNG', 'XIAOMI', 'MOTOROLA', 'MOTO', 'IPHONE', 'IPAD', 'HUAWEI'}:
        # Marcas mass-market → Falabella y Éxito primero
        return [
            ('Falabella', buscar_falabella),
            ('Exito',     buscar_exito),
            ('Alkosto',   buscar_alkosto),
            ('Amazon',    buscar_amazon),
            ('ML',        None),
        ]
    elif marca in {'HONOR', 'INFINIX', 'TECNO', 'ZTE', 'OPPO', 'NOKIA',
                   'ALCATEL', 'REALME', 'VIVO', 'POCO', 'TCL', 'ITEL', 'NUBIA'}:
        # Marcas asiáticas de nicho → Alkosto, luego Ktronix para gaming/niche
        return [
            ('Alkosto',   buscar_alkosto),
            ('Ktronix',   buscar_ktronix),
            ('Exito',     buscar_exito),
            ('Falabella', buscar_falabella),
            ('ML',        None),
        ]
    else:
        return [
            ('Alkosto',   buscar_alkosto),
            ('Falabella', buscar_falabella),
            ('Exito',     buscar_exito),
            ('Ktronix',   buscar_ktronix),
            ('ML',        None),
        ]

# ── SYNC ──────────────────────────────────────────────────────────────────────
def sincronizar(n_nuevas):
    catalogo = {}
    if os.path.exists(SPECS_DIR):
        for fname in os.listdir(SPECS_DIR):
            if not fname.endswith('.json'):
                continue
            slug_key = fname[:-5]
            try:
                with open(os.path.join(SPECS_DIR, fname), encoding='utf-8') as f:
                    data = json.load(f)
                img_path = os.path.join(IMGS_DIR, slug_key + '.jpg')
                catalogo[slug_key] = {
                    'pantalla':           data.get('pantalla', ''),
                    'ram_almacenamiento': data.get('ram_almacenamiento', ''),
                    'camara':             data.get('camara', ''),
                    'bateria':            data.get('bateria', ''),
                    'red':                data.get('red', ''),
                    'sistema':            data.get('sistema', ''),
                    'tiene_imagen':       os.path.exists(img_path),
                    'confianza':          data.get('confianza', ''),
                }
            except Exception:
                pass
    with open(CATALOGO, 'w', encoding='utf-8') as f:
        json.dump(catalogo, f, ensure_ascii=False, indent=2)
    con_img = sum(1 for v in catalogo.values() if v['tiene_imagen'])
    fecha   = datetime.now().strftime('%Y-%m-%d')
    msg     = f"imágenes: +{n_nuevas} nuevas · {con_img}/{len(catalogo)} total · {fecha}"
    try:
        subprocess.run(['git', '-C', REPO_PATH, 'add',
                        'creditek/data/', 'creditek/assets/imagenes/'],
                       check=True, capture_output=True)
        diff = subprocess.run(['git', '-C', REPO_PATH, 'diff', '--cached', '--stat'],
                              capture_output=True, text=True).stdout.strip()
        if not diff:
            print("  ○ Sin cambios nuevos en git")
            return
        subprocess.run(['git', '-C', REPO_PATH, 'commit', '-m', msg],
                       check=True, capture_output=True)
        subprocess.run(['git', '-C', REPO_PATH, 'push'],
                       check=True, capture_output=True)
        print(f"  ✓ Git push: \"{msg}\"")
    except subprocess.CalledProcessError as e:
        print(f"  ✗ Git: {e.stderr.decode() if e.stderr else e}")

# ── MAIN ──────────────────────────────────────────────────────────────────────
def main():
    print("\n" + "="*70)
    print("  CREDITEK · IMÁGENES v2 — Alkosto/Falabella/Éxito/Ktronix/Amazon/ML")
    print("="*70 + "\n")

    if not os.path.exists(CATALOGO):
        print(f"✗ No encontré {CATALOGO} — corre catalogo_creditek.py primero")
        return

    with open(CATALOGO, encoding='utf-8') as f:
        catalogo = json.load(f)

    pendientes = []
    for slug_key, data in catalogo.items():
        if data.get('tiene_imagen'):
            continue
        marca = slug_key.split('_')[0]
        if marca in MARCAS_RECONOCIDAS:
            pendientes.append((slug_key, marca))

    print(f"✓ {len(pendientes)} productos pendientes de imagen\n")
    if not pendientes:
        print("✓ Nada que hacer")
        return

    print("→ Conectando a Google Drive...")
    svc    = autenticar_drive()
    id_img = buscar_o_crear_carpeta(svc, '_IMAGENES', CARPETA_BASE)
    print(f"✓ Drive OK · _IMAGENES: {id_img}\n")

    os.makedirs(IMGS_DIR, exist_ok=True)

    exitos = 0
    fallos = 0
    total  = len(pendientes)
    fuentes_stats = {}

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=[
            '--no-sandbox', '--disable-blink-features=AutomationControlled',
        ])
        ctx = browser.new_context(
            user_agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                       'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            viewport={'width': 1280, 'height': 900},
        )
        page = ctx.new_page()
        page.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
        )

        for i, (slug_key, marca) in enumerate(pendientes, 1):
            referencia = slug_key.replace('_', ' ')
            label = f"[{i:3}/{total}] {referencia[:48]:48} | {marca:10}"
            print(label, end=' ', flush=True)

            img_bytes = None
            specs     = {}
            fuente    = ''

            for nombre_fuente, fn_buscar in _orden_fuentes(marca):
                if fn_buscar is None:
                    img_bytes = buscar_mercadolibre(referencia, marca)
                    specs = {}
                else:
                    img_bytes, specs = fn_buscar(page, referencia, marca)
                if img_bytes:
                    fuente = nombre_fuente
                    break

            if img_bytes:
                local_path = os.path.join(IMGS_DIR, slug_key + '.jpg')
                with open(local_path, 'wb') as f:
                    f.write(img_bytes)
                subir_imagen(svc, slug_key + '.jpg', img_bytes, id_img)
                if specs:
                    spec_path = os.path.join(SPECS_DIR, slug_key + '.json')
                    if os.path.exists(spec_path):
                        with open(spec_path, encoding='utf-8') as f:
                            existing = json.load(f)
                        for campo, valor in specs.items():
                            if valor and not existing.get(campo):
                                existing[campo] = valor
                        with open(spec_path, 'w', encoding='utf-8') as f:
                            json.dump(existing, f, ensure_ascii=False, indent=2)
                kb = len(img_bytes) // 1024
                fuentes_stats[fuente] = fuentes_stats.get(fuente, 0) + 1
                print(f"→ ✓ {fuente} [{kb}KB]")
                exitos += 1
            else:
                print("→ ✗ no encontrada")
                fallos += 1

            time.sleep(DELAY)

        browser.close()

    print("\n" + "="*70)
    print(f"  RESUMEN: {exitos}/{total} imágenes  ({fallos} sin imagen)")
    print("  Por fuente:", ', '.join(f"{k}:{v}" for k, v in fuentes_stats.items()))
    print("="*70)

    if exitos > 0:
        print("\n→ Sincronizando catalogo.json y haciendo push...")
        sincronizar(exitos)
    print()


if __name__ == '__main__':
    main()
