# Registro de clientes con enlaces privados y captadores verificados

**Fecha:** 23 de julio de 2026

**Estado:** Diseño aprobado por Oscar Pacheco

**Sistema afectado:** Registro público de clientes y Worker `creditek-clientes`

## 1. Objetivo

Convertir el registro público de clientes en una entrada confiable y privada
para tiendas propias, tiendas aliadas y promotores externos. Cada solicitud
debe conservar quién captó al cliente, para qué tienda lo hizo y mediante qué
enlace, sin revelar a los demás aliados ni permitir atribuciones manipuladas
desde el navegador.

La primera fase se limita a clientes, orígenes, captadores, documentos y
seguridad del registro. No modifica Sofía, ventas, créditos ni cartera.

## 2. Decisiones aprobadas

1. Se usará un modelo híbrido:
   - Cada tienda propia o aliada tendrá un enlace privado.
   - El enlace de tienda mostrará únicamente sus captadores activos.
   - Un promotor externo podrá tener además un enlace personal que deje su
     nombre seleccionado y bloqueado.
2. No se permitirán nombres de vendedores escritos libremente.
3. El enlace genérico no mostrará el catálogo de tiendas o aliados.
4. Los enlaces usarán el dominio oficial de Creditek.
5. Los enlaces actuales tendrán siete días de transición antes de quedar
   deshabilitados.
6. El formulario agregará la dirección del cliente.
7. El registro de clientes y las tablas nuevas de esta fase no agregarán:
   - valor financiado;
   - número o valor de cuotas;
   - tasa de interés.
   Esta decisión no elimina ni cambia campos que ya existan en los módulos de
   ventas o créditos.
8. La migración será aditiva y conservará compatibilidad temporal con los
   reportes y pantallas actuales.

## 3. Alcance funcional

### 3.1 Enlace privado de tienda

La URL pública tendrá esta forma:

```text
https://registro.crediteksas.com/creditek/erp/registro?t=<token-opaco>
```

Al abrirla:

1. El navegador solicita el contexto del token al Worker.
2. El Worker valida el token y confirma que siga activo.
3. El Worker devuelve exclusivamente:
   - nombre y código de la tienda asociada;
   - modalidad del enlace;
   - lista de captadores activos de esa tienda.
4. El formulario muestra la tienda como dato bloqueado.
5. Si es un enlace de tienda, muestra un selector de captadores.
6. Si es un enlace personal, muestra el captador preseleccionado y bloqueado.

Un token ausente, inválido, vencido o revocado no devuelve el catálogo. La
pantalla mostrará:

> Este enlace no es válido o ya no está activo. Solicita tu enlace oficial a
> Creditek.

### 3.2 Catálogo de captadores

Los captadores son personas que registran clientes y no equivalen
necesariamente a usuarios con acceso al ERP. Cada captador tendrá:

- identificador interno;
- tienda u origen asociado;
- nombre;
- tipo `empleado` o `tercero`;
- estado activo o inactivo;
- fecha de creación y actualización.

Desactivar un captador impedirá nuevas atribuciones, pero nunca borrará su
historial.

### 3.3 Formulario del cliente

El formulario conservará los campos actuales y los organizará en cinco
bloques:

1. Tienda y captador.
2. Identificación y contacto.
3. Producto y financiera.
4. Referencias.
5. Documentos y autorizaciones.

Campos del cliente:

- cédula;
- nombre completo;
- celular verificado por WhatsApp;
- correo opcional;
- ciudad;
- dirección;
- producto de interés;
- financiera opcional;
- referencias existentes;
- cédula frente;
- cédula reverso;
- selfie sosteniendo la cédula;
- autorización obligatoria de tratamiento de datos;
- autorización comercial opcional.

## 4. Modelo de datos

### 4.1 Tabla `captadores`

```text
id                uuid primary key
origen_codigo     text not null references origenes(codigo)
nombre            text not null
tipo              text not null check (tipo in ('empleado', 'tercero'))
activo            boolean not null default true
created_at        timestamptz not null default now()
updated_at        timestamptz not null default now()
```

Habrá un índice único por tienda y nombre normalizado para evitar duplicados
visuales dentro del mismo origen.

### 4.2 Tabla `enlaces_registro`

```text
id                    uuid primary key
token_hash            text unique not null
token_sufijo          text not null
origen_codigo         text not null references origenes(codigo)
captador_id            uuid null references captadores(id)
activo                boolean not null default true
created_at            timestamptz not null default now()
revoked_at            timestamptz null
ultima_utilizacion_at timestamptz null
```

