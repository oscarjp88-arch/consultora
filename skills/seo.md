# Skill: Auditoría y Optimización SEO On-Page

## Objetivo
Auditar y optimizar páginas web para mejorar su posicionamiento orgánico en buscadores, adaptando las recomendaciones al cliente, sector y palabras clave objetivo.

## Variables a completar
- [CLIENTE]: nombre de la empresa o marca
- [SECTOR]: industria o categoría del negocio
- [URL]: URL de la página a auditar
- [PALABRA_CLAVE_PRINCIPAL]: término primario que debe rankear la página
- [PALABRAS_CLAVE_SECUNDARIAS]: términos de soporte (separados por coma)
- [UBICACION]: ciudad o país objetivo (para SEO local)
- [PUBLICO_OBJETIVO]: perfil del usuario que debe encontrar la página

---

## Checklist de Elementos On-Page

### Metadatos
- [ ] Meta título presente y optimizado (50-60 caracteres)
- [ ] Meta descripción presente y optimizada (140-155 caracteres)
- [ ] URL limpia, corta y con palabra clave principal
- [ ] Etiqueta canonical correctamente configurada
- [ ] Open Graph tags presentes (título, descripción, imagen)

### Encabezados (Headings)
- [ ] Un solo H1 por página, con la palabra clave principal
- [ ] H2 usados para secciones principales (incluir variaciones de keyword)
- [ ] H3 usados para subsecciones
- [ ] Jerarquía de encabezados coherente (no saltar de H1 a H3)

### Contenido
- [ ] Mínimo 600 palabras para páginas informativas / 300 para páginas de servicio
- [ ] Palabra clave principal en el primer párrafo
- [ ] Densidad de keyword natural (1-2%, sin keyword stuffing)
- [ ] Palabras clave secundarias y semánticas distribuidas en el texto
- [ ] Contenido responde claramente la intención de búsqueda del usuario
- [ ] Texto original (sin contenido duplicado interno ni externo)

### Imágenes
- [ ] Atributo ALT en todas las imágenes con descripción relevante
- [ ] Nombre de archivo descriptivo (no "IMG_001.jpg")
- [ ] Imágenes comprimidas (WebP preferido, máx. 150kb por imagen)
- [ ] Dimensiones adecuadas al diseño (sin redimensionar por CSS)

### Enlazado
- [ ] Al menos 2-3 enlaces internos a páginas relacionadas
- [ ] Texto ancla (anchor text) descriptivo en los enlaces internos
- [ ] Enlaces externos a fuentes de autoridad cuando aplique
- [ ] Sin enlaces rotos (404)

### Técnico
- [ ] Página carga en menos de 3 segundos (Core Web Vitals)
- [ ] Diseño responsive / mobile-first
- [ ] HTTPS activo
- [ ] No hay errores de rastreo en Search Console
- [ ] Datos estructurados (Schema.org) implementados donde aplique
- [ ] Sin contenido bloqueado por robots.txt o meta noindex accidentales

---

## Palabras Clave por Intención de Búsqueda

### Intención Informacional — el usuario quiere aprender
- Formato: "qué es [tema]", "cómo funciona [servicio]", "por qué [problema]"
- Contenido ideal: artículo de blog, guía, FAQ
- Ejemplo para [SECTOR]: "cómo funciona el crédito para celulares en Colombia"

### Intención Navegacional — el usuario busca una marca o sitio específico
- Formato: "[CLIENTE]", "[CLIENTE] + contacto", "[CLIENTE] + [ciudad]"
- Contenido ideal: homepage, página de contacto, página de ubicación
- Ejemplo: "Creditek Bogotá", "Creditek crédito celulares"

### Intención Comercial — el usuario compara opciones antes de decidir
- Formato: "mejor [servicio] en [ubicación]", "[servicio] vs [alternativa]", "[servicio] opiniones"
- Contenido ideal: landing page de servicio, página de comparativa
- Ejemplo para [SECTOR]: "mejor crédito para celular Colombia", "crédito celular sin requisitos"

