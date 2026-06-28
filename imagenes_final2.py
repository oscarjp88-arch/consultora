#!/usr/bin/env python3
"""
Segunda pasada para los 16 productos sin imagen.
Bugs corregidos:
  - Falabella: busca URL /public y prueba TODOS los thumbnails (no solo el más grande)
  - Alkosto: extrae thumbnail desde resultados de búsqueda (cdn.dam.alkosto.com)
  - Agrega Ktronix para HONOR/INFINIX
"""

import os, re, io, json, time, subprocess
from datetime import datetime
from urllib.parse import quote_plus

import warnings
warnings.filterwarnings('ignore')

import requests
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload

REPO_PATH  = '/Users/oscarpacheco/consultora'
CREDS_PATH = f'{REPO_PATH}/credentials.json'
TOKEN_PATH = f'{REPO_PATH}/token.json'
DATA_DIR   = f'{REPO_PATH}/creditek/data'
SPECS_DIR  = f'{DATA_DIR}/specs'
IMGS_DIR   = f'{REPO_PATH}/creditek/assets/imagenes'
CATALOGO   = f'{DATA_DIR}/catalogo.json'

CARPETA_BASE = '1QtZ4K1770F3uXrbic9_wPZtfgy6U-58y'
SCOPES       = ['https://www.googleapis.com/auth/drive']

UMBRAL    = 0.45   # Ligeramente más permisivo que 0.50
MIN_BYTES = 20_000
DELAY     = 8

TARGETS = [
    ('HONOR_X5B_128GB',                'HONOR'),
    ('INFINIX_HOT_60I_8256GB',         'INFINIX'),
    ('INFINIX_NOTE_EDGE_5G',           'INFINIX'),
    ('INFINIX_NOTE_EDGE_5G_8256GB',    'INFINIX'),
    ('IPHONE_12_128GB_NUEVO',          'IPHONE'),
    ('IPHONE_13_128GB_USADO',          'IPHONE'),
    ('IPHONE_16_128GB',                'IPHONE'),
    ('IPHONE_16_128GB_USADO',          'IPHONE'),
    ('IPHONE_16_256GB_NUEVO',          'IPHONE'),
    ('SAMSUNG_A06_464GB',              'SAMSUNG'),
    ('SAMSUNG_A07_6128GB',             'SAMSUNG'),
    ('SAMSUNG_A37_5G_8256GB',          'SAMSUNG'),
    ('XIAOMI_NOTE_15_PRO_5G_8256GB',   'XIAOMI'),
    ('XIAOMI_NOTE_15_PRO_5G_8512GB',   'XIAOMI'),
    ('HONOR_CHOICE_EARBUDS_X7E',       'HONOR'),
    ('XIAOMI_BUDS_6_PLAY',             'XIAOMI'),
]

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

def _subir(svc, nombre, b, parent_id):
    q = f"name='{nombre}' and '{parent_id}' in parents and trashed=false"
    res = svc.files().list(q=q, fields='files(id)').execute().get('files', [])
    media = MediaIoBaseUpload(io.BytesIO(b), mimetype='image/jpeg', resumable=False)
    if res:
        return svc.files().update(fileId=res[0]['id'], media_body=media).execute()['id']
    meta = {'name': nombre, 'parents': [parent_id]}
    return svc.files().create(body=meta, media_body=media, fields='id').execute()['id']

# ── IMAGEN UTILS ──────────────────────────────────────────────────────────────
def _valida(b):
    if not b or len(b) < MIN_BYTES: return False
    return (b[:3] == b'\xff\xd8\xff' or b[:4] == b'\x89PNG' or b[:4] == b'RIFF')

def _dl(url, referer=''):
    try:
        H = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                           'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
             'Referer': referer, 'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'}
        r = requests.get(url, headers=H, timeout=18)
        if r.status_code == 200 and len(r.content) > 5000:
            return r.content
    except Exception:
        pass
    return None

