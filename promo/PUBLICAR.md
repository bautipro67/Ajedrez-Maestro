# Los vídeos promocionales

Todo lo de esta carpeta sale de `tools/`. Para rehacerlo:

```bash
python tools/grabar-promo.py                  # los dos MP4
python tools/grabar-promo.py --formato vertical --sin-musica
```

Los fotogramas sueltos quedan en `promo/fotogramas/` y no se suben al repositorio:
son cientos de PNG de 1080p que se vuelven a generar en un rato.

## Qué archivo va a cada sitio

| Archivo | Medida | Dónde |
|---|---|---|
| `promo-vertical.mp4` | 1080×1920, 30 fps, 24 s, 4,0 MB | YouTube Shorts, TikTok, Reels |
| `promo-16-9.mp4` | 1920×1080, 30 fps, 20 s, 4,6 MB | YouTube normal, X, la ficha de itch.io |
| `promo.gif` | 640×360, 20 s, 4,5 MB | Captura animada de itch.io, Reddit, foros |
| `promo-ligero.gif` | 440×248, 20 s, 2,4 MB | Donde haya límite de 3 MB |

Los dos MP4 van en H.264 *High* con `yuv420p` y audio AAC a 48 kHz. Es
exactamente lo que piden las tres plataformas, así que no vuelven a
recodificar más de una vez y no hay móviles que vean la pantalla en negro.

## El vertical está pensado para el feed

No es el apaisado recortado: es otro guion.

- **Esquiva la interfaz.** TikTok dibuja la columna de botones sobre el 15 % de
  la derecha y el pie de foto sobre el 20 % de abajo. Nada que haga falta leer
  pasa de ahí; lo que sobresale es fondo.
- **Empieza por el gancho, no por el logotipo.** Los tres primeros segundos son
  una posición con mate en dos y una cuenta atrás. Quien sabe jugar quiere
  contestar y quien no, quiere ver cómo acaba. El logotipo llega en el segundo
  ocho, cuando ya se ha quedado.
- **Se entiende sin sonido**, que es como lo va a ver la mitad de la gente.

## El sonido

Los efectos no se parecen a los del juego: **son** los del juego.
`tools/promo-audio.py` rehace en numpy los mismos dos ladrillos que usa
`web/js/sound.js` —un oscilador con envolvente exponencial y un golpe de ruido
filtrado— y los alimenta con la misma tabla de recetas.

Encima va una cama de sintetizador escrita de cero. No hay nada de nadie, así
que ni Content ID de YouTube ni el filtro de música de TikTok tienen de qué
quejarse. Si molesta: `--sin-musica` deja solo los sonidos del tablero.

## Texto para la publicación

**Short / TikTok** — título:

> ¿Ves el mate en 2? · Morphy, Ópera de París 1858

**YouTube, descripción:**

> Ajedrez Maestro es un ajedrez completo que se abre en el navegador: 28
> rivales con carácter propio de 250 a 2900 de Elo, partidas online en directo,
> torneos con desempates de la FIDE, 150 problemas de táctica y análisis con
> motor propio. Sin instalar nada y sin crear ninguna cuenta.
>
> Jugar: https://ajedrez-maestro.onrender.com
>
> La partida del vídeo es Morphy contra el duque de Brunswick y el conde
> Isouard, Ópera de París, 1858.

**Etiquetas:** ajedrez, chess, ajedrez online, mate en 2, Morphy, gamedev,
javascript, juego de navegador.

## Antes de publicar

El cierre dice `ajedrez-maestro.onrender.com`. Si algún día la dirección buena
pasa a ser la de itch.io o la de GitHub Pages, se cambia `DIRECCION` en
`tools/promo-comun.js` y se vuelve a grabar: no hay que tocar nada más.
