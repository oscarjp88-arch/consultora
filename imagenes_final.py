#!/usr/bin/env python3
"""
CREDITEK · Scraper final para 21 productos (Celulares + Sonido)
Fuentes: Alkosto → Falabella → Sitio oficial de marca
MIN_BYTES = 20,000 (evita thumbnails pequeños)
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

CARPETA_BASE = '1QtZ4K1770F3uXrbic9_wPZtfgy6U-58y'
SCOPES       = ['https://www.googleapis.com/auth/drive']

UMBRAL    = 0.50
MIN_BYTES = 20_000
DELAY     = 8

# ── TARGETS: solo Celulares + Sonido sin imagen ────────────────────────────────
TARGETS = [
    # Celulares
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
    ('TECNO_SPARK_GO_3_4128GB',        'TECNO'),
    ('TECNO_SPARK_GO_3_464GB',         'TECNO'),
    ('XIAOMI_NOTE_15_PRO_5G_8256GB',   'XIAOMI'),
    ('XIAOMI_NOTE_15_PRO_5G_8512GB',   'XIAOMI'),
    ('XIAOMI_REDMI_A7_PRO_4128GB',     'XIAOMI'),
    ('XIAOMI_REDMI_A7_PRO_464GB',      'XIAOMI'),
    # Sonido
    ('HONOR_CHOICE_EARBUDS_X7E',       'HONOR'),
    ('HONOR_CHOICE_HEADPHONE',         'HONOR'),
    ('XIAOMI_BUDS_6_PLAY',             'XIAOMI'),
]

# Sitios oficiales por marca: URL de búsqueda
BRAND_SEARCH = {
    'SAMSUNG': 'https://www.samsung.com/co/search/?searchvalue={q}',
    'IPHONE':  'https://www.apple.com/co/search/{q}?src=serp',
    'XIAOMI':  'https://www.mi.com/co/search/?q={q}',
    'INFINIX': 'https://infinixmobility.com/co/search?q={q}',
    'TECNO':   'https://www.tecno-mobile.com/en/search/?q={q}',
    'HONOR':   'https://www.hihonor.com/co/search/?q={q}',
}

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

def _archivo_existe(svc, nombre, parent_id):
    q = f"name='{nombre}' and '{parent_id}' in parents and trashed=false"
    res = svc.files().list(q=q, fields='files(id)').execute().get('files', [])
    return res[0]['id'] if res else None

def _buscar_o_crear_carpeta(svc, nombre, parent_id):
    q = (f"name='{nombre}' and '{parent_id}' in parents and "
         f"mimeType='application/vnd.google-apps.folder' and trashed=false")
    res = svc.files().list(q=q, fields='files(id)').execute().get('files', [])
    if res:
        return res[0]['id']
    meta = {'name': nombre, 'mimeType': 'application/vnd.google-apps.folder', 'parents': [parent_id]}
    return svc.files().create(body=meta, fields='id').execute()['id']

def _subir_imagen(svc, nombre, bytes_img, parent_id):
    existente = _archivo_existe(svc, nombre, parent_id)
    media = MediaIoBaseUpload(io.BytesIO(bytes_img), mimetype='image/jpeg', resumable=False)
    if existente:
        return svc.files().update(fileId=existente, media_body=media).execute()['id']
    meta = {'name': nombre, 'parents': [parent_id]}
    return svc.files().create(body=meta, media_body=media, fields='id').execute()['id']

# ── IMAGEN UTILS ──────────────────────────────────────────────────────────────
def _valida(b):
    if not b or len(b) < MIN_BYTES:
        return False
    hdr = b[:4]
    return (hdr[:3] == b'\xff\xd8\xff' or
            hdr == b'\x89PNG' or
            hdr == b'RIFF' or
            b[:6] in (b'GIF87a', b'GIF89a'))

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

def _palabras_clave(texto):
    SKIP = {'DE','LA','EL','CON','Y','A','EN','O','4G','5G','DS','SIM',
            'DUAL','PLUS','PRO','MAX','LITE','NEO','SERIES','CELULAR',
            'SMARTPHONE','TABLET','PORTATIL','LAPTOP','NOTEBOOK','PARLANTE',
            'USB','TYPE','WIFI','GB','TB','RAM','NUEVO','USADO'}
    palabras = set(re.findall(r'[A-Z0-9]+', texto.upper()))
    return {p for p in palabras if p not in SKIP and not (p.isdigit() and len(p) <= 3)}

def _similitud(ref, titulo):
    rw = _palabras_clave(ref)
    tw = _palabras_clave(titulo)
    if not rw:
        return 0.0
    return len(rw & tw) / len(rw)

def _limpiar(ref):
    clean = re.sub(r'\s+\d+[/]?\d*\s*GB.*', '', ref.strip(), flags=re.IGNORECASE)
    clean = re.sub(r'\s+(NUEVO|USADO)$', '', clean.strip(), flags=re.IGNORECASE)
    return clean.strip()

def _mejor_imagen_pagina(page, referer=''):
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
            if any(x in sl for x in ('logo','icon','sprite','banner','header','.svg','pixel','gift')):
                continue
            bb = img.bounding_box()
            if not bb:
                continue
            w, h = bb['width'], bb['height']
            if w < 150 or h < 150:
                continue
            ratio = max(w, h) / min(w, h) if min(w, h) > 0 else 99
            if ratio > 2.5:
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

# ── ALKOSTO ───────────────────────────────────────────────────────────────────
def buscar_alkosto(page, slug_key):
    try:
        ref_limpia = _limpiar(slug_key.replace('_', ' '))
        query = quote_plus(ref_limpia.lower())
        page.goto(f'https://www.alkosto.com/search?text={query}',
                  wait_until='domcontentloaded', timeout=25000)
        page.wait_for_timeout(2500)
        links = page.query_selector_all('li.product__item a, .product__item a[href*="/p/"]')
        mejor_link, mejor_score = None, 0.0
        for link in links[:6]:
            te = link.query_selector('span.product__item__info__name,[class*=product__name]')
            titulo = te.inner_text() if te else (link.inner_text() or '')
            score = _similitud(ref_limpia, titulo)
            if score > mejor_score:
                mejor_score, mejor_link = score, link
        if not mejor_link or mejor_score < UMBRAL:
            return None
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
                mejor_area, img_url = bb['width'], src
        if not img_url:
            return None
        b = _descargar(img_url, 'https://www.alkosto.com')
        return b if _valida(b) else None
    except Exception:
        return None

# ── FALABELLA ─────────────────────────────────────────────────────────────────
def buscar_falabella(page, slug_key):
    try:
        ref_limpia = _limpiar(slug_key.replace('_', ' '))
        query = quote_plus(ref_limpia.lower())
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
                mejor_score, mejor_link = score, link
        if not mejor_link or mejor_score < UMBRAL:
            return None
        href = (mejor_link.get_attribute('href') or '').split('?')[0]
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
                mejor_area, img_url = bb['width'], src
        if img_url:
            img_url = re.sub(r'w=\d+,h=\d+', 'w=1200,h=1200', img_url)
        if not img_url:
            return None
        b = _descargar(img_url, 'https://www.falabella.com.co')
        return b if _valida(b) else None
    except Exception:
        return None

# ── SITIO OFICIAL DE MARCA ────────────────────────────────────────────────────
def buscar_sitio_oficial(page, slug_key, marca):
    url_tpl = BRAND_SEARCH.get(marca)
    if not url_tpl:
        return None
    try:
        ref_limpia = _limpiar(slug_key.replace('_', ' '))
        q = quote_plus(ref_limpia)
        url = url_tpl.format(q=q)
        page.goto(url, wait_until='domcontentloaded', timeout=25000)
        page.wait_for_timeout(3000)

        # Para Apple: intentar navegar al primer producto
        if marca == 'IPHONE':
            links = page.query_selector_all('a[href*="iphone"]')
            for link in links[:5]:
                href = link.get_attribute('href') or ''
                titulo = link.inner_text() or ''
                if _similitud(ref_limpia, titulo) >= 0.4:
                    if not href.startswith('http'):
                        href = 'https://www.apple.com' + href
                    page.goto(href, wait_until='domcontentloaded', timeout=20000)
                    page.wait_for_timeout(2000)
                    break

        # Para Samsung: intentar navegar al primer resultado
        elif marca == 'SAMSUNG':
            links = page.query_selector_all('a[href*="/co/smartphones/"], a[href*="/co/mobile/"]')
            for link in links[:5]:
                href = link.get_attribute('href') or ''
                titulo = link.inner_text() or ''
                if _similitud(ref_limpia, titulo) >= 0.4:
                    if not href.startswith('http'):
                        href = 'https://www.samsung.com' + href
                    page.goto(href, wait_until='domcontentloaded', timeout=20000)
                    page.wait_for_timeout(2000)
                    break

        # Para los demás: intentar navegar al primer resultado con texto del producto
        else:
            for sel in ['a.product-card', 'a.product-item', 'a[class*="product"]',
                        '.search-results a', '.product-list a']:
                links = page.query_selector_all(sel)
                if links:
                    href = links[0].get_attribute('href') or ''
                    if href and not href.startswith('http'):
                        domain = url.split('/')[2]
                        href = f'https://{domain}{href}'
                    if href.startswith('http'):
                        page.goto(href, wait_until='domcontentloaded', timeout=20000)
                        page.wait_for_timeout(2000)
                    break

        return _mejor_imagen_pagina(page, referer=url)
    except Exception:
        return None

# ── GIT HELPERS ───────────────────────────────────────────────────────────────
def git_commit_push(msg):
    try:
        subprocess.run(['git', '-C', REPO_PATH, 'add',
                        'creditek/data/catalogo.json', 'creditek/assets/imagenes/'],
                       check=True, capture_output=True)
        diff = subprocess.run(['git', '-C', REPO_PATH, 'diff', '--cached', '--stat'],
                              capture_output=True, text=True).stdout.strip()
        if not diff:
            print("  ○ Sin cambios en git")
            return
        subprocess.run(['git', '-C', REPO_PATH, 'commit', '-m', msg],
                       check=True, capture_output=True)
        subprocess.run(['git', '-C', REPO_PATH, 'push'],
                       check=True, capture_output=True)
        print(f"  ✓ Git push: \"{msg}\"")
    except subprocess.CalledProcessError as e:
        print(f"  ✗ Git error: {e.stderr.decode() if e.stderr else str(e)}")

def regenerar_catalogo():
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
    print(f"  ✓ catalogo.json: {con_img}/{len(catalogo)} con imagen")
    return con_img, len(catalogo)

# ── MAIN ──────────────────────────────────────────────────────────────────────
def main():
    print("\n" + "="*70)
    print("  CREDITEK · IMÁGENES FINALES (Celulares + Sonido)")
    print("="*70 + "\n")

    # 1. Commit pending deletions
    print("→ Paso 1: Commit de imágenes eliminadas + catalogo.json...")
    git_commit_push("fix: eliminar 9 imágenes de categorías no Celulares/Sonido · 2026-06-22")

    # 2. Auth Drive
    print("\n→ Paso 2: Conectando a Google Drive...")
    svc = autenticar_drive()
    id_imgs = None
    try:
        q = f"name='_IMAGENES' and '{CARPETA_BASE}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false"
        res = svc.files().list(q=q, fields='files(id)').execute().get('files', [])
        id_imgs = res[0]['id'] if res else None
        if not id_imgs:
            meta = {'name': '_IMAGENES', 'mimeType': 'application/vnd.google-apps.folder', 'parents': [CARPETA_BASE]}
            id_imgs = svc.files().create(body=meta, fields='id').execute()['id']
    except Exception as e:
        print(f"  ✗ Drive error: {e}")
    print(f"  ✓ Drive OK · _IMAGENES: {id_imgs}\n")

    os.makedirs(IMGS_DIR, exist_ok=True)

    exitos = 0
    fallos = []
    total  = len(TARGETS)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=[
            '--no-sandbox',
            '--disable-blink-features=AutomationControlled',
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
            print(f"[{i:2}/{total}] {ref[:50]:50} ", end='', flush=True)

            img_bytes = None
            fuente    = ''

            # Fuente 1: Alkosto
            img_bytes = buscar_alkosto(page, slug_key)
            if img_bytes:
                fuente = 'Alkosto'

            # Fuente 2: Falabella
            if not img_bytes:
                img_bytes = buscar_falabella(page, slug_key)
                if img_bytes:
                    fuente = 'Falabella'

            # Fuente 3: Sitio oficial
            if not img_bytes:
                img_bytes = buscar_sitio_oficial(page, slug_key, marca)
                if img_bytes:
                    fuente = marca.capitalize() + '.com'

            if img_bytes:
                local_path = os.path.join(IMGS_DIR, f'{slug_key}.jpg')
                with open(local_path, 'wb') as f:
                    f.write(img_bytes)
                if id_imgs:
                    try:
                        _subir_imagen(svc, f'{slug_key}.jpg', img_bytes, id_imgs)
                    except Exception:
                        pass
                print(f"→ ✓ {fuente} [{len(img_bytes)//1024}KB]")
                exitos += 1
            else:
                print("→ ✗ no encontrada")
                fallos.append(slug_key)

            time.sleep(DELAY)

        browser.close()

    print("\n" + "="*70)
    print(f"  Obtenidas:  {exitos}/{total}")
    print(f"  No encontradas ({len(fallos)}): {', '.join(f[:30] for f in fallos) or 'ninguna'}")
    print("="*70)

    # Regenerar catalogo.json y push final
    print("\n→ Paso 3: Actualizando catalogo.json y push final...")
    con_img, total_cat = regenerar_catalogo()
    fecha = datetime.now().strftime('%Y-%m-%d')
    git_commit_push(f"feat: imágenes finales Celulares+Sonido · {con_img}/{total_cat} · {fecha}")

    # Screenshot del portal
    print("\n→ Paso 4: Screenshot del portal en GitHub Pages...")
    _screenshot_portal()

    print(f"\n✓ Listo. {con_img}/{total_cat} productos con imagen en el portal.\n")


def _screenshot_portal():
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 1440, 'height': 900})
            url = 'https://oscarpachecodev.github.io/consultora/creditek/portal/'
            page.goto(url, wait_until='networkidle', timeout=30000)
            page.wait_for_timeout(3000)
            out = os.path.join(REPO_PATH, 'portal-creditek.png')
            page.screenshot(path=out, full_page=False)
            browser.close()
            print(f"  ✓ Screenshot: {out}")
    except Exception as e:
        print(f"  ✗ Screenshot error: {e}")


if __name__ == '__main__':
    main()
