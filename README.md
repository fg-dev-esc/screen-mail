# Screen Mail

Aplicación personal para Windows: acumula capturas del monitor, transcribe su texto con Groq y envía un correo a tu propia cuenta con cada imagen y su transcripción debajo.

## Inicio

1. Instala Node.js 22 o posterior.
2. Abre `.env` y completa `MAIL_USER`, `MAIL_APP_PASSWORD` y `GROQ_API_KEY`. Si falta el archivo, copia `.env.example` como `.env`.
3. Ejecuta:

```powershell
cd C:\lffg\desk\screen-mail
npm install
npm start
```

La configuración inicial usa Gmail (`smtp.gmail.com`, puerto 465, TLS). La cuenta necesita contraseñas de aplicación habilitadas; introduce la contraseña de aplicación, no la contraseña normal. Puedes pegarla con espacios (`MAIL_APP_PASSWORD="abcd efgh ijkl mnop"`): la app elimina esos separadores al conectar a Gmail. El destinatario siempre es `MAIL_USER`. Para otro proveedor, ajusta `SMTP_HOST`, `SMTP_PORT` y `SMTP_SECURE` según su configuración. En el puerto 587 usa `SMTP_SECURE=false` (STARTTLS obligatorio).

`GROQ_VISION_MODEL` usa por defecto `qwen/qwen3.8-27b`, modelo de visión en preview documentado por Groq. Requiere acceso al modelo en tu cuenta. Las variables del entorno tienen prioridad sobre `.env`; reinicia la app después de cambiar la configuración.

### Cuotas de Groq

`GROQ_MAX_COMPLETION_TOKENS=800` limita la salida solicitada por captura. No es la cuota por minuto: si tu organización tiene 1000 OTPM, pedir 8192 tokens produce un 429 incluso con una sola imagen. Varias capturas consecutivas también pueden agotar la cuota compartida. Si la respuesta alcanza ese máximo, se conserva el texto recibido, editable y marcado como **Transcripción parcial** en el panel y el correo. Esperar no elimina el límite por respuesta.

Ante un 429 temporal, el panel muestra una cuenta regresiva y reintenta automáticamente al vencer `Retry-After` (o el plazo indicado por Groq; 60 segundos si no proporciona ninguno). **Cancelar OCR** interrumpe la petición o la espera conservando la imagen. También funciona si Enviar está esperando al OCR; las imágenes canceladas se envían igualmente. La cola es secuencial, así que las demás capturas esperan detrás de la actual. Una solicitud demasiado grande se muestra como error y no entra en un bucle de reintentos.

Consulta las cuotas exactas en https://console.groq.com/settings/limits (pasa el cursor sobre TPM para ver entrada/salida). El máximo técnico del modelo, la cantidad de imágenes por petición y las cuotas de la cuenta son límites distintos. Actualmente la documentación de Qwen indica hasta 3 imágenes por petición y 2048 tokens de entrada por imagen; la app usa una por petición.

`npm run groq:limits` hace un GET autenticado a `/openai/v1/models` usando la clave del archivo `.env`, sin imprimirla. Muestra el modelo y las cabeceras de límites si existen. Ese endpoint puede no devolver cuotas; la API pública documentada no ofrece un GET específico de cuotas de organización. Referencia: https://console.groq.com/docs/rate-limits

## Uso

- **Ctrl+Mayús+A:** muestra u oculta el panel sin perder el borrador. La app debe estar ejecutándose (`npm start`); ocultar no equivale a salir.
- El acceso directo de Inicio de Windows puede usar `--start-hidden` para iniciar en la bandeja sin abrir el panel. `npm start` lo muestra normalmente.
- **Ctrl+Mayús+S:** captura usando el modo elegido en el panel. El panel se oculta brevemente antes de capturar.
- **Modo de captura:** elige **Pantalla completa** (monitor donde está el cursor) o **Seleccionar sección** (arrastra un rectángulo sobre ese monitor; Esc cancela). Se guarda automáticamente en `settings.json` dentro del directorio de datos de la app y se conserva al reiniciar. El atajo usa directamente ese modo, sin preguntar cuál quieres en cada captura.
- Cada captura se añade al borrador y se transcribe en segundo plano, en orden. Puedes seguir capturando mientras se procesa OCR.
- Pulsa una miniatura para ampliarla. Corrige la transcripción directamente en su cuadro de texto.
- **× de una captura:** elimina esa imagen del borrador; si se estaba transcribiendo, cancela la solicitud.
- Escribe un mensaje, con o sin imágenes. Puedes enviar solo texto; un borrador sin imágenes y con texto vacío o solo espacios no se envía.
- **Ctrl+Enter dentro del panel**, o **Enviar:** espera las transcripciones pendientes y envía un correo con imágenes incrustadas y sus textos. Durante el envío, el borrador queda bloqueado.
- Un error de OCR permite reintentar esa captura, pero no bloquea el envío: cada imagen se incluye aunque no tenga transcripción. Si fallan todas, se envían las imágenes y el comentario opcional. Un error SMTP conserva imágenes, correcciones y comentario. Al aceptar SMTP el correo, se vacía el borrador.
- **Esc o × del panel:** oculta la ventana conservando el borrador.
- **Icono en la bandeja:** doble clic para mostrar el borrador; menú contextual para capturar o salir.

Las capturas y el texto solo viven en memoria; al salir se pierden. Groq recibe cada imagen para transcribirla y el proveedor de correo recibe el mensaje al pulsar Enviar. El panel recibe miniaturas y texto, nunca credenciales. El OCR generativo puede cometer errores: puedes corregir el pie antes de enviarlo.

El peso mostrado corresponde a los PNG originales. El límite SMTP predeterminado es 20 MiB e incluye una estimación conservadora de la codificación MIME; ajústalo con `SMTP_MAX_MB` según tu proveedor. La petición de visión también comprueba su tamaño, incluida la codificación base64. Un panel oculto durante 200 ms permite al compositor de Windows retirarlo de la captura; comprueba este comportamiento y el DPI en tus monitores.

## Código

- `main.js`: ventana, bandeja, atajo e IPC.
- `capture.js`: captura nativa de Electron y recorte adaptado al tamaño real de la imagen y al DPI del monitor.
- `selector.html`, `selector.css`, `selector.js`: selección rectangular sobre una imagen congelada del monitor.
- `draft.js`: borrador, cola OCR, edición y exclusión durante envío.
- `vision.js`: llamada a Groq con `fetch` nativo.
- `mail.js`: SMTP, HTML escapado, versión de texto y adjuntos inline con CID.
- `preload.js`: API limitada entre procesos.
- `panel.html`, `panel.css`, `panel.js`: interfaz.
- `fonts.css`, `assets/fonts/`: Geist, Geist Mono y Geist Pixel Square locales. Interfaz monocroma (negro, gris y blanco), logo blanco y ventanas sin esquinas redondeadas.

```powershell
npm run check
npm test
npm run test:ui
```

Las pruebas usan imágenes y servicios simulados; no capturan tu pantalla ni envían correos reales.

Documentación de visión: https://console.groq.com/docs/vision
