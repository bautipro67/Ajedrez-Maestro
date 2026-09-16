"""
grabar-promo.py — graba los videos promocionales.

Dos formatos, del mismo motor:
  apaisado  960x540  -> 1920x1080  para YouTube y el GIF de itch.io
  vertical  540x960  -> 1080x1920  para Shorts, TikTok y Reels

Como funciona:
  1. Levanta un servidor estatico propio en un puerto libre. Hace falta: los
     modulos ES no cargan desde file://, Chrome los bloquea por CORS.
  2. Le pregunta a la propia pagina cuanto dura y donde van los sonidos
     (?datos=1 escupe un JSON en el DOM, que se lee con --dump-dom). Asi el
     guion vive en un solo sitio y este script no repite ni una constante.
  3. Llama a Chrome sin cabeza una vez por TIRA de fotogramas: la pagina
     acepta ?desde=N&cuantos=K y los apila uno debajo de otro, asi que con una
     sola captura salen K imagenes. Arrancar Chrome cuesta segundos; hacerlo
     una vez por fotograma seria absurdo.
  4. Recorta la tira con Pillow.
  5. Sintetiza el audio con las recetas del propio juego (tools/promo-audio.py).
  6. Junta todo con el ffmpeg que trae imageio-ffmpeg: H.264 + AAC en MP4, que
     es lo que aceptan las tres plataformas sin recodificar dos veces.

Uso:
  python tools/grabar-promo.py                      # los dos formatos, MP4
  python tools/grabar-promo.py --formato vertical
  python tools/grabar-promo.py --formato apaisado --gif
  python tools/grabar-promo.py --sin-musica
"""

import argparse
import functools
import http.server
import json
import os
import re
import shutil
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from PIL import Image

RAIZ = Path(__file__).resolve().parent.parent
SALIDA = RAIZ / "promo"


def _corto(ruta):
    """El nombre para imprimir: relativo al proyecto si cae dentro, y si no, entero."""
    try:
        return Path(ruta).resolve().relative_to(RAIZ)
    except ValueError:
        return Path(ruta)

FORMATOS = {
    "apaisado": {"pagina": "tools/promo.html", "ancho": 960, "alto": 540, "archivo": "promo-16-9"},
    "vertical": {"pagina": "tools/promo-vertical.html", "ancho": 540, "alto": 960, "archivo": "promo-vertical"},
}

# Chrome no puede componer una imagen de mas de 16384 px de lado; se deja un
# margen por si acaso y de ahi sale cuantos fotogramas entran en una tira.
MAX_TIRA_PX = 15000

CHROMES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
]


def buscar_chrome():
    for ruta in CHROMES:
        if os.path.exists(ruta):
            return ruta
    hallado = shutil.which("chrome") or shutil.which("msedge")
    if hallado:
        return hallado
    sys.exit("No encuentro Chrome ni Edge para capturar los fotogramas.")


def buscar_ffmpeg():
    hallado = shutil.which("ffmpeg")
    if hallado:
        return hallado
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        sys.exit("No encuentro ffmpeg. Con `pip install imageio-ffmpeg` viene uno dentro.")


