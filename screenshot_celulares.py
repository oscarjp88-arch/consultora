#!/usr/bin/env python3
from playwright.sync_api import sync_playwright
import time

URL = 'https://oscarjp88-arch.github.io/consultora/creditek/portal/'

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    page = b.new_page(viewport={'width': 1280, 'height': 900})
    page.goto(URL, wait_until='networkidle', timeout=30000)
    time.sleep(2)

    # Inspeccionar opciones del select
    opts = page.evaluate("""
        () => [...document.querySelectorAll('#filtroCategoria option')]
               .map(o => ({value: o.value, text: o.textContent.trim()}))
    """)
    print("Opciones filtroCategoria:", opts)

    # Seleccionar la opción que contiene "Celular"
    celular_val = next((o['value'] for o in opts if 'Celular' in o['text']), None)
    print(f"Valor a seleccionar: {celular_val!r}")

    if celular_val:
        page.select_option('#filtroCategoria', value=celular_val)
        time.sleep(1)

    # Buscar TECNO SPARK GO
    page.fill('#buscar', 'TECNO SPARK GO')
    time.sleep(1)
    page.screenshot(path='/tmp/tecno_spark_portal.png')
    print("Screenshot TECNO: /tmp/tecno_spark_portal.png")

    # Screenshot general celulares
    page.fill('#buscar', '')
    time.sleep(1)
    page.screenshot(path='/tmp/celulares_portal.png')
    print("Screenshot general: /tmp/celulares_portal.png")

    b.close()