Supabase almacenará únicamente el hash del token. El valor completo se
mostrará una vez al generarlo y se conservará en la hoja interna de Creditek.
`token_sufijo` permitirá identificar administrativamente el enlace sin revelar
su secreto.

Un enlace con `captador_id` nulo corresponde a una tienda. Un enlace con
`captador_id` corresponde a una persona y el captador debe pertenecer al mismo
`origen_codigo`.

### 4.3 Cambios en `solicitudes`

Se agregarán:

```text
captador_id        uuid null references captadores(id)
enlace_registro_id uuid null references enlaces_registro(id)
```

`origen_codigo` continuará guardándose como fotografía histórica del origen.
`vendedor_nombre` se conservará durante la transición como fotografía del
nombre y para compatibilidad con las pantallas existentes. El Worker derivará
ambos valores del enlace y del captador verificados; nunca confiará en valores
enviados libremente por el navegador.

### 4.4 Tabla `documentos_solicitud`

```text
id             uuid primary key
solicitud_id   uuid not null references solicitudes(id)
cliente_id     uuid not null references clientes(id)
tipo           text not null check (tipo in ('frente', 'reverso', 'selfie'))
storage_path   text not null
mime           text not null
tamano_bytes   integer not null
sha256         text not null
created_at     timestamptz not null default now()
```

Habrá una restricción única por `solicitud_id` y `tipo`. Esto preserva los
documentos exactos de cada solicitud en vez de reemplazar silenciosamente las
fotos históricas del cliente.

Durante la transición se mantendrá la escritura de las rutas más recientes en
las columnas actuales de `clientes`. El panel de validación preferirá
`documentos_solicitud` y usará las columnas antiguas solo como respaldo.

### 4.5 Verificación OTP de un solo uso

La verificación quedará vinculada a:

- cédula;
- celular;
- enlace de registro;
- vencimiento;
- estado consumido.

El código se generará con aleatoriedad criptográfica y se almacenará como
hash. Una verificación exitosa emitirá una sesión temporal de registro de un
solo uso. Al crear la solicitud, el Worker marcará esa sesión como consumida.
No podrá reutilizarse para otra cédula o para una segunda solicitud.

### 4.6 Conservación del primer origen del cliente

Al crear un cliente se guardará su origen inicial en la fila maestra. Si la
cédula ya existe, el registro actualizará únicamente los datos de contacto que
el cliente haya confirmado y no reemplazará ese origen inicial. Cada nueva
captación quedará registrada con su propio origen y captador en
`solicitudes`, que será la fuente de verdad para medir los intentos posteriores.

## 5. API del Worker

### `GET /api/registro/contexto?t=<token>`

Devuelve una sola tienda y sus captadores permitidos. Nunca devuelve el
catálogo global.

### `POST /api/otp/enviar`

Recibe token de enlace, cédula, celular y comprobante anti-robot. Valida el
contexto antes de enviar el código.

### `POST /api/otp/verificar`

Verifica el código y devuelve una sesión temporal de registro vinculada a
cédula, celular y enlace.

### `POST /api/registro`

Recibe la sesión temporal, token de enlace, captador seleccionado y datos del
cliente. El servidor:

1. resuelve el enlace;
2. valida que el captador esté activo y pertenezca al origen;
3. consume la sesión OTP;
4. actualiza o crea el cliente;
5. crea referencias;
6. crea la solicitud;
7. registra la auditoría;
8. devuelve un permiso temporal para subir documentos.

La creación del cliente, referencias, solicitud y evento de auditoría se
encapsulará en una operación transaccional de Supabase para evitar registros
parciales.

### `POST /api/documentos`

Reemplaza gradualmente `/api/subir-cedula`. Exige un permiso temporal asociado
a la solicitud y acepta únicamente `frente`, `reverso` o `selfie`.

### Compatibilidad temporal

`GET /api/origenes` y los enlaces `?origen=` existirán solo durante la ventana
de siete días. Una variable operativa permitirá deshabilitarlos sin volver a
publicar código. Después de la transición, `/api/origenes` no devolverá el
catálogo públicamente.

## 6. Seguridad

1. Tokens opacos de alta entropía y hashes comparados en el servidor.
2. Cloudflare Turnstile en el formulario.
3. Límites por teléfono, enlace y origen de red para OTP y registros.
4. CORS limitado al dominio oficial de Creditek y al entorno local de pruebas.
5. El Worker no confiará en `origen_codigo`, `vendedor_nombre`, `otp_ok` ni
   rutas de archivo enviados por el navegador.
6. Las fotografías:
   - se comprimirán en el navegador;
   - tendrán límite de tamaño;
   - se comprobarán por contenido real y no solo por extensión;
   - se convertirán a JPEG seguro;
   - se guardarán en bucket privado;
   - usarán rutas opacas con UUID, nunca la cédula.
