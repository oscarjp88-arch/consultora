# Reglas de comportamiento — Cowork en Creditek OS

Estas reglas aplican a todo el trabajo de Cowork en este repositorio (`consultora`, `creditek-bot`, y cualquier otro Worker/proyecto de Creditek). Se agregaron el 13 de julio de 2026, después de una sesión donde se identificó como patrón valioso el hábito ya usado: verificar con código real antes de proponer o aplicar cambios.

## 1. No asumir en silencio — confirmar antes de avanzar

Si un documento de fix, una instrucción de Oscar, o una suposición propia no coincide con el código real, **decirlo explícitamente antes de aplicar nada** — no corregir en silencio ni aplicar la versión "que parece correcta" sin avisar. Ejemplo real de esta sesión: cuando un documento de fix asumía una arquitectura que no coincidía con el código real (ej. asumir que existía una `ANTHROPIC_API_KEY` en el servidor cuando en realidad vivía en el cliente), se debe parar y preguntar antes de decidir dónde aplicar el cambio.

## 2. No sobre-ingeniería — la solución más simple que resuelve el problema real

No convertir un fix de una línea en una refactorización grande, ni agregar abstracciones, configuraciones o parámetros que nadie pidió. Si una tarea parece requerir mucho más código del esperado, es señal de alto para confirmar el alcance con Oscar antes de seguir construyendo.

## 3. No tocar código fuera del alcance pedido

Cada cambio debe limitarse estrictamente a lo que el documento de fix o la instrucción de Oscar pide. Si en el camino se encuentra otro problema real (esto ha pasado varias veces y ha sido valioso), **reportarlo aparte**, no mezclarlo en el mismo commit sin avisar. Un commit debe poder explicarse en una sola frase clara.

## 4. Verificar antes de avanzar — código real, no memoria ni suposición

Antes de aplicar cualquier fix:
- Traer el código real y vigente del archivo a modificar (no confiar en lo que dice un documento de sesiones anteriores sin confirmar contra el archivo actual).
- Si el fix toca una API externa (Meta, OpenAI, Anthropic, WhatsApp Cloud API), confirmar el comportamiento exacto contra la documentación oficial vigente, no contra lo que se recuerde de antes — las políticas y APIs de estas plataformas cambian con frecuencia (ejemplo real: la categoría de anuncios "CREDIT" de Meta fue reemplazada por "FINANCIAL_PRODUCTS_SERVICES" sin que estuviera reflejado en la investigación previa).
- Después de aplicar, verificar sintaxis (`tsc --noEmit`, `node --check`, o el equivalente del lenguaje) antes de dar la tarea por completada.
- Si el fix depende de datos reales (Supabase, localStorage, comportamiento de un flujo en producción), preferir confirmar con una consulta o prueba real antes de asumir cuál es el estado actual.

## Nota sobre honestidad en el reporte

Si al aplicar un fix se descubre que la premisa del documento estaba equivocada, o que la solución real terminó siendo distinta a la propuesta, **reportarlo explícitamente y explicar por qué** — no presentar el resultado como si hubiera coincidido con el plan original cuando no fue así. Esto ya se ha hecho bien en varias ocasiones (ej. el diagnóstico correcto del problema de teléfono con `+` en vez de la hipótesis original de "registro nuevo sin heredar canal") y debe seguir siendo la norma.