def _palabras(t):
    SKIP = {'DE','LA','EL','CON','Y','A','EN','O','4G','5G','DS','SIM',
            'DUAL','PLUS','PRO','MAX','LITE','NEO','SERIES','CELULAR',
            'SMARTPHONE','TABLET','PORTATIL','LAPTOP','NOTEBOOK','PARLANTE',
            'USB','TYPE','WIFI','GB','TB','RAM','NUEVO','USADO','REACONDICIONADO'}
    p = set(re.findall(r'[A-Z0-9]+', t.upper()))
    return {x for x in p if x not in SKIP and not (x.isdigit() and len(x) <= 3)}

def _sim(ref, titulo):
    rw, tw = _palabras(ref), _palabras(titulo)
    if not rw: return 0.0
    return len(rw & tw) / len(rw)

def _limpiar(slug):
    clean = re.sub(r'\s+\d+[/]?\d*\s*GB.*', '', slug.replace('_', ' ').strip(), flags=re.IGNORECASE)
    clean = re.sub(r'\s+(NUEVO|USADO)$', '', clean.strip(), flags=re.IGNORECASE)
    return clean.strip()

# ── FALABELLA (corregido: prueba todos los thumbnails) ────────────────────────
def buscar_falabella(page, slug_key):
    try:
        ref_limpia = _limpiar(slug_key)
        query = quote_plus(ref_limpia.lower())
        page.goto(f'https://www.falabella.com.co/falabella-co/search?Ntt={query}',
                  wait_until='domcontentloaded', timeout=25000)
        page.wait_for_timeout(3000)
        links = page.query_selector_all('a[href*="/falabella-co/product/"]')
        vistos = set()
        mejor_link, mejor_score = None, 0.0
        for link in links[:10]:
            href = (link.get_attribute('href') or '').split('?')[0]
            if href in vistos or not href: continue
            vistos.add(href)
            titulo = link.get_attribute('title') or link.inner_text() or ''
            score = _sim(ref_limpia, titulo)
            if score > mejor_score:
                mejor_score, mejor_link = score, link
        if not mejor_link or mejor_score < UMBRAL:
            return None
        href = (mejor_link.get_attribute('href') or '').split('?')[0]
        if not href.startswith('http'):
            href = 'https://www.falabella.com.co' + href
        page.goto(href, wait_until='domcontentloaded', timeout=25000)
        page.wait_for_timeout(2500)
        imgs = page.query_selector_all('img[src*="media.falabella.com"]')
        # Prueba todos los imgs en orden: primero los /public, luego thumbnails
        public_urls = []
        thumb_urls  = []
        for img in imgs:
            src = img.get_attribute('src') or ''
            if '/public' in src:
                public_urls.append(src)
            elif 'w=' in src or 'fit=' in src:
                thumb_urls.append(src)
        # 1. Probar /public primero
        for url in public_urls:
            b = _dl(url, 'https://www.falabella.com.co')
            if _valida(b):
                return b
        # 2. Probar thumbnails a tamaño grande
        for url in thumb_urls:
            big = re.sub(r'w=\d+,h=\d+', 'w=1200,h=1200', url)
            b = _dl(big, 'https://www.falabella.com.co')
            if _valida(b):
                return b
        return None
    except Exception:
        return None

