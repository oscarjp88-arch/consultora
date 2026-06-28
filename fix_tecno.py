#!/usr/bin/env python3
"""
Captura imagen TECNO SPARK GO 3 usando Playwright element screenshot
(evita CORS y AVIF del CDN de Alkosto).
"""

import os
import subprocess
import time
from datetime import datetime
from playwright.sync_api import sync_playwright

REPO_PATH = '/Users/oscarpacheco/consultora'
IMGS_DIR  = f'{REPO_PATH}/creditek/assets/imagenes'

PRODUCTOS = [
    {
        'slug':  'TECNO_SPARK_GO_3_4128GB',
        'url':   'https://www.alkosto.com/celular-tecno-spark-go3-128gb-4g-negro/p/4894947105272',
    },
    {
        'slug':  'TECNO_SPARK_GO_3_464GB',
        'url':   'https://www.alkosto.com/celular-tecno-spark-go-3-64gb-4g-negro/p/4894947105258',
    },
]

# Selectores candidatos para la imagen principal de producto en Alkosto
SELECTORES = [
    'img.image-gallery-image',
    '.product-image-gallery img',
    '.slick-slide.slick-active img[src*="cdn.dam.alkosto"]',
    'img[src*="cdn.dam.alkosto"]',
    '.product-main-image img',
    '.gallery-placeholder img',
    'figure img',
]

def capturar_producto(page, url, slug):
    dest = os.path.join(IMGS_DIR, slug + '.jpg')
    print(f"\n  Navegando: {url}")
    try:
        page.goto(url, wait_until='domcontentloaded', timeout=60000)
    except Exception:
        pass
    time.sleep(6)

    # Intenta cada selector
    for sel in SELECTORES:
        try:
            el = page.query_selector(sel)
            if el:
                box = el.bounding_box()
                if box and box['width'] > 50 and box['height'] > 50:
                    print(f"  Selector: {sel}  ({int(box['width'])}x{int(box['height'])})")
                    png = el.screenshot()
                    print(f"  PNG capturado: {len(png)/1024:.0f}KB")
                    with open(dest, 'wb') as f:
                        f.write(png)
                    print(f"  ✓ Guardado como PNG→JPG: {dest}")
                    return True
        except Exception as e:
            print(f"  Selector {sel} error: {e}")

    # Fallback: screenshot de zona central de la página
    print("  Fallback: screenshot viewport completo…")
    page.screenshot(path=dest.replace('.jpg', '_full.png'))
    print(f"  Screenshot guardado como referencia: {slug}_full.png")

    # Intenta sacar la URL de la imagen desde src attr y descargar via page.evaluate
    print("  Intentando fetch de CDN via page.evaluate…")
    cdns = page.evaluate("""
        () => [...document.querySelectorAll('img[src*="cdn.dam.alkosto"]')]
                .map(i => i.src)
                .filter(s => s.length > 30)
    """)
    print(f"  CDN URLs encontradas: {len(cdns)}")
    for cdn_url in cdns[:5]:
        print(f"    {cdn_url[:100]}")
        try:
            resp = page.evaluate(f"""
                async () => {{
                    const r = await fetch('{cdn_url}', {{mode:'no-cors', cache:'force-cache'}});
                    const ab = await r.arrayBuffer();
                    return Array.from(new Uint8Array(ab));
                }}
            """)
            if resp and len(resp) > 10000:
                data = bytes(resp)
                with open(dest, 'wb') as f:
                    f.write(data)
                print(f"  ✓ fetch via browser: {len(data)//1024}KB")
                return True
        except Exception as e:
            print(f"    fetch error: {e}")

    return False


def main():
    print("\n" + "="*60)
    print("  TECNO SPARK GO 3 — Fix imágenes via Playwright")
    print("="*60)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)  # visible para ver qué carga
        ctx = browser.new_context(
            viewport={'width': 1280, 'height': 900},
            user_agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                       'AppleWebKit/537.36 (KHTML, like Gecko) '
                       'Chrome/124.0.0.0 Safari/537.36',
        )
        page = ctx.new_page()

        resultados = {}
        for prod in PRODUCTOS:
            ok = capturar_producto(page, prod['url'], prod['slug'])
            resultados[prod['slug']] = ok

        browser.close()

    # Verificar tamaños
    print("\n--- Resultados ---")
    for prod in PRODUCTOS:
        dest = os.path.join(IMGS_DIR, prod['slug'] + '.jpg')
        if os.path.exists(dest):
            sz = os.path.getsize(dest)
            hdr = open(dest, 'rb').read(4)
            print(f"  {prod['slug']}: {sz//1024}KB hdr={hdr}")
        else:
            print(f"  {prod['slug']}: NO ENCONTRADO")

    # Git push si todo ok
    sizes_ok = all(
        os.path.exists(os.path.join(IMGS_DIR, p['slug'] + '.jpg')) and
        os.path.getsize(os.path.join(IMGS_DIR, p['slug'] + '.jpg')) > 20000
        for p in PRODUCTOS
    )

    if sizes_ok:
        fecha = datetime.now().strftime('%Y-%m-%d')
        msg = f"fix: imágenes TECNO SPARK GO 3 corregidas · {fecha}"
        subprocess.run(['git', '-C', REPO_PATH, 'add', 'creditek/assets/imagenes/'], check=True)
        diff = subprocess.run(['git', '-C', REPO_PATH, 'diff', '--cached', '--stat'],
                              capture_output=True, text=True).stdout.strip()
        if diff:
            subprocess.run(['git', '-C', REPO_PATH, 'commit', '-m', msg], check=True)
            subprocess.run(['git', '-C', REPO_PATH, 'push'], check=True)
            print(f"\n✓ Push: {msg}")
        else:
            print("\n○ Sin cambios en git (imágenes idénticas)")
    else:
        print("\n✗ Imágenes incompletas — no se hizo push")

    print("="*60 + "\n")


if __name__ == '__main__':
    main()
