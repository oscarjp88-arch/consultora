# Panel de Métricas de Sofía Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mostrar claramente los leads pendientes y los clientes ya transferidos a asesor.

**Architecture:** Mantener el HTML actual y consumir los campos compatibles del endpoint `/api/stats`. Se añade una tarjeta sin modificar autenticación, conversaciones, ERP ni consultas directas a Supabase.

**Tech Stack:** HTML, CSS y JavaScript sin framework.

## Global Constraints

- Modificar únicamente `creditek/agentes/creditek-agente-respuestas.html`.
- No tocar `creditek/erp`.
- Mantener compatibilidad si el Worker anterior todavía devuelve solo `leads`.

---

### Task 1: Prueba de regresión del panel

**Files:**
- Create: `test/sofia-metricas-panel.test.mjs`
- Modify: `creditek/agentes/creditek-agente-respuestas.html`

**Interfaces:**
- Consumes: `leads_pendientes`, `leads` y `transferidos` de `/api/stats`.
- Produces: elementos `s-leads` y `s-transferidos`.

- [ ] **Step 1: Escribir la prueba que exige las etiquetas nuevas**

La prueba lee el HTML y verifica “Leads pendientes”, “Transferidos a asesor”, el elemento `s-transferidos` y el fallback `d.leads_pendientes ?? d.leads`.

- [ ] **Step 2: Ejecutar la prueba y comprobar RED**

Run: `node --test test/sofia-metricas-panel.test.mjs`

Expected: FAIL porque el panel todavía dice “Leads” y no tiene tarjeta de transferidos.

- [ ] **Step 3: Aplicar el cambio mínimo**

Renombrar la tarjeta `s-leads`, agregar `s-transferidos` y cargar ambos valores con fallback seguro.

- [ ] **Step 4: Ejecutar la prueba y comprobar GREEN**

Run: `node --test test/sofia-metricas-panel.test.mjs`

Expected: PASS.

- [ ] **Step 5: Verificar sintaxis y diff**

Run: `git diff --check`

Expected: exit 0.