# ── ALKOSTO (corregido: thumbnail desde resultados de búsqueda) ───────────────
def buscar_alkosto(page, slug_key):
    try:
        ref_limpia = _limpiar(slug_key)
        query = quote_plus(ref_limpia.lower())
        page.goto(f'https://www.alkosto.com/search?text={query}',
                  wait_until='domcontentloaded', timeout=25000)
        page.wait_for_timeout(2500)
        # Extraer thumbnails desde los resultados (cdn.dam.alkosto.com)
        items = page.query_selector_all('li.product__item')
        mejor_score, mejor_url = 0.0, None
        for item in items[:6]:
            te = item.query_selector('[class*=product__name],[class*=product__item__info]')
            titulo = te.inner_text() if te else ''
            if not titulo:
                a = item.query_selector('a')
                titulo = a.inner_text() if a else ''
            score = _sim(ref_limpia, titulo)
            if score > mejor_score:
                # Buscar imagen en este item
                img = item.query_selector('img[src*="cdn.dam.alkosto.com"]')
                if img:
                    src = img.get_attribute('src') or ''
                    # Escalar a imagen grande
                    big = re.sub(r'[?&]w=\d+', '', src)  # quitar ?w=227
                    mejor_score = score
                    mejor_url = big
        if not mejor_url or mejor_score < UMBRAL:
            return None
        b = _dl(mejor_url, 'https://www.alkosto.com')
        if _valida(b):
            return b
        # Intentar con w=800
        url800 = mejor_url + ('&w=800' if '?' in mejor_url else '?w=800')
        b = _dl(url800, 'https://www.alkosto.com')
        return b if _valida(b) else None
    except Exception:
        return None

# ── KTRONIX ───────────────────────────────────────────────────────────────────
def buscar_ktronix(page, slug_key):
    try:
        ref_limpia = _limpiar(slug_key)
        query = quote_plus(ref_limpia.lower())
        page.goto(f'https://www.ktronix.com/buscar?q={query}',
                  wait_until='domcontentloaded', timeout=25000)
        page.wait_for_timeout(2500)
        links = page.query_selector_all('a[href*="/p/"], a.product-card, .product-card a')
        if not links:
            links = page.query_selector_all('[class*=product] a')
        mejor_link, mejor_score = None, 0.0
        for link in links[:8]:
            titulo = link.get_attribute('title') or link.inner_text() or ''
            score = _sim(ref_limpia, titulo)
            if score > mejor_score:
                mejor_score, mejor_link = score, link
        if not mejor_link or mejor_score < UMBRAL:
            return None
        href = (mejor_link.get_attribute('href') or '').split('?')[0]
        if not href.startswith('http'):
            href = 'https://www.ktronix.com' + href
        page.goto(href, wait_until='domcontentloaded', timeout=25000)
        page.wait_for_timeout(2000)
        # Extraer mejor imagen
        mejor_bytes, mejor_area = None, 0
        for img in page.query_selector_all('img'):
            src = img.get_attribute('src') or img.get_attribute('data-src') or ''
            if not src.startswith('http'): continue
            sl = src.lower()
            if any(x in sl for x in ('logo','icon','sprite','banner')): continue
            bb = img.bounding_box()
            if not bb: continue
            w, h = bb['width'], bb['height']
            if w < 150 or h < 150: continue
            if max(w,h)/min(w,h) > 2.5: continue
            if w*h > mejor_area:
                b = _dl(src, 'https://www.ktronix.com')
                if _valida(b):
                    mejor_area = w*h
                    mejor_bytes = b
        return mejor_bytes
    except Exception:
        return None

# ── GIT ───────────────────────────────────────────────────────────────────────
def git_push(msg):
    try:
        subprocess.run(['git', '-C', REPO_PATH, 'add',
                        'creditek/data/catalogo.json', 'creditek/assets/imagenes/'],
                       check=True, capture_output=True)
        diff = subprocess.run(['git', '-C', REPO_PATH, 'diff', '--cached', '--stat'],
                              capture_output=True, text=True).stdout.strip()
        if not diff:
            print("  ○ Sin cambios"); return
        subprocess.run(['git', '-C', REPO_PATH, 'commit', '-m', msg],
                       check=True, capture_output=True)
        subprocess.run(['git', '-C', REPO_PATH, 'push'],
                       check=True, capture_output=True)
        print(f"  ✓ Git push: \"{msg}\"")
    except subprocess.CalledProcessError as e:
        print(f"  ✗ Git error: {e.stderr.decode() if e.stderr else str(e)}")

