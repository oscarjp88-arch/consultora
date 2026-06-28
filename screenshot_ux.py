#!/usr/bin/env python3
from playwright.sync_api import sync_playwright
import time

URL = 'https://oscarjp88-arch.github.io/consultora/creditek/portal/'

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)

    # Desktop
    page = b.new_page(viewport={'width': 1400, 'height': 900})
    page.goto(URL, wait_until='networkidle', timeout=40000)
    time.sleep(2)
    page.screenshot(path='/tmp/ux_categorias.png')
    print("Pantalla categorías (desktop): /tmp/ux_categorias.png")

    # Click Celulares
    page.click("button.cat-btn:has-text('Celulares')")
    time.sleep(2)
    page.screenshot(path='/tmp/ux_celulares_200px.png')
    print("Celulares 200px (desktop): /tmp/ux_celulares_200px.png")

    # Botón ← Categorías
    page.click("button.back-btn")
    time.sleep(1)
    page.screenshot(path='/tmp/ux_back_categorias.png')
    print("Volver a categorías: /tmp/ux_back_categorias.png")

    # Móvil
    page2 = b.new_page(viewport={'width': 390, 'height': 844})
    page2.goto(URL, wait_until='networkidle', timeout=40000)
    time.sleep(2)
    page2.screenshot(path='/tmp/ux_mobile_categorias.png')
    print("Categorías móvil: /tmp/ux_mobile_categorias.png")
    page2.click("button.cat-btn:has-text('Celulares')")
    time.sleep(2)
    page2.screenshot(path='/tmp/ux_mobile_celulares.png')
    print("Celulares 120px (móvil): /tmp/ux_mobile_celulares.png")

    b.close()
