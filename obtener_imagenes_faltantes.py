#!/usr/bin/env python3
"""
Busca imágenes para los 48 productos del catálogo Creditek que aún no tienen imagen.
Estrategia: Falabella Colombia (primaria) → Alkosto (búsqueda).
Agrupa variantes del mismo dispositivo para reutilizar imagen.
"""

import os, re, json, subprocess, time
from datetime import datetime
from playwright.sync_api import sync_playwright

REPO_PATH = '/Users/oscarpacheco/consultora'
IMGS_DIR  = f'{REPO_PATH}/creditek/assets/imagenes'
DATA_DIR  = f'{REPO_PATH}/creditek/data'
SPECS_DIR = f'{DATA_DIR}/specs'
CATALOGO  = f'{DATA_DIR}/catalogo.json'
MIN_BYTES = 20_000

# slug → query de búsqueda. Misma query = mismo dispositivo físico → reutilizar imagen
TARGETS = [
    ('ADAPTADOR_ORIGINAL_SAMSUNG_25W',       'adaptador samsung 25w'),
    ('ADAPTADOR_SAMSUNG_25W',                'adaptador samsung 25w'),
    ('CARGADOR_SAMSUNG_25W',                 'cargador samsung 25w'),
    ('AIRE_ROWA_INVERTER_32_12000_BTU_110V_R32', 'aire acondicionado rowa 12000 btu'),
    ('AIRE_ROWA_INVERTER_32_12000_BTU_220V_R32', 'aire acondicionado rowa 12000 btu'),
    ('AIRE_ROWA_INVERTER_410_12000_BTU_220V_R410','aire acondicionado rowa 12000 btu'),
    ('AIRE_ROWA_ONOFF_12000_BTU_220V',       'aire acondicionado rowa 12000 btu'),
    ('AIRE_ROWA_INVERTER_32_18000_BTU_R32',  'aire acondicionado rowa 18000 btu'),
    ('AIRE_ROWA_ONOFF_18000_BTU',            'aire acondicionado rowa 18000 btu'),
    ('CORN_FLIP_K_4G',                       'celular corn flip k'),
    ('FLY_100',                              'celular fly 100'),
    ('FLY_200',                              'celular fly 200'),
    ('FLY_300',                              'celular fly 300'),
    ('FLY_500',                              'celular fly 500'),
    ('HONOR_AIRFYER_7LT',                    'honor air fryer 7 litros'),
    ('HONOR_CLEANER_ROBOT_VACUUM_R3',        'honor aspiradora robot'),
    ('HONOR_WATCH_2I',                       'honor watch 2i'),
    ('IMPRESORA_EPSON_L3210',                'impresora epson l3210'),
    ('IPAD_A16_128GB',                       'ipad a16'),
    ('PATINETA_XIAOMI_4_LITE',               'xiaomi scooter 4 lite'),
    ('PATINETA_XIAOMI_6_LITE',               'xiaomi scooter 6 lite'),
    ('SCOOTER_XIAOMI_6_LITE',                'xiaomi scooter 6 lite'),
    ('PORTATIL_ACER_AL1432P390X_5128_RAM',   'portatil acer spin'),
    ('PORTATIL_ASUS_VIVOBOOK_8512GB',        'asus vivobook'),
    ('PORTATIL_HP_CORE_I3_8256_15.6',        'portatil hp core i3'),
    ('PORTATIL_HP_RYZEN_5_16512GB',          'portatil hp ryzen 5'),
    ('PORTATIL_HP_TACTIL_8256GB_15.6',       'portatil hp tactil'),
    ('SMART_WATCH_GENERICO',                 'smartwatch generico'),
    ('TABLET_INFINIX_XPAD_30_4128GB',        'tablet infinix xpad 30'),
    ('TABLET_SAMSUNG_A11_8128GB',            'tablet samsung a11'),
    ('TAB_SAMSUNG_A11_8.7_WIFI_8128GB',      'tablet samsung a11'),
    ('TABLET_TECNO_MEGAPAD_10_PULG_4256GB',  'tecno megapad 10'),
    ('TECNO_MEGAPAD_10.1_WIFI_WITH_CASE_4256GB', 'tecno megapad 10'),
    ('TABLET_XIAOMI_PAD_2_CON_SIM_4128GB',   'xiaomi redmi pad 2'),
    ('TABLET_XIAOMI_REDMI_PAD_2_8256GB',     'xiaomi redmi pad 2'),
    ('TV_HYUNDAI_50',                        'tv hyundai 50 pulgadas'),
    ('TV_IFFALCON_FHD_43S55',                'tv iffalcon 43'),
    ('TV_IFFALCON_UHD_43U65',                'tv iffalcon 43'),
    ('TV_IFFALCON_FHD_50S55',                'tv iffalcon 50'),
    ('TV_IFFALCON_HD_32S55',                 'tv iffalcon 32'),
    ('TV_XKIM_32',                           'tv xkim 32'),
    ('XIAOMI_MI_TV_STICK_US',                'xiaomi tv stick'),
    ('XIAOMI_POWER_BANK_10.000MAH',          'xiaomi power bank 10000'),
    ('XIAOMI_POWER_BANK_10.000MAH_165W',     'xiaomi power bank 10000'),
    ('XIAOMI_POWER_BANK_20.000MAH_18W_FAST', 'xiaomi power bank 20000'),
    ('XIAOMI_SMART_BAND_9_ACTIVE',           'xiaomi smart band 9'),
    ('XIAOMI_WATCH_5_ACTIVE',                'xiaomi watch 5 active'),
    ('XIAOMI_WATCH_5_LITE',                  'xiaomi watch 5 lite'),
]

