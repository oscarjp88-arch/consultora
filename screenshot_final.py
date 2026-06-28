#!/usr/bin/env python3
from playwright.sync_api import sync_playwright
import time

URL = 'https://oscarjp88-arch.github.io/consultora/creditek/portal/'

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    page = b.new_page(viewport={'width': 1400, 'height': 900})
    page.goto(URL, wait_until='networkidle', timeout=40000)
    time.sleep(3)

    # Pantalla principal sin filtro
    page.screenshot(path='/tmp/portal_general.png')
    print("General: /tmp/portal_general.png")

    # Filtrar Celulares
    opts = page.evaluate("() => [...document.querySelectorAll('#filtroCategoria option')].map(o=>o.value)")
    print("Opciones:", opts)
    page.select_option('#filtroCategoria', 'Celulares')
    time.sleep(1)
    page.screenshot(path='/tmp/portal_celulares.png')
    print("Celulares: /tmp/portal_celulares.png")

    # Verificar JS fallback: buscar un producto sin imagen en catalogo pero con variante
    # (después de push, todos deben tener imagen en catalogo, pero verificar que JS funciona)

    b.close()
