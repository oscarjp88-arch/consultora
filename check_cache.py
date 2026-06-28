#!/usr/bin/env python3
from playwright.sync_api import sync_playwright
import time

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = b.new_context(
        viewport={'width': 1400, 'height': 900},
        # Force fresh load - no cache
        extra_http_headers={'Cache-Control': 'no-cache', 'Pragma': 'no-cache'}
    )
    page = ctx.new_page()
    page.goto('https://oscarjp88-arch.github.io/consultora/creditek/portal/',
              wait_until='networkidle', timeout=40000)
    time.sleep(3)

    cats = page.evaluate("""
        () => {
            const el = document.getElementById('vistaCategorias');
            return el ? 'FOUND: ' + el.innerHTML.substring(0, 100) : 'NOT FOUND';
        }
    """)
    print('vistaCategorias:', cats)

    page.screenshot(path='/tmp/ux_nocache.png')
    print('Screenshot: /tmp/ux_nocache.png')

    # If category screen found, click Celulares
    if 'FOUND' in cats:
        page.click("button.cat-btn:nth-child(1)")
        time.sleep(2)
        page.screenshot(path='/tmp/ux_celulares_new.png')
        print('Celulares: /tmp/ux_celulares_new.png')

    b.close()
