#!/usr/bin/env python3
import os, re, json, subprocess, time
from datetime import datetime
from playwright.sync_api import sync_playwright

REPO_PATH = '/Users/oscarpacheco/consultora'
IMGS_DIR  = f'{REPO_PATH}/creditek/assets/imagenes'
MIN_BYTES = 20_000

TARGETS = [
    ('SAMSUNG_A07_464GB',          'samsung galaxy a07'),
    ('SAMSUNG_A07_4128GB',         'samsung galaxy a07'),
    ('SAMSUNG_A07_6128GB_DUAL_SIM','samsung galaxy a07'),
    ('SAMSUNG_A26_5G_8256GB',      'samsung galaxy a26 5g'),
    ('SAMSUNG_A57_5G_8256GB',      'samsung galaxy a56 5g'),
    ('IPHONE_15_128GB',            'iphone 15'),
    ('INFINIX_SMART_10_4256GB',    'infinix smart 10'),
    ('TECNO_SPARK_GO2_4256GB',     'tecno spark go2'),
    ('TECNO_SPARK_50_5G_8256GB',   'tecno spark 50 5g'),
]

def _ok(b):
    if not b or len(b) < MIN_BYTES: return False
    return b[:3] == b'\xff\xd8\xff' or b[:4] in (b'\x89PNG', b'RIFF')

def buscar_falabella(page, query):
    url = f'https://www.falabella.com.co/falabella-co/search?Ntt={query.replace(" ","+")}'
    try:
        page.goto(url, wait_until='domcontentloaded', timeout=25000)
    except Exception:
        pass
    time.sleep(3)
    srcs = page.evaluate("""
        () => [...document.querySelectorAll('img[src*="media.falabella"]')]
               .map(i=>i.src||i.getAttribute('src')).filter(Boolean)
    """) or []
    bases_vistas = set()
    for src in srcs:
        base = re.sub(r'/(w=\d+.*|width=\d+.*|public)$', '', src.rstrip('/'))
        if base in bases_vistas: continue
        bases_vistas.add(base)
        pub = base + '/public'
        try:
            resp = page.request.get(pub, headers={'Referer':'https://www.falabella.com.co/'}, timeout=10000)
            if resp.ok:
                b = resp.body()
                if _ok(b): return b
        except Exception:
            pass
    return None

def main():
    print("\n=== Fix 9 imágenes pequeñas ===")

    cache = {}
    encontrados = []
    no_enc = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={'width':1280,'height':900},
            user_agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                       'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')
        page = ctx.new_page()

        for slug, query in TARGETS:
            dest = os.path.join(IMGS_DIR, slug + '.jpg')
            if query not in cache:
                print(f"  Buscando: «{query}»")
                b = buscar_falabella(page, query)
                cache[query] = b
            else:
                b = cache[query]

            if b:
                with open(dest, 'wb') as f: f.write(b)
                print(f"    ✓ {slug} {len(b)//1024}KB")
                encontrados.append(slug)
            else:
                print(f"    ✗ {slug}")
                no_enc.append(slug)

        browser.close()

    # Regenerar catalogo.json
    SPECS_DIR = f'{REPO_PATH}/creditek/data/specs'
    CATALOGO  = f'{REPO_PATH}/creditek/data/catalogo.json'
    catalogo = {}
    for fname in os.listdir(SPECS_DIR):
        if not fname.endswith('.json'): continue
        sk = fname[:-5]
        try:
            data = json.load(open(os.path.join(SPECS_DIR,fname), encoding='utf-8'))
            img_path = os.path.join(IMGS_DIR, sk+'.jpg')
            tiene = os.path.exists(img_path) and os.path.getsize(img_path) > MIN_BYTES
            catalogo[sk] = {'pantalla':data.get('pantalla',''),
                'ram_almacenamiento':data.get('ram_almacenamiento',''),
                'camara':data.get('camara',''),'bateria':data.get('bateria',''),
                'red':data.get('red',''),'sistema':data.get('sistema',''),
                'tiene_imagen':tiene,'confianza':data.get('confianza','')}
        except: pass
    json.dump(catalogo, open(CATALOGO,'w',encoding='utf-8'), ensure_ascii=False, indent=2)
    con_img = sum(1 for v in catalogo.values() if v['tiene_imagen'])
    print(f"\ncatalogo.json: {con_img}/{len(catalogo)} con imagen")

    # Git push
    fecha = datetime.now().strftime('%Y-%m-%d')
    msg = f"feat: +{len(encontrados)} imágenes · {con_img}/{len(catalogo)} total · {fecha}"
    subprocess.run(['git','-C',REPO_PATH,'add',
                    'creditek/data/catalogo.json','creditek/assets/imagenes/'], check=True, capture_output=True)
    diff = subprocess.run(['git','-C',REPO_PATH,'diff','--cached','--stat'],
                          capture_output=True, text=True).stdout.strip()
    if diff:
        subprocess.run(['git','-C',REPO_PATH,'commit','-m',msg], check=True, capture_output=True)
        subprocess.run(['git','-C',REPO_PATH,'push'], check=True, capture_output=True)
        print(f"✓ Push: {msg}")

    if no_enc:
        print(f"Sin imagen: {no_enc}")

if __name__ == '__main__':
    main()
