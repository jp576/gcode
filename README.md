# DXF → G-code CNC

Webapp local para generar G-code GRBL a partir de archivos DXF ASCII 2D.

## Uso

Abre `index.html` en un navegador moderno, carga un `.dxf`, ajusta las unidades y los parámetros de corte, pulsa **Generar G-code** y descarga el archivo `.nc`.

Admite entidades LINE, LWPOLYLINE, POLYLINE, CIRCLE, ARC, POINT y SPLINE racionales. Cada entidad tiene su propia operación: sobre línea, interior, exterior, perforar al centro o no mecanizar. Las perforaciones admiten `CIRCLE` del diámetro de la fresa (±0,2 mm) y `POINT`; los agujeros mayores se mecanizan por el interior. Las operaciones se ordenan como perforaciones, interiores, sobre línea y exteriores. Las curvas se aproximan con segmentos según la resolución indicada. Cada entidad puede tener profundidad final y número de pasadas propios: los niveles Z se calculan como fracciones de la profundidad final, y la última pasada llega exactamente a ella. La compensación de herramienta usa Clipper 6.4.2, incluido bajo la licencia Boost Software License 1.0 en vendor/. Todo se procesa en el navegador.

## Seguridad de mecanizado

El programa asume Z0 en la superficie del material y emite G-code absoluto en milímetros (`G21`, `G90`) para GRBL. Verifica unidades, origen, diámetros, profundidades, sujeción y trayectoria con un simulador; haz una prueba en vacío antes de mecanizar. No incluye detección completa de colisiones, pestañas de sujeción, entradas en rampa ni arcos G2/G3. Un corte exterior pasante puede liberar la pieza: agrega sujeción física o usa un CAM con pestañas antes de mecanizar.

## Desarrollo

`index.html`, `app.js` y `cam.js` son el código fuente. `dist/` contiene la versión estática publicable. Al modificar el código, copia estos tres archivos y vendor/ a dist/ antes de desplegar. Ejecuta node --test test/*.test.js para verificar el generador.
