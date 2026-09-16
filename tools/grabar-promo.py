"""
grabar-promo.py — saca los fotogramas de tools/promo.html y arma el GIF.

No hay ffmpeg en la maquina, asi que el video final es un GIF. Los PNG
sueltos quedan en la carpeta de fotogramas por si algun dia hay con que
codificar algo mejor.

Como funciona:
  1. Levanta un servidor estatico propio en un puerto libre (los modulos ES
     no cargan desde file://, Chrome los bloquea por CORS).
  2. Llama a Chrome sin cabeza una vez por TIRA de fotogramas: la pagina
     acepta ?desde=N&cuantos=K y los apila uno debajo de otro, asi que con
     una sola captura salen K imagenes. Arrancar Chrome cuesta casi un
     segundo; hacerlo 244 veces seria absurdo.
  3. Recorta la tira con Pillow y guarda cada fotograma.
  4. Junta todo en un GIF con paleta comun, para que no parpadee.

Uso:  python tools/grabar-promo.py [--ancho 640] [--fps 12] [--tira 20]
"""

import argparse
import functools
import http.server
import os
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
ANCHO_CUADRO = 960
ALTO_CUADRO = 540

CHROMES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]


def buscar_chrome():
    for ruta in CHROMES:
        if os.path.exists(ruta):
            return ruta
    hallado = shutil.which("chrome") or shutil.which("msedge")
    if hallado:
        return hallado
    sys.exit("No encuentro Chrome ni Edge para capturar los fotogramas.")


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
    hilo = threading.Thread(target=httpd.serve_forever, daemon=True)
    hilo.start()
    return httpd


def total_de_fotogramas():
    """Lee las duraciones del propio guion para no repetirlas aqui."""
    texto = (RAIZ / "tools" / "promo.html").read_text(encoding="utf-8")
    total = 0
    for linea in texto.splitlines():
        if "dura:" in linea and "pinta:" in linea:
            trozo = linea.split("dura:")[1].split(",")[0]
            total += int(trozo.strip())
    if total <= 0:
        sys.exit("No pude leer la duracion de las escenas en promo.html.")
    return total


def capturar_tira(chrome, perfil, url, alto, destino):
    orden = [
        chrome,
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        f"--user-data-dir={perfil}",
        # sin esto la captura sale antes de que el modulo ES termine de pintar
        "--virtual-time-budget=8000",
        f"--window-size={ANCHO_CUADRO},{alto}",
        f"--screenshot={destino}",
        url,
    ]
    res = subprocess.run(orden, capture_output=True, text=True, timeout=180)
    if not os.path.exists(destino):
        sys.exit(f"Chrome no genero la captura.\n{res.stderr[-1500:]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ancho", type=int, default=640, help="ancho del GIF final")
    ap.add_argument("--fps", type=int, default=12)
    ap.add_argument("--tira", type=int, default=20, help="fotogramas por captura")
    ap.add_argument("--salida", default="promo/promo.gif")
    ap.add_argument("--ligero", type=int, default=440,
                    help="ancho de una segunda copia mas liviana (0 para no hacerla)")
    args = ap.parse_args()

    chrome = buscar_chrome()
    total = total_de_fotogramas()
    print(f"{total} fotogramas ({total / args.fps:.1f} s a {args.fps} fps)")

    dir_frames = RAIZ / "promo" / "fotogramas"
    dir_frames.mkdir(parents=True, exist_ok=True)
    for viejo in dir_frames.glob("*.png"):
        viejo.unlink()

    puerto = puerto_libre()
    httpd = levantar_servidor(puerto)
    perfil = tempfile.mkdtemp(prefix="promo-chrome-")
    t0 = time.time()
    try:
        hecho = 0
        while hecho < total:
            cuantos = min(args.tira, total - hecho)
            alto = ALTO_CUADRO * cuantos
            url = f"http://127.0.0.1:{puerto}/tools/promo.html?desde={hecho}&cuantos={cuantos}"
            tira = Path(tempfile.gettempdir()) / f"promo-tira-{hecho}.png"
            capturar_tira(chrome, perfil, url, alto, str(tira))
            hoja = Image.open(tira).convert("RGB")
            if hoja.size != (ANCHO_CUADRO, alto):
                sys.exit(f"La tira salio de {hoja.size} y esperaba {(ANCHO_CUADRO, alto)}.")
            for i in range(cuantos):
                caja = (0, i * ALTO_CUADRO, ANCHO_CUADRO, (i + 1) * ALTO_CUADRO)
                hoja.crop(caja).save(dir_frames / f"{hecho + i:04d}.png")
            hoja.close()
            tira.unlink(missing_ok=True)
            hecho += cuantos
            print(f"  {hecho}/{total}", end="\r", flush=True)
    finally:
        httpd.shutdown()
        httpd.server_close()
        shutil.rmtree(perfil, ignore_errors=True)
    print(f"\ncapturados en {time.time() - t0:.1f} s")

    armar_gif(dir_frames, RAIZ / args.salida, args.ancho, args.fps)
    if args.ligero:
        destino = RAIZ / args.salida
        armar_gif(dir_frames, destino.with_name(destino.stem + "-ligero.gif"), args.ligero, args.fps)


def armar_gif(dir_frames, destino, ancho, fps):
    destino = Path(destino).resolve()
    rutas = sorted(Path(dir_frames).glob("*.png"))
    if not rutas:
        sys.exit("No hay fotogramas que juntar.")
    alto = round(ancho * ALTO_CUADRO / ANCHO_CUADRO / 2) * 2
    cuadros = [Image.open(r).convert("RGB").resize((ancho, alto), Image.LANCZOS) for r in rutas]

    # Una sola paleta para todo el video: si cada fotograma elige la suya, los
    # degradados del fondo cambian de color en cada cuadro y parpadea.
    muestra = Image.new("RGB", (ancho, alto * min(8, len(cuadros))))
    for i, c in enumerate(cuadros[:: max(1, len(cuadros) // 8)][:8]):
        muestra.paste(c, (0, i * alto))
    paleta = muestra.quantize(colors=255, method=Image.MEDIANCUT)

    # Sin difuminado. Con Floyd-Steinberg el mismo video pesa 12 MB en vez de
    # 4,5: el ruido que mete rompe la compresion LZW y, sobre todo, hace que
    # ningun pixel se repita entre fotogramas, asi que Pillow no puede guardar
    # solo lo que cambia. En un dibujo de colores planos como este no se nota.
    convertidos = [c.quantize(palette=paleta, dither=Image.NONE) for c in cuadros]
    destino.parent.mkdir(parents=True, exist_ok=True)
    convertidos[0].save(
        destino,
        save_all=True,
        append_images=convertidos[1:],
        duration=round(1000 / fps),
        loop=0,
        optimize=True,
        disposal=1,
    )
    mb = destino.stat().st_size / 1024 / 1024
    try:
        nombre = destino.relative_to(RAIZ)
    except ValueError:
        nombre = destino
    print(f"{nombre}: {len(convertidos)} cuadros, {ancho}x{alto}, {mb:.2f} MB")


if __name__ == "__main__":
    main()