### Intención Transaccional — el usuario está listo para actuar
- Formato: "comprar [producto]", "[servicio] precio", "[servicio] + [ciudad]", "solicitar [servicio]"
- Contenido ideal: landing de conversión, página de producto, formulario
- Ejemplo para [SECTOR]: "solicitar crédito celular Bogotá", "crédito celular mismo día"

---

## Plantillas de Meta Títulos

### Formato general
```
[Palabra Clave Principal] | [Diferenciador] — [CLIENTE]
```

### Por tipo de página

**Homepage**
```
[CLIENTE] — [BENEFICIO_CLAVE] en [UBICACION]
Máx. 60 caracteres. Ejemplo: "Creditek — Crédito para Celulares el Mismo Día en Colombia"
```

**Página de servicio**
```
[SERVICIO] en [UBICACION] | Sin [Objeción principal] — [CLIENTE]
Ejemplo: "Crédito para Celulares en Bogotá | Sin Trámites — Creditek"
```

**Artículo de blog / informacional**
```
[Pregunta o promesa de valor] — [CLIENTE]
Ejemplo: "Cómo Obtener Crédito para Celular en Colombia (Guía 2026) — Creditek"
```

**Landing de conversión**
```
[Acción] + [Producto] + [Beneficio inmediato] | [CLIENTE]
Ejemplo: "Solicita tu Crédito para Celular y Llévalo Hoy — Creditek"
```

---

## Plantillas de Meta Descripciones

### Estructura recomendada
```
[Beneficio o solución al problema] + [Diferenciador] + [CTA]
```

### Por tipo de página

**Homepage**
```
En [CLIENTE] te damos crédito para [PRODUCTO/SERVICIO] en [UBICACION].
[Diferenciador 1], [Diferenciador 2] y [Diferenciador 3]. [CTA].
Máx. 155 caracteres.
```
Ejemplo:
> "En Creditek te damos crédito para celular en Colombia. Aprobación en minutos, sin trámites y te llevas tu equipo el mismo día. ¡Solicítalo ahora!"

**Página de servicio**
```
¿Buscas [SERVICIO] en [UBICACION]? En [CLIENTE] [BENEFICIO_CLAVE].
[Proceso simplificado en una frase]. [CTA directo].
```
Ejemplo:
> "¿Buscas crédito para celular en Bogotá? En Creditek te aprobamos en minutos sin papeleo. Visítanos hoy y llévate tu equipo nuevo."

**Artículo de blog**
```
Descubre [qué aprenderá el usuario] en esta guía completa.
[Dato de valor o promesa específica]. Lee más en [CLIENTE].
```
Ejemplo:
> "Descubre cómo obtener crédito para celular en Colombia sin complicaciones. Requisitos mínimos, proceso rápido y consejos para elegir bien. Guía 2026."

**Landing de conversión**
```
[Urgencia o beneficio inmediato]. [CLIENTE] te ofrece [SERVICIO] con [Diferenciador].
[CTA con fricción mínima].
```
Ejemplo:
> "Llévate tu celular nuevo hoy mismo. Creditek te ofrece crédito rápido sin trámites en Colombia. Solicita en minutos y úsalo hoy."

---

## Instrucciones de uso

1. Completa las variables del cliente antes de iniciar la auditoría
2. Ejecuta el checklist on-page y anota el estado de cada ítem: ✅ OK / ⚠️ Mejorar / ❌ Falta
3. Identifica la intención de búsqueda principal de la página antes de redactar o corregir contenido
4. Redacta meta título y meta descripción usando las plantillas del sector correspondiente
5. Prioriza correcciones en este orden: técnico → metadatos → contenido → imágenes → enlazado

## Notas
- Nunca optimizar una página para más de 1-2 palabras clave principales
- La intención de búsqueda tiene prioridad sobre la densidad de keyword
- Los meta títulos y descripciones deben ser únicos en todo el sitio
- Revisar posicionamiento actual antes de modificar páginas que ya rankean en top 10