7. El permiso de carga será temporal y estará vinculado a una solicitud.
8. La auditoría guardará identificadores internos y evitará duplicar cédulas
   completas en detalles de log.
9. Los secretos permanecerán en Cloudflare y no se incorporarán al HTML,
   repositorio, hoja de Google ni mensajes.

## 7. Manejo de errores

- Una fotografía fallida podrá reintentarse sin crear otra solicitud.
- Una solicitud ya creada conservará su identificador aunque falle una carga.
- El formulario distinguirá entre enlace inválido, captador inactivo, OTP
  vencido, código incorrecto, sesión consumida y error de conexión.
- Un cliente existente conservará su identificador maestro y recibirá una
  solicitud nueva.
- No se sobrescribirá el primer origen histórico del cliente; cada intento
  conservará su propio origen en `solicitudes`.
- Los mensajes al usuario no expondrán nombres de otras tiendas, estructura
  interna ni detalles sensibles.

## 8. Carga inicial

1. Crear los 28 orígenes de trabajo ya existentes:
   - 10 tiendas propias;
   - 18 aliados.
2. Crear captadores iniciales utilizando:
   - perfiles activos del ERP asociados a una tienda;
   - administradores/contactos verificados de la hoja interna.
3. Resolver duplicados por nombre y tienda antes de generar enlaces.
4. Generar un enlace de tienda para cada origen.
5. Generar enlaces personales solo para los terceros que Creditek decida
   identificar individualmente.
6. Actualizar la columna de enlaces en la hoja
   `Links_Registro_Creditek` con URLs del dominio Creditek.
7. La hoja seguirá siendo interna y no se compartirá con aliados.

## 9. Publicación gradual

1. Registrar inventario, versión activa y mecanismo de regreso del Worker.
2. Tomar respaldo verificable de Supabase.
3. Aplicar la migración aditiva.
4. Cargar captadores y generar enlaces.
5. Publicar el Worker con compatibilidad heredada activada.
6. Publicar el formulario nuevo.
7. Probar un enlace de tienda propia y uno de aliado.
8. Verificar los 28 enlaces automáticamente.
9. Actualizar la hoja de Google.
10. Distribuir los nuevos enlaces.
11. Mantener compatibilidad heredada durante siete días.
12. Deshabilitar `?origen=` y el catálogo público.

El despliegue conservará la versión anterior del Worker y el commit anterior
del formulario para regreso inmediato. La migración no eliminará tablas,
columnas ni datos.

## 10. Pruebas y criterios de aceptación

### Enlaces y privacidad

- El enlace genérico no revela tiendas.
- Cada token muestra una sola tienda.
- Un token no puede enumerar otros orígenes.
- Un token revocado deja de funcionar.
- Los 28 enlaces de tienda resuelven correctamente.

### Captadores

- Solo aparecen captadores activos de la tienda.
- Un captador de otra tienda es rechazado por el servidor.
- Un captador inactivo no puede crear solicitudes.
- Un enlace personal fija el captador correcto.

### OTP y registro

- El código expira y respeta límites de intentos.
- La sesión queda vinculada a cédula, celular y enlace.
- La sesión no puede consumirse dos veces.
- Un cliente existente no se duplica.
- Una nueva interacción crea una solicitud separada.

### Documentos

- Cada solicitud conserva frente, reverso y selfie.
- No se aceptan tipos, tamaños o contenido inválidos.
- Las rutas de almacenamiento no contienen cédulas.
- Un permiso de carga no sirve para otra solicitud.
- Un error de red puede reintentarse sin duplicar datos.

### Compatibilidad

- El panel de validación muestra origen, captador y documentos correctos.
- Los reportes existentes siguen leyendo `vendedor_nombre`.
- ERP, Sofía, ventas y cartera continúan operando.
- La versión anterior puede restaurarse sin pérdida de datos.

## 11. Fuera de alcance

- Cambios en el comportamiento de Sofía.
- Integración directa de la solicitud con una venta.
- Cambios en créditos o cartera.
- Valor financiado.
- Número o valor de cuotas.
- Tasa de interés.
- Eliminación o modificación de campos equivalentes que ya existan en ventas
  o créditos.
- Firma electrónica, carta antifraude o prueba de entrega del equipo.
- Migración de la organización de Supabase a cuentas corporativas; se mantiene
  como tarea separada.

## 12. Resultado esperado

Creditek tendrá una entrada única de clientes que identifica de manera
confiable la tienda y el captador, protege el directorio de aliados, conserva
los documentos por solicitud y deja una base preparada para medir
posteriormente conversión y calidad de cartera por origen.
