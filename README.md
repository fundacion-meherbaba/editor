# Editor de libros

Editor web de la Fundación para las Artes para corregir los libros de y acerca de Meher Baba.

Este repositorio solo tiene el **programa** del editor. Los textos, las fichas de estilo y la
exportación a PDF y EPUB están en el repositorio privado `fundacion-meherbaba/libros`.
El editor nunca guarda textos acá: los lee y los guarda en `libros` a través de
`netlify/functions/api.mjs`, que usa un token de GitHub guardado en Netlify (nunca en el código).

## Qué hace

- Cada colaborador entra con su cuenta de Google (solo los correos habilitados).
- Elige libro y capítulo, corrige con botones para cada etiqueta de la ficha del libro y ve la
  página con los estilos reales.
- Al guardar, el cambio queda en `libros` con su nombre; el historial muestra quién cambió qué.
- Si dos personas editan el mismo capítulo, avisa antes de pisar cambios ajenos.
- Botón **PDF y EPUB**: genera el libro en GitHub y permite descargarlo.

## Configuración en Netlify

Variables de entorno (*Site configuration → Environment variables*):

| Variable | Qué poner |
|---|---|
| `GITHUB_TOKEN` | Token *fine-grained* de GitHub, solo para el repositorio `libros`, con permisos **Contents: Read and write** y **Actions: Read and write** |
| `GITHUB_REPO` | (opcional) por defecto `fundacion-meherbaba/libros` |
| `GOOGLE_CLIENT_ID` | ID de cliente OAuth (tipo *Web application*) con el dominio del editor como *Authorized JavaScript origin* |
| `EDITORES` | Correos habilitados, separados por coma. `@dominio.org` habilita un dominio entero |
| `SESSION_SECRET` | Un texto largo al azar (40 caracteres o más) |

Para sumar o quitar colaboradores alcanza con editar `EDITORES` y volver a publicar
(*Deploys → Trigger deploy*). El token de GitHub vence: renovarlo antes de la fecha.

## Estructura

```
editor/                  la página (HTML, CSS y JavaScript, sin compilación)
netlify/functions/api.mjs  intermediario con GitHub y con el inicio de sesión de Google
netlify.toml             configuración de Netlify
```