def puerto_libre():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Silencioso(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def levantar_servidor(puerto):
    handler = functools.partial(Silencioso, directory=str(RAIZ))
    httpd = socketserver.TCPServer(("127.0.0.1", puerto), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def _chrome_base(chrome, perfil):
    return [
        chrome,
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        f"--user-data-dir={perfil}",
        # Sin esto la captura sale antes de que el modulo ES termine de pintar.
        "--virtual-time-budget=10000",
    ]


def preguntar_a_la_pagina(chrome, perfil, url):
    """Lee del DOM el JSON con la duracion y los sonidos que calcula el guion."""
    orden = _chrome_base(chrome, perfil) + ["--dump-dom", url]
    res = subprocess.run(orden, capture_output=True, text=True, timeout=180,
                         encoding="utf-8", errors="replace")
    hallado = re.search(r'<pre id="datos">(.*?)</pre>', res.stdout or "", re.S)
    if not hallado:
        sys.exit("La pagina no devolvio sus datos.\n" + (res.stderr or "")[-1500:])
    texto = (hallado.group(1)
             .replace("&quot;", '"').replace("&amp;", "&")
             .replace("&lt;", "<").replace("&gt;", ">"))
    return json.loads(texto)


def capturar_tira(chrome, perfil, url, ancho, alto, escala, destino):
    orden = _chrome_base(chrome, perfil) + [
        f"--force-device-scale-factor={escala}",
        f"--window-size={ancho},{alto}",
        f"--screenshot={destino}",
        url,
    ]
    res = subprocess.run(orden, capture_output=True, text=True, timeout=600,
                         encoding="utf-8", errors="replace")
    if not os.path.exists(destino):
        sys.exit(f"Chrome no genero la captura.\n{(res.stderr or '')[-1500:]}")


# --------------------------------------------------------------- fotogramas

def capturar(formato, fps, escala, chrome, puerto, perfil):
    cfg = FORMATOS[formato]
    base = f"http://127.0.0.1:{puerto}/{cfg['pagina']}?fps={fps}"
    datos = preguntar_a_la_pagina(chrome, perfil, base + "&datos=1")
    total = datos["total"]

    por_tira = max(1, int(MAX_TIRA_PX // (cfg["alto"] * escala)))
    carpeta = SALIDA / "fotogramas" / formato
    carpeta.mkdir(parents=True, exist_ok=True)
    for viejo in carpeta.glob("*.png"):
        viejo.unlink()

    print(f"[{formato}] {total} fotogramas a {fps} fps = {datos['duracion']:.1f} s, "
          f"{int(cfg['ancho'] * escala)}x{int(cfg['alto'] * escala)}, "
          f"{por_tira} por captura")

    t0 = time.time()
    hecho = 0
    while hecho < total:
        cuantos = min(por_tira, total - hecho)
        url = f"{base}&desde={hecho}&cuantos={cuantos}"
        tira = Path(tempfile.gettempdir()) / f"promo-{formato}-{hecho}.png"
        capturar_tira(chrome, perfil, url, cfg["ancho"], cfg["alto"] * cuantos, escala, str(tira))
        hoja = Image.open(tira).convert("RGB")
        alto_real = hoja.height // cuantos
        if hoja.width != int(cfg["ancho"] * escala) or alto_real != int(cfg["alto"] * escala):
            sys.exit(f"La tira salio de {hoja.size} para {cuantos} fotogramas; no cuadra.")
        for i in range(cuantos):
            hoja.crop((0, i * alto_real, hoja.width, (i + 1) * alto_real)) \
                .save(carpeta / f"{hecho + i:05d}.png")
        hoja.close()
        tira.unlink(missing_ok=True)
        hecho += cuantos
        transcurrido = time.time() - t0
        queda = transcurrido / hecho * (total - hecho)
        print(f"  [{formato}] {hecho}/{total}  (~{queda:.0f} s)", end="\r", flush=True)
    print(f"\n[{formato}] capturado en {time.time() - t0:.0f} s")
    return datos, carpeta


# -------------------------------------------------------------------- video

def armar_mp4(carpeta, datos, destino, fps, ffmpeg, musica, efectos):
    sys.path.insert(0, str(RAIZ / "tools"))
    import importlib.util
    spec = importlib.util.spec_from_file_location("promo_audio", RAIZ / "tools" / "promo-audio.py")
    audio = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(audio)

    wav = destino.with_suffix(".wav")
    pista = audio.construir(datos["eventos"], datos["duracion"], musica=musica, efectos=efectos)
    audio.escribir_wav(wav, pista)

    destino.parent.mkdir(parents=True, exist_ok=True)
    orden = [
        ffmpeg, "-y",
        "-framerate", str(fps), "-start_number", "0", "-i", str(carpeta / "%05d.png"),
        "-i", str(wav),
        "-c:v", "libx264",
        "-preset", "slow",
        "-crf", "18",
        # yuv420p es el unico formato que reproducen todas las plataformas y
        # todos los telefonos; sin esto hay moviles que ven un video negro.
        "-pix_fmt", "yuv420p",
        "-profile:v", "high", "-level", "4.1",
        # Un fotograma clave cada dos segundos: las plataformas recodifican y
        # con GOP largo el primer segundo sale borroso, que es justo el que
        # decide si alguien se queda.
        "-g", str(fps * 2),
        "-movflags", "+faststart",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-shortest",
        str(destino),
    ]
    res = subprocess.run(orden, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if res.returncode != 0 or not destino.exists():
        sys.exit("ffmpeg fallo:\n" + (res.stderr or "")[-2500:])
    wav.unlink(missing_ok=True)
    mb = destino.stat().st_size / 1024 / 1024
    print(f"{_corto(destino)}: {datos['duracion']:.1f} s, {mb:.2f} MB")


def armar_gif(carpeta, destino, ancho, fps):
    rutas = sorted(Path(carpeta).glob("*.png"))
    if not rutas:
        sys.exit("No hay fotogramas que juntar.")
    with Image.open(rutas[0]) as primera:
        alto = round(ancho * primera.height / primera.width / 2) * 2
    cuadros = [Image.open(r).convert("RGB").resize((ancho, alto), Image.LANCZOS) for r in rutas]

    # Una sola paleta para todo el video: si cada fotograma elige la suya, los
    # degradados del fondo cambian de color en cada cuadro y parpadea.
    paso = max(1, len(cuadros) // 8)
    muestras = cuadros[::paso][:8]
    muestra = Image.new("RGB", (ancho, alto * len(muestras)))
    for i, c in enumerate(muestras):
        muestra.paste(c, (0, i * alto))
    paleta = muestra.quantize(colors=255, method=Image.MEDIANCUT)

    # Sin difuminado. Con Floyd-Steinberg el mismo video pesa el triple: el
    # ruido rompe la compresion LZW y, sobre todo, hace que ningun pixel se
    # repita entre fotogramas, asi que no se puede guardar solo lo que cambia.
    convertidos = [c.quantize(palette=paleta, dither=Image.NONE) for c in cuadros]
    destino = Path(destino)
    destino.parent.mkdir(parents=True, exist_ok=True)
    convertidos[0].save(destino, save_all=True, append_images=convertidos[1:],
                        duration=round(1000 / fps), loop=0, optimize=True, disposal=1)
    mb = destino.stat().st_size / 1024 / 1024
    print(f"{_corto(destino)}: {len(convertidos)} cuadros, {ancho}x{alto}, {mb:.2f} MB")


# --------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--formato", choices=["apaisado", "vertical", "ambos"], default="ambos")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--escala", type=int, default=2, help="1 = tamaño CSS, 2 = el doble de pixeles")
    ap.add_argument("--gif", action="store_true", help="ademas del MP4, sacar el GIF")
    ap.add_argument("--gif-ancho", type=int, default=640)
    ap.add_argument("--gif-fps", type=int, default=12)
    ap.add_argument("--sin-musica", action="store_true", help="solo los sonidos del juego")
    ap.add_argument("--sin-audio", action="store_true")
    args = ap.parse_args()

    formatos = ["apaisado", "vertical"] if args.formato == "ambos" else [args.formato]
    chrome = buscar_chrome()
    ffmpeg = buscar_ffmpeg()
    musica = 0.0 if (args.sin_musica or args.sin_audio) else 1.0
    efectos = 0.0 if args.sin_audio else 1.0

    puerto = puerto_libre()
    httpd = levantar_servidor(puerto)
    perfil = tempfile.mkdtemp(prefix="promo-chrome-")
    try:
        for formato in formatos:
            datos, carpeta = capturar(formato, args.fps, args.escala, chrome, puerto, perfil)
            nombre = FORMATOS[formato]["archivo"]
            armar_mp4(carpeta, datos, SALIDA / f"{nombre}.mp4", args.fps, ffmpeg, musica, efectos)
            if args.gif:
                # El GIF va a menos fotogramas por segundo: a 30 pesa una
                # barbaridad y nadie nota la diferencia en un bucle corto.
                salto = max(1, round(args.fps / args.gif_fps))
                gifs = SALIDA / "gif" / formato
                gifs.mkdir(parents=True, exist_ok=True)
                for viejo in gifs.glob("*.png"):
                    viejo.unlink()
                for i, ruta in enumerate(sorted(carpeta.glob("*.png"))[::salto]):
                    shutil.copy(ruta, gifs / f"{i:05d}.png")
                armar_gif(gifs, SALIDA / f"{nombre}.gif", args.gif_ancho, args.fps / salto)
                shutil.rmtree(gifs, ignore_errors=True)
    finally:
        httpd.shutdown()
        httpd.server_close()
        shutil.rmtree(perfil, ignore_errors=True)


if __name__ == "__main__":
    main()
