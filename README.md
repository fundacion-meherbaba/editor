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
- **Aprobación:** lo que se guarda va a un *borrador*; la versión publicada solo cambia cuando quien
  publica aprueba. El botón **Cambios** muestra cada cambio párrafo por párrafo (tachado lo que se quita,
  subrayado lo que se agrega) con quién lo hizo y cuándo; se aprueba o rechaza todo junto o de a uno.
- Botón **PDF y EPUB**: genera el libro en GitHub y permite descargarlo.
- **Corrector ortográfico** en español (diccionario de Argentina de LibreOffice/RLA-ES, en
  `editor/vendor/diccionario/`, corre en el navegador): subraya en rojo las palabras desconocidas
  y en azul la puntuación (espacios antes de signos, espacios dobles, «...», palabras repetidas).
  Tocando una marca aparecen sugerencias; «Agregar al diccionario» guarda la palabra en el
  diccionario de la colección (`colecciones/<colección>/diccionario.txt` del repositorio de
  libros), compartido por todo el equipo. «Revisar» muestra el capítulo entero y corrige de a muchas.
  No revisa la cursiva (términos en otro idioma), las direcciones ni las marcas de bloque.
- **Gramática y estilo** (como «Ortografía y gramática» de Word): doble subrayado azul para la gramática
  (concordancia, tildes diacríticas, palabras que se confunden) y puntos dorados para el estilo
  (redundancias, muletillas; se activa en las opciones). Lo revisa [LanguageTool](https://languagetool.org)
  a través de `/api/gramatica`, de a párrafos, guardando lo ya revisado. El botón de engranaje abre las
  **Opciones de revisión** (cada tipo de marca se puede apagar, y una regla puntual también).
- **Comentarios**: se selecciona un tramo y se toca **Comentar** (o Ctrl/⌘ + Alt + M). El tramo queda
  resaltado en amarillo y el panel **Comentarios** los muestra con respuestas, *Resolver* y *Reabrir*.
  Se guardan en `libros/<libro>/comentarios/<capítulo>.json` (versión publicada), no pasan por la
  aprobación y no se imprimen. Cada comentario recuerda el texto citado y lo que lo rodea, así se
  vuelve a ubicar aunque el capítulo cambie; si el texto ya no está, el panel lo avisa.

- **Modo escucha** (`/escucha.html`, botón *Modo escucha*): para corregir sin mirar la pantalla. Lee en voz
  alta, párrafo por párrafo, el original en inglés y la traducción; con la voz (o el teclado, o botones
  grandes) se dice «pausa», «seguir», «repetir», «inglés», «castellano», «siguiente», «anterior»,
  «comentar»… El comentario dictado («listo» para terminar, «guardar» para confirmar) queda en el
  capítulo con el nombre de quien lo dictó, y el equipo lo ve en el editor. Lee con voces naturales de
  Google (Text-to-Speech, si está `GOOGLE_TTS_CLAVE`; el audio queda guardado en el navegador para no
  pedirlo dos veces) o, si no, con la voz del sistema (speechSynthesis). Entiende la voz con el
  reconocimiento del navegador (Chrome, Edge o Safari; Brave, Arc y Opera no lo traen): si se corta
  solo una y otra vez, apaga el micrófono y dice por qué. El original
  emparejado sale de `libros/<libro>/original/*.json` (ver `herramientas/alinear_original.py` en el
  repositorio de libros); un libro sin original se escucha solo en castellano.

## Configuración en Netlify

Variables de entorno (*Site configuration → Environment variables*):

| Variable | Qué poner |
|---|---|
| `GITHUB_TOKEN` | Token *fine-grained* de GitHub, solo para el repositorio `libros`, con permisos **Contents: Read and write** y **Actions: Read and write** |
| `GITHUB_REPO` | (opcional) por defecto `fundacion-meherbaba/libros` |
| `GOOGLE_CLIENT_ID` | ID de cliente OAuth (tipo *Web application*) con el dominio del editor como *Authorized JavaScript origin* |
| `EDITORES` | Correos habilitados, separados por coma. `@dominio.org` habilita un dominio entero |
| `SESSION_SECRET` | Un texto largo al azar (40 caracteres o más) |
| `PUBLICADORES` | Correos de quienes pueden aprobar cambios (también deben estar en `EDITORES`) |
| `LANGUAGETOOL_URL` | (opcional) otro servidor de LanguageTool; por defecto el público y gratuito `https://api.languagetool.org/v2/check` (unas 20 consultas por minuto) |
| `LANGUAGETOOL_USUARIO`, `LANGUAGETOOL_CLAVE` | (opcional) cuenta Premium de LanguageTool: más consultas y reglas adicionales |
| `GOOGLE_TTS_CLAVE` | (opcional) clave de API de Google Cloud, limitada a *Cloud Text-to-Speech API*, para las voces naturales del modo escucha. Sin ella se usan las voces del navegador |

Para sumar o quitar colaboradores alcanza con editar `EDITORES` y volver a publicar
(*Deploys → Trigger deploy*). El token de GitHub vence: renovarlo antes de la fecha.

## Estructura

```
editor/                  la página (HTML, CSS y JavaScript, sin compilación)
netlify/functions/api.mjs  intermediario con GitHub y con el inicio de sesión de Google
netlify.toml             configuración de Netlify
```