def _ok(b):
    if not b or len(b) < MIN_BYTES:
        return False
    return b[:4] in (b'\xff\xd8\xff\xe0', b'\xff\xd8\xff\xe1', b'\xff\xd8\xff\xdb',
                     b'\x89PNG', b'RIFF') or b[:3] == b'\xff\xd8\xff'

def buscar_falabella(page, query):
    """Busca en Falabella y devuelve bytes de la primera imagen válida."""
    url = f'https://www.falabella.com.co/falabella-co/search?Ntt={query.replace(" ","+")}'
    try:
        page.goto(url, wait_until='domcontentloaded', timeout=25000)
    except Exception:
        pass
    time.sleep(3)

    # Recolectar todas las URLs de media.falabella
    srcs = page.evaluate("""
        () => [...document.querySelectorAll('img[src*="media.falabella"]')]
               .map(i => i.src || i.getAttribute('src'))
               .filter(Boolean)
    """) or []

    if not srcs:
        return None

    # Deduplica por base URL (sin parámetros de tamaño)
    bases_vistas = set()
    for src in srcs:
        base = re.sub(r'/(w=\d+.*|width=\d+.*|public)$', '', src.rstrip('/'))
        if base in bases_vistas:
            continue
        bases_vistas.add(base)
        pub = base + '/public'
        try:
            resp = page.request.get(pub,
                headers={'Referer': 'https://www.falabella.com.co/'},
                timeout=10000)
            if resp.ok:
                b = resp.body()
                if _ok(b):
                    return b
        except Exception:
            pass

    return None


def buscar_alkosto(page, query):
    """Busca en Alkosto search results y toma screenshot del primer producto."""
    url = f'https://www.alkosto.com/search?text={query.replace(" ", "+")}'
    try:
        page.goto(url, wait_until='domcontentloaded', timeout=25000)
    except Exception:
        pass
    time.sleep(4)

    # Intentar capturar imagen del primer resultado via element screenshot
    selectors = [
        'li.product__item img[src*="cdn.dam.alkosto"]',
        'li.product__item img',
        '.product-image img',
    ]
    for sel in selectors:
        try:
            el = page.query_selector(sel)
            if el:
                box = el.bounding_box()
                if box and box['width'] > 40 and box['height'] > 40:
                    png = el.screenshot()
                    if png and len(png) > MIN_BYTES:
                        return png
        except Exception:
            pass
    return None