def regenerar_catalogo():
    catalogo = {}
    for fname in os.listdir(SPECS_DIR):
        if not fname.endswith('.json'): continue
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
    print(f"  ✓ catalogo.json: {con_img}/{len(catalogo)} con imagen")
    return con_img, len(catalogo)

# ── MAIN ──────────────────────────────────────────────────────────────────────
def main():
    print("\n" + "="*70)
    print("  CREDITEK · SEGUNDA PASADA (16 productos pendientes)")
    print("="*70 + "\n")

    print("→ Auth Drive...")
    svc = autenticar_drive()
    q = f"name='_IMAGENES' and '{CARPETA_BASE}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false"
    res = svc.files().list(q=q, fields='files(id)').execute().get('files', [])
    id_imgs = res[0]['id'] if res else None
    print(f"  ✓ Drive OK · id_imgs={id_imgs}\n")

    exitos, fallos = 0, []
    total = len(TARGETS)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=[
            '--no-sandbox', '--disable-blink-features=AutomationControlled',
        ])
        ctx = browser.new_context(
            user_agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                       'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            viewport={'width': 1280, 'height': 800},
        )
        page = ctx.new_page()
        page.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>undefined})")

        for i, (slug_key, marca) in enumerate(TARGETS, 1):
            ref = slug_key.replace('_', ' ')
            print(f"[{i:2}/{total}] {ref[:52]:52} ", end='', flush=True)

            img_bytes, fuente = None, ''

            # Fuente 1: Alkosto (thumbnail from search results)
            img_bytes = buscar_alkosto(page, slug_key)
            if img_bytes: fuente = 'Alkosto'

            # Fuente 2: Falabella (all thumbnails)
            if not img_bytes:
                img_bytes = buscar_falabella(page, slug_key)
                if img_bytes: fuente = 'Falabella'

            # Fuente 3: Ktronix (para HONOR, INFINIX, TECNO)
            if not img_bytes and marca in ('HONOR', 'INFINIX', 'TECNO', 'ZTE', 'REALME'):
                img_bytes = buscar_ktronix(page, slug_key)
                if img_bytes: fuente = 'Ktronix'

            if img_bytes:
                local = os.path.join(IMGS_DIR, f'{slug_key}.jpg')
                with open(local, 'wb') as f:
                    f.write(img_bytes)
                if id_imgs:
                    try: _subir(svc, f'{slug_key}.jpg', img_bytes, id_imgs)
                    except Exception: pass
                print(f"→ ✓ {fuente} [{len(img_bytes)//1024}KB]")
                exitos += 1
            else:
                print("→ ✗ no encontrada")
                fallos.append(slug_key)

            time.sleep(DELAY)

        browser.close()

    print("\n" + "="*70)
    print(f"  Obtenidas:  {exitos}/{total}")
    print(f"  Pendientes: {len(fallos)}")
    for f in fallos: print(f"    - {f}")
    print("="*70)

    if exitos > 0:
        print("\n→ Actualizando catalogo.json y push final...")
        con_img, total_cat = regenerar_catalogo()
        fecha = datetime.now().strftime('%Y-%m-%d')
        git_push(f"feat: +{exitos} imágenes segunda pasada · {con_img}/{total_cat} total · {fecha}")

    # Screenshot
    print("\n→ Screenshot del portal...")
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            p = browser.new_page(viewport={'width': 1440, 'height': 900})
            p.goto('https://oscarpachecodev.github.io/consultora/creditek/portal/',
                   wait_until='networkidle', timeout=30000)
            p.wait_for_timeout(3000)
            out = os.path.join(REPO_PATH, 'portal-creditek.png')
            p.screenshot(path=out, full_page=False)
            browser.close()
            print(f"  ✓ Screenshot: {out}")
    except Exception as e:
        print(f"  ✗ Screenshot error: {e}")

    print(f"\n✓ Cerrado. {exitos} nuevas imágenes en esta pasada.\n")


if __name__ == '__main__':
    main()
