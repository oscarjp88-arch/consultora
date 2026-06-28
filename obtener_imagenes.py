#!/usr/bin/env python3
"""
CREDITEK · Obtener imágenes con Playwright + Bing Images
Lee catalogo.json local, descarga imágenes para marcas reconocidas,
sube a Drive y hace git push.
"""

import os
import re
import io
import json
import time
import subprocess
from datetime import datetime

try:
    import requests
    from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from google.auth.transport.requests import Request
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaIoBaseUpload
except ImportError as e:
    print(f"✗ Falta: {e}\nInstala: pip install playwright requests google-auth-oauthlib google-api-python-client")
    raise

# === RUTAS ===
REPO_PATH  = '/Users/oscarpacheco/consultora'
CREDS_PATH = f'{REPO_PATH}/credentials.json'
TOKEN_PATH = f'{REPO_PATH}/token.json'
DATA_DIR   = f'{REPO_PATH}/creditek/data'
IMGS_DIR   = f'{REPO_PATH}/creditek/assets/imagenes'
CATALOGO   = f'{DATA_DIR}/catalogo.json'

# === IDs DRIVE ===
CARPETA_BASE = '1QtZ4K1770F3uXrbic9_wPZtfgy6U-58y'
SCOPES       = ['https://www.googleapis.com/auth/drive']

MARCAS_RECONOCIDAS = {
    'SAMSUNG', 'APPLE', 'IPHONE', 'XIAOMI', 'MOTOROLA', 'MOTO', 'HONOR', 'OPPO',
    'REALME', 'INFINIX', 'TECNO', 'NOKIA', 'ZTE', 'HUAWEI', 'VIVO', 'ALCATEL',
    'POCO', 'TCL', 'IFFALCON', 'ITEL', 'JBL', 'BOSE', 'ACER', 'HP', 'ASUS',
    'LENOVO', 'IPAD', 'NUBIA'
}

DOMINIOS_MALOS = {
    # Stock photos / bancos de imágenes
    'shutterstock', 'getty', 'alamy.com', 'depositphotos', 'dreamstime',
    'istockphoto', 'logodix.com', 'clipart', 'vectorstock',
    # Redes sociales / marketplaces
    'pinterest', 'ebay', 'amazon', 'mercadolibre', 'facebook', 'instagram',
    # Noticias / entretenimiento
    'dailymail.co.uk', 'teletubbies', 'wikimedia', 'wikipedia',
    # Categorías de contenido incorrecto
    'wallpaper', 'background', 'recipe', 'food', 'chicken', 'cooking',
    'landscape', 'nature', 'travel', 'flower', 'baby', 'toy', 'cartoon',
    # E-commerce genérico (no fabricante)
    'linio', 'falabella', 'exito', 'alkosto', 'ktronix', 'olx',
    'carulla', 'jumbo', 'homecenter', 'shopify', 'woocommerce',
    # Pagos / fintech (falsos positivos)
    'payment', 'checkout', 'paypal', 'stripe',
}

DELAY = 9  # segundos entre productos


# === AUTH ===
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


# === DRIVE HELPERS ===
def archivo_existe(svc, nombre, parent_id):
    q = f"name='{nombre}' and '{parent_id}' in parents and trashed=false"
    res = svc.files().list(q=q, fields='files(id)').execute().get('files', [])
    return res[0]['id'] if res else None

def buscar_o_crear_carpeta(svc, nombre, parent_id):
    q = f"name='{nombre}' and '{parent_id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false"
    res = svc.files().list(q=q, fields='files(id)').execute().get('files', [])
    if res:
        return res[0]['id']
    meta = {'name': nombre, 'mimeType': 'application/vnd.google-apps.folder', 'parents': [parent_id]}
    return svc.files().create(body=meta, fields='id').execute()['id']

def subir_imagen(svc, nombre, bytes_img, parent_id):
    existente = archivo_existe(svc, nombre, parent_id)
    media = MediaIoBaseUpload(io.BytesIO(bytes_img), mimetype='image/jpeg', resumable=False)
    if existente:
        return svc.files().update(fileId=existente, media_body=media).execute()['id']
    meta = {'name': nombre, 'parents': [parent_id]}
    return svc.files().create(body=meta, media_body=media, fields='id').execute()['id']


# === IMAGEN HELPERS ===
def _es_imagen_valida(bytes_img):
    """Verifica bytes reales de imagen (>15KB, header correcto)."""
    if not bytes_img or len(bytes_img) < 15000:
        return False
    return bytes_img[:3] in (b'\xff\xd8\xff', b'\x89PN', b'GIF', b'RIFF', b'webp')

def _descargar_url(url):
    try:
        H = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'}
        r = requests.get(url, headers=H, timeout=15)
        if r.status_code == 200 and 'image' in r.headers.get('Content-Type', ''):
            return r.content
    except Exception:
        pass
    return None

def _es_dominio_malo(url):
    url_lower = url.lower()
    return any(d in url_lower for d in DOMINIOS_MALOS)