def main():
    print("\n" + "="*70)
    print("  CREDITEK · IMÁGENES FALTANTES (48 productos)")
    print("="*70 + "\n")

    # Agrupar por query para reutilizar imágenes
    query_a_slugs = {}
    for slug, query in TARGETS:
        query_a_slugs.setdefault(query, []).append(slug)

    cache_query = {}  # query → bytes encontrados
    encontrados = []
    no_encontrados = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(
            viewport={'width': 1280, 'height': 900},
            user_agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                       'AppleWebKit/537.36 (KHTML, like Gecko) '
                       'Chrome/124.0.0.0 Safari/537.36',
        )
        page = ctx.new_page()

        # Iterar por query única
        queries_unicas = list(dict.fromkeys(q for _, q in TARGETS))  # preserva orden
        for query in queries_unicas:
            slugs = query_a_slugs[query]

            # Saltar si todos ya tienen imagen en disco
            todos_ok = all(
                os.path.exists(os.path.join(IMGS_DIR, s+'.jpg')) and
                os.path.getsize(os.path.join(IMGS_DIR, s+'.jpg')) > MIN_BYTES and
                _ok(open(os.path.join(IMGS_DIR, s+'.jpg'),'rb').read(4))
                for s in slugs
            )
            if todos_ok:
                print(f"  ✓ (ya existe) {slugs[0]}")
                encontrados.extend(slugs)
                continue

            print(f"\n  Buscando: «{query}» → {slugs}")

            # Buscar: Falabella primero
            img_bytes = None
            if query not in cache_query:
                img_bytes = buscar_falabella(page, query)
                if img_bytes:
                    print(f"    Falabella ✓ {len(img_bytes)//1024}KB")
                else:
                    # Intento con Alkosto
                    img_bytes = buscar_alkosto(page, query)
                    if img_bytes:
                        print(f"    Alkosto ✓ {len(img_bytes)//1024}KB")
                    else:
                        print(f"    ✗ No encontrado")
                cache_query[query] = img_bytes
            else:
                img_bytes = cache_query[query]

            if img_bytes:
                for slug in slugs:
                    dest = os.path.join(IMGS_DIR, slug + '.jpg')
                    with open(dest, 'wb') as f:
                        f.write(img_bytes)
                    print(f"    → {slug}.jpg ({len(img_bytes)//1024}KB)")
                encontrados.extend(slugs)
            else:
                no_encontrados.extend(slugs)

        browser.close()

    # Regenerar catalogo.json
    print(f"\n→ Encontrados: {len(encontrados)}, Sin imagen: {len(no_encontrados)}")
    print("→ Regenerando catalogo.json...")

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
                    'tiene_imagen':       os.path.exists(img_path) and os.path.getsize(img_path) > MIN_BYTES,
                    'confianza':          data.get('confianza', ''),
                }
            except Exception:
                pass

    with open(CATALOGO, 'w', encoding='utf-8') as f:
        json.dump(catalogo, f, ensure_ascii=False, indent=2)

    con_img = sum(1 for v in catalogo.values() if v['tiene_imagen'])
    print(f"✓ catalogo.json: {con_img}/{len(catalogo)} con imagen")

    # Limpiar archivo spurious full.png de sesión anterior
    spurious = os.path.join(IMGS_DIR, 'TECNO_SPARK_GO_3_464GB_full.png')
    if os.path.exists(spurious):
        os.remove(spurious)
        print(f"  Eliminado: TECNO_SPARK_GO_3_464GB_full.png")

    # Git push
    fecha = datetime.now().strftime('%Y-%m-%d')
    msg = (f"feat: +{len(encontrados)} imágenes nuevas · "
           f"{con_img}/{len(catalogo)} total · {fecha}")
    try:
        subprocess.run(['git', '-C', REPO_PATH, 'add',
                        'creditek/data/catalogo.json',
                        'creditek/assets/imagenes/',
                        'creditek/portal/index.html'],
                       check=True, capture_output=True)
        diff = subprocess.run(['git', '-C', REPO_PATH, 'diff', '--cached', '--stat'],
                              capture_output=True, text=True).stdout.strip()
        if diff:
            subprocess.run(['git', '-C', REPO_PATH, 'commit', '-m', msg],
                           check=True, capture_output=True)
            subprocess.run(['git', '-C', REPO_PATH, 'push'],
                           check=True, capture_output=True)
            print(f"✓ Push: {msg}")
        else:
            print("○ Sin cambios git")
    except subprocess.CalledProcessError as e:
        print(f"✗ Git error: {e.stderr.decode() if e.stderr else str(e)}")

    if no_encontrados:
        print(f"\nSin imagen ({len(no_encontrados)}):")
        for s in no_encontrados:
            print(f"  · {s}")

    print("="*70 + "\n")

if __name__ == '__main__':
    main()
