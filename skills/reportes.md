# Skill: Reporte Ejecutivo de Métricas para Clientes

## Objetivo
Generar reportes ejecutivos claros, accionables y personalizados por cliente, tipo de negocio y período. Cada reporte comunica el estado actual, tendencia vs período anterior y recomendaciones priorizadas usando un semáforo visual de rendimiento.

## Variables a completar
- [CLIENTE]: nombre de la empresa o marca
- [TIPO_NEGOCIO]: retail / fintech / servicios
- [PERÍODO_ACTUAL]: mes o rango de fechas del reporte (ej. Abril 2026)
- [PERÍODO_ANTERIOR]: mes o rango de comparación (ej. Marzo 2026)
- [RESPONSABLE]: nombre del consultor o equipo que presenta
- [OBJETIVO_PRINCIPAL]: meta de negocio vigente del cliente (ej. aumentar retención, reducir CAC)
- [MONEDA]: MXN / USD / EUR (para métricas financieras)
- [DATOS]: pegar aquí las métricas en crudo (tabla, CSV, texto libre)

---

## Estructura del Reporte

### 1. Portada y Contexto
```
REPORTE EJECUTIVO DE MÉTRICAS
Cliente: [CLIENTE]
Período: [PERÍODO_ACTUAL] vs [PERÍODO_ANTERIOR]
Objetivo principal del período: [OBJETIVO_PRINCIPAL]
Preparado por: [RESPONSABLE]
Fecha de emisión: [fecha actual]
```

### 2. Resumen Ejecutivo (máx. 5 líneas)
Una sola pantalla con:
- Resultado más importante del período (positivo o negativo)
- KPI que más mejoró y KPI que más cayó
- Una recomendación urgente
- Semáforo global del período (verde / amarillo / rojo)

### 3. Semáforo de Rendimiento Global
| Estado | Criterio |
|--------|----------|
| 🟢 Verde | ≥90% de KPIs en meta o superados |
| 🟡 Amarillo | 60–89% de KPIs en meta |
| 🔴 Rojo | <60% de KPIs en meta o KPI crítico en caída >10% |

Aplica el semáforo también a nivel de cada KPI individual.

### 4. Tabla de KPIs por Tipo de Negocio

Usa únicamente la sección correspondiente a [TIPO_NEGOCIO].

---

#### RETAIL
| KPI | Valor Actual | Valor Anterior | Tendencia | Meta | Semáforo |
|-----|-------------|----------------|-----------|------|----------|
| Ventas totales ([MONEDA]) | | | | | |
| Ticket promedio | | | | | |
| Tasa de conversión (%) | | | | | |
| Unidades vendidas | | | | | |
| Devoluciones / Cancelaciones (%) | | | | | |
| Tráfico total (visitas / clientes) | | | | | |
| Tasa de recompra (%) | | | | | |
| Margen bruto (%) | | | | | |
| Costo de adquisición de cliente (CAC) | | | | | |
| NPS / Satisfacción del cliente | | | | | |

**Cálculo de tendencia:** `((Actual - Anterior) / Anterior) × 100 = X%`
Mostrar como ▲ +X% (verde) o ▼ -X% (rojo).

---

#### FINTECH
| KPI | Valor Actual | Valor Anterior | Tendencia | Meta | Semáforo |
|-----|-------------|----------------|-----------|------|----------|
| Usuarios activos (MAU / DAU) | | | | | |
| Transacciones procesadas (vol.) | | | | | |
| Valor total transaccionado ([MONEDA]) | | | | | |
| Tasa de aprobación de transacciones (%) | | | | | |
| Tasa de fraude / chargebacks (%) | | | | | |
| Costo por transacción | | | | | |
| Tasa de activación de nuevas cuentas (%) | | | | | |
| Churn rate mensual (%) | | | | | |
| LTV promedio por usuario | | | | | |
| Tiempo promedio de onboarding (días) | | | | | |

---

#### SERVICIOS
| KPI | Valor Actual | Valor Anterior | Tendencia | Meta | Semáforo |
|-----|-------------|----------------|-----------|------|----------|
| Ingresos recurrentes ([MONEDA]) | | | | | |
| Proyectos / contratos activos | | | | | |
| Tasa de renovación de contratos (%) | | | | | |
| Utilización del equipo (%) | | | | | |
| Tiempo promedio de entrega (días) | | | | | |
| Satisfacción del cliente (CSAT / NPS) | | | | | |
| Costo de adquisición de cliente (CAC) | | | | | |
| Churn rate (%) | | | | | |
| Margen de operación (%) | | | | | |
| Tickets de soporte / incidencias abiertas | | | | | |

---

### 5. Análisis de Tendencias
Para cada KPI en semáforo amarillo o rojo, incluir:
- Causa probable (cambio de mercado, operación interna, estacionalidad)
- Si la tendencia es puntual o sostenida (llevar datos de 2–3 períodos atrás si existen)
- Impacto estimado en el [OBJETIVO_PRINCIPAL]

### 6. Recomendaciones Accionables
Listar de 3 a 5 recomendaciones ordenadas por impacto/esfuerzo:

| Prioridad | Acción | KPI que impacta | Responsable sugerido | Plazo |
|-----------|--------|-----------------|----------------------|-------|
| 1 (alta) | | | | |
| 2 (alta) | | | | |
| 3 (media) | | | | |
| 4 (media) | | | | |
| 5 (baja) | | | | |

Cada acción debe ser específica y medible: no "mejorar conversión" sino "lanzar prueba A/B en página de pago para reducir fricción — meta: +1.5pp de conversión en 30 días".

### 7. Metas para el Próximo Período
Proponer 3–5 metas SMART basadas en los resultados actuales:
- Específica, medible, alcanzable, relevante, con fecha límite
- Vincular cada meta con el [OBJETIVO_PRINCIPAL] del cliente

---

## Instrucciones de Uso

1. Completa todas las variables entre corchetes antes de generar el reporte.
2. Pega los [DATOS] en crudo al final del prompt — el modelo los mapeará a la tabla correcta.
3. Si un KPI no tiene meta definida previamente, el modelo usará benchmarks de industria para asignar semáforo.
4. El tono del reporte debe ser ejecutivo: directo, sin jerga técnica innecesaria, orientado a decisiones.
5. Si [TIPO_NEGOCIO] es mixto, combina las tablas relevantes e indica cuáles aplican.

---

## Prompt de Activación

```
Usando el skill de Reporte Ejecutivo de Métricas, genera el reporte para:

Cliente: [CLIENTE]
Tipo de negocio: [TIPO_NEGOCIO]
Período actual: [PERÍODO_ACTUAL]
Período anterior: [PERÍODO_ANTERIOR]
Objetivo principal: [OBJETIVO_PRINCIPAL]
Moneda: [MONEDA]
Responsable: [RESPONSABLE]

Datos del período:
[DATOS]
```
