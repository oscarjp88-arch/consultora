#!/usr/bin/env python3
"""
Detecta y elimina imágenes falsas positivas en creditek/assets/imagenes/:
  1. Duplicados exactos (mismo MD5 = misma imagen para productos distintos)
  2. Imágenes demasiado pequeñas (< 20KB = thumbnails/placeholders)
Luego regenera catalogo.json y hace git push para que el portal refleje los cambios.
"""

import os
import json
import hashlib
import subprocess
from datetime import datetime
from collections import defaultdict

REPO_PATH  = '/Users/oscarpacheco/consultora'
IMGS_DIR   = f'{REPO_PATH}/creditek/assets/imagenes'
DATA_DIR   = f'{REPO_PATH}/creditek/data'
SPECS_DIR  = f'{DATA_DIR}/specs'
CATALOGO   = f'{DATA_DIR}/catalogo.json'

MIN_BYTES  = 20_000  # imágenes < 20KB se consideran thumbnails

def md5(path):
    h = hashlib.md5()
    with open(path, 'rb') as f:
        h.update(f.read())
    return h.hexdigest()

def main():
    print("\n" + "="*70)
    print("  CREDITEK · LIMPIEZA DE IMÁGENES FALSAS")
    print("="*70 + "\n")

    archivos = [f for f in os.listdir(IMGS_DIR) if f.endswith('.jpg')]
    print(f"Total imágenes en disco: {len(archivos)}\n")

    # === 1. Detectar duplicados por MD5 ===
    hash_a_archivos = defaultdict(list)
    tamanos = {}
    for fname in archivos:
        path = os.path.join(IMGS_DIR, fname)
        h = md5(path)
        size = os.path.getsize(path)
        hash_a_archivos[h].append(fname)
        tamanos[fname] = size

    duplicados = {h: files for h, files in hash_a_archivos.items() if len(files) > 1}
    print(f"Grupos de duplicados exactos: {len(duplicados)}")
    for h, files in duplicados.items():
        size_kb = tamanos[files[0]] // 1024
        print(f"  [{size_kb}KB] {', '.join(f[:-4] for f in files)}")

    # === 2. Detectar imágenes pequeñas (no duplicadas) ===
    slugs_duplicados = {f for files in duplicados.values() for f in files}
    pequenas = [f for f in archivos if tamanos[f] < MIN_BYTES and f not in slugs_duplicados]
    print(f"\nImágenes pequeñas (< 20KB, no duplicadas): {len(pequenas)}")
    for f in pequenas:
        print(f"  [{tamanos[f]//1024}KB] {f[:-4]}")

    # === 3. Eliminar ===
    a_eliminar = list(slugs_duplicados) + pequenas
    print(f"\n→ Eliminando {len(a_eliminar)} archivos...")
    for fname in a_eliminar:
        path = os.path.join(IMGS_DIR, fname)
        os.remove(path)
        print(f"  ✗ {fname[:-4]}")

    # === 4. Regenerar catalogo.json ===
    print("\n→ Regenerando catalogo.json...")
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
    print(f"✓ catalogo.json regenerado: {con_img}/{len(catalogo)} con imagen")

    # === 5. Git push ===
    fecha = datetime.now().strftime('%Y-%m-%d')
    msg = f"fix: eliminar {len(a_eliminar)} imágenes falsas · {con_img}/{len(catalogo)} válidas · {fecha}"
    try:
        subprocess.run(['git', '-C', REPO_PATH, 'add',
                        'creditek/data/catalogo.json', 'creditek/assets/imagenes/'],
                       check=True, capture_output=True)
        diff = subprocess.run(['git', '-C', REPO_PATH, 'diff', '--cached', '--stat'],
                              capture_output=True, text=True).stdout.strip()
        if not diff:
            print("○ Sin cambios en git")
        else:
            subprocess.run(['git', '-C', REPO_PATH, 'commit', '-m', msg],
                           check=True, capture_output=True)
            subprocess.run(['git', '-C', REPO_PATH, 'push'],
                           check=True, capture_output=True)
            print(f"✓ Git push: \"{msg}\"")
    except subprocess.CalledProcessError as e:
        print(f"✗ Git error: {e.stderr.decode() if e.stderr else str(e)}")

    print("\n→ Ahora corre: python3 obtener_imagenes.py")
    print("="*70 + "\n")

if __name__ == '__main__':
    main()