def _limpiar_ref(ref):
    """Elimina especificaciones de memoria (4/128GB, 8/256GB, etc.) de la referencia."""
    clean = re.sub(r'\s+\d+/\d+\s*GB.*', '', ref.strip(), flags=re.IGNORECASE)
    return clean.strip()


# === SCRAPER BING ===
def buscar_bing_imagen(page, referencia):
    """
    Busca en Bing Images usando los elementos a.iusc cuyo atributo 'm'
    contiene JSON con 'murl' = URL original de la imagen de producto.
    """
    try:
        ref_limpia = _limpiar_ref(referencia)
        q = re.sub(r'\s+', '+', ref_limpia) + '+official+product+image'
        url = f'https://www.bing.com/images/search?q={q}&form=HDRSC2'
        page.goto(url, wait_until='domcontentloaded', timeout=20000)
        page.wait_for_timeout(2000)

        links = page.query_selector_all('a.iusc')
        for link in links[:15]:
            m_attr = link.get_attribute('m') or ''
            if not m_attr:
                continue
            try:
                murl = json.loads(m_attr).get('murl', '')
                if murl.startswith('http') and not _es_dominio_malo(murl):
                    bytes_img = _descargar_url(murl)
                    if _es_imagen_valida(bytes_img):
                        return bytes_img
            except Exception:
                pass

        return None

    except PWTimeout:
        return None
    except Exception:
        return None


# === SYNC GITHUB PAGES ===
def sincronizar_catalogo_json(n_nuevas):
    """Regenera catalogo.json y hace git push."""
    os.makedirs(DATA_DIR, exist_ok=True)
    catalogo = {}
    specs_dir = os.path.join(DATA_DIR, 'specs')
    if os.path.exists(specs_dir):
        for fname in os.listdir(specs_dir):
            if not fname.endswith('.json'):
                continue
            slug_key = fname[:-5]
            try:
                with open(os.path.join(specs_dir, fname), encoding='utf-8') as f:
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
                        'creditek/data/catalogo.json', 'creditek/assets/imagenes/'],
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
        print(f"  ✗ Git error: {e.stderr.decode() if e.stderr else str(e)}")
        print(f"  → Push manual: git -C {REPO_PATH} add creditek/data/catalogo.json creditek/assets/imagenes/ && git commit -m '{msg}' && git push")


# === MAIN ===
def main():
    print("\n" + "="*70)
    print("  CREDITEK · OBTENER IMÁGENES (Playwright + Bing)")
    print("="*70 + "\n")

    if not os.path.exists(CATALOGO):
        print(f"✗ No encontré {CATALOGO}")
        print("  Corre primero catalogo_creditek.py")
        return

    with open(CATALOGO, encoding='utf-8') as f:
        catalogo = json.load(f)

    # Filtrar: marcas reconocidas sin imagen
    pendientes = []
    for slug_key, data in catalogo.items():
        if data.get('tiene_imagen'):
            continue
        marca = slug_key.split('_')[0]
        if marca in MARCAS_RECONOCIDAS:
            pendientes.append((slug_key, marca))

    print(f"✓ {len(pendientes)} productos con marca reconocida sin imagen\n")

    if not pendientes:
        print("✓ Nada que hacer — todas las marcas reconocidas ya tienen imagen")
        return

    print("→ Conectando a Google Drive...")
    svc = autenticar_drive()
    id_imgs = buscar_o_crear_carpeta(svc, '_IMAGENES', CARPETA_BASE)
    print(f"✓ Drive OK · _IMAGENES: {id_imgs}\n")

    os.makedirs(IMGS_DIR, exist_ok=True)

    exitos = 0
    fallos = 0
    total  = len(pendientes)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=[
            '--no-sandbox',
            '--disable-blink-features=AutomationControlled',
        ])
        ctx = browser.new_context(
            user_agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport={'width': 1280, 'height': 800},
        )
        page = ctx.new_page()
        page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")

        for i, (slug_key, marca) in enumerate(pendientes, 1):
            referencia = slug_key.replace('_', ' ')
            print(f"[{i:3}/{total}] {referencia[:55]:55} | {marca:10}", end=' ', flush=True)

            img_bytes = buscar_bing_imagen(page, referencia)

            if img_bytes:
                img_name   = f"{slug_key}.jpg"
                local_path = os.path.join(IMGS_DIR, img_name)
                with open(local_path, 'wb') as f:
                    f.write(img_bytes)
                subir_imagen(svc, img_name, img_bytes, id_imgs)
                print(f"→ ✓ Bing [{len(img_bytes)//1024}KB]")
                exitos += 1
            else:
                print("→ ✗ no encontrada")
                fallos += 1

            time.sleep(DELAY)

        browser.close()

    print("\n" + "="*70)
    print("  RESUMEN")
    print("="*70)
    print(f"  Imágenes obtenidas: {exitos}/{total}")
    print(f"  Sin imagen:         {fallos}/{total}")

    if exitos > 0:
        print("\n→ Actualizando catalogo.json y haciendo push...")
        sincronizar_catalogo_json(exitos)

    print("="*70 + "\n")


if __name__ == '__main__':
    main()
