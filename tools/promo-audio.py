"""
promo-audio.py — la banda sonora de los videos promocionales.

Los efectos NO son parecidos a los del juego: son los mismos. `web/js/sound.js`
sintetiza cada sonido con dos ladrillos, un oscilador con envolvente
exponencial (`tone`) y un golpe de ruido filtrado (`thud`), y aqui estan los
dos reescritos en numpy con las mismas formulas que usa la Web Audio API,
alimentados por la misma tabla de recetas. Asi el clac de una pieza al caer
suena igual en el video que en la partida.

Encima va una cama musical minima —un bajo, una triada sostenida y un pulso—
construida con el mismo `tone`. Es sintetizada de cero, con lo cual no hay
ningun problema de derechos en YouTube ni en TikTok. Se puede quitar.
"""

import math

import numpy as np

SR = 48000


# ---------------------------------------------------------------- ladrillos

def _envolvente(n, gain, attack, dur):
    """
    La misma curva que `GainNode.exponentialRampToValueAtTime`: de 0.0001 a
    `gain` en `attack` segundos y de vuelta a 0.0001 al llegar a `dur`. Es
    exponencial, no lineal, que es lo que le da el golpe seco.
    """
    t = np.arange(n) / SR
    piso = 0.0001
    pico = max(0.0002, gain)
    subida = piso * (pico / piso) ** np.clip(t / max(attack, 1e-6), 0, 1)
    caida = pico * (piso / pico) ** np.clip(
        (t - attack) / max(dur - attack, 1e-6), 0, 1)
    return np.where(t < attack, subida, caida)


def tone(freq, dur=0.12, gain=0.3, tipo="sine", sweep_to=None, attack=0.004):
    """Un blip con altura. Equivale a `tone()` de sound.js."""
    n = int(dur * SR)
    if n <= 0:
        return np.zeros(0, dtype=np.float32)
    t = np.arange(n) / SR
    if sweep_to:
        # exponentialRampToValueAtTime sobre la frecuencia: hay que integrarla
        # para sacar la fase, no basta con multiplicar.
        destino = max(1.0, sweep_to)
        k = math.log(destino / freq) / max(dur, 1e-6)
        fase = 2 * math.pi * freq * (np.exp(k * t) - 1) / k if abs(k) > 1e-9 else 2 * math.pi * freq * t
    else:
        fase = 2 * math.pi * freq * t

    if tipo == "sine":
        onda = np.sin(fase)
    elif tipo == "triangle":
        onda = 2 / math.pi * np.arcsin(np.sin(fase))
    elif tipo == "square":
        onda = np.sign(np.sin(fase))
    elif tipo == "sawtooth":
        onda = 2 * ((fase / (2 * math.pi)) % 1.0) - 1
    else:
        onda = np.sin(fase)

    return (onda * _envolvente(n, gain, attack, dur)).astype(np.float32)


def _ruido(n):
    """
    El mismo ruido que `makeNoise()`: un generador congruencial sembrado en
    12345. Sembrado a proposito, para que dos grabaciones del mismo video
    salgan byte a byte iguales.
    """
    datos = np.empty(n, dtype=np.float32)
    semilla = 12345
    for i in range(n):
        semilla = (semilla * 1103515245 + 12345) & 0x7FFFFFFF
        datos[i] = (semilla / 0x3FFFFFFF) - 1
    return datos


_CACHE_RUIDO = None


def _ruido_cacheado(n):
    global _CACHE_RUIDO
    if _CACHE_RUIDO is None or len(_CACHE_RUIDO) < n:
        _CACHE_RUIDO = _ruido(max(n, SR))
    return _CACHE_RUIDO[:n]


def _bandpass(x, f0, q):
    """Biquad pasa banda, receta RBJ — la misma que implementa BiquadFilterNode."""
    w0 = 2 * math.pi * f0 / SR
    alpha = math.sin(w0) / (2 * max(q, 0.0001))
    b = np.array([alpha, 0.0, -alpha])
    a = np.array([1 + alpha, -2 * math.cos(w0), 1 - alpha])
    b /= a[0]
    a = a / a[0]
    y = np.zeros_like(x)
    x1 = x2 = y1 = y2 = 0.0
    for i, xi in enumerate(x):
        yi = b[0] * xi + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2
        y[i] = yi
        x2, x1 = x1, xi
        y2, y1 = y1, yi
    return y


def thud(dur=0.09, gain=0.35, freq=900, q=1.6):
    """La parte de madera de una pieza al caer. Equivale a `thud()` de sound.js."""
    n = int(dur * SR)
    if n <= 0:
        return np.zeros(0, dtype=np.float32)
    filtrado = _bandpass(_ruido_cacheado(n).astype(np.float64), freq, q)
    return (filtrado * _envolvente(n, gain, 0.003, dur)).astype(np.float32)


def _mezclar(partes):
    """Junta trozos que empiezan en momentos distintos dentro de un mismo sonido."""
    largo = max((int(t * SR) + len(a) for t, a in partes), default=0)
    fuera = np.zeros(largo, dtype=np.float32)
    for t, a in partes:
        i = int(t * SR)
        fuera[i:i + len(a)] += a
    return fuera


# ------------------------------------------------------------------ recetas

# Copiadas una a una de RECIPES en web/js/sound.js.
RECETAS = {
    "click": lambda: _mezclar([(0, thud(gain=0.16, dur=0.035, freq=2200, q=2))]),

    "move": lambda: _mezclar([
        (0, thud(gain=0.34, dur=0.075, freq=780, q=1.2)),
        (0, tone(190, dur=0.075, gain=0.2, sweep_to=120)),
    ]),

    "capture": lambda: _mezclar([
        (0, thud(gain=0.45, dur=0.1, freq=480, q=0.9)),
        (0.012, thud(gain=0.3, dur=0.09, freq=1500, q=1.4)),
        (0, tone(150, tipo="triangle", dur=0.1, gain=0.24, sweep_to=80)),
    ]),

    "castle": lambda: _mezclar([
        (0, thud(gain=0.3, dur=0.07, freq=760, q=1.2)),
        (0.085, thud(gain=0.32, dur=0.08, freq=620, q=1.2)),
        (0, tone(170, dur=0.16, gain=0.16, sweep_to=110)),
    ]),

    "check": lambda: _mezclar([
        (0, tone(880, tipo="triangle", dur=0.1, gain=0.28)),
        (0.09, tone(1174, tipo="triangle", dur=0.16, gain=0.26)),
    ]),

    "gameStart": lambda: _mezclar([
        (0, tone(392, dur=0.16, gain=0.26)),
        (0.12, tone(587, dur=0.26, gain=0.24)),
    ]),

    "win": lambda: _mezclar([
        (i * 0.09, tone(f, dur=0.3, gain=0.26))
        for i, f in enumerate([523, 659, 784, 1047])
    ]),

    "notify": lambda: _mezclar([
        (0, tone(784, dur=0.1, gain=0.2)),
        (0.08, tone(1046, dur=0.16, gain=0.18)),
    ]),

    "lowTime": lambda: _mezclar([(0, tone(1320, tipo="square", dur=0.05, gain=0.16))]),
}

_HECHOS = {}


def receta(nombre):
    if nombre not in _HECHOS:
        _HECHOS[nombre] = RECETAS.get(nombre, RECETAS["click"])()
    return _HECHOS[nombre]


# ------------------------------------------------------------------- musica

# Am - F - C - G, cuatro compases de dos segundos. Nada original, pero con
# sinusoides suaves y muy por debajo de los efectos hace lo que tiene que
# hacer: que el video no entre mudo, que es media batalla en TikTok.
PROGRESION = [
    (220.00, [220.00, 261.63, 329.63]),   # La menor
    (174.61, [174.61, 220.00, 261.63]),   # Fa mayor
    (261.63, [196.00, 261.63, 329.63]),   # Do mayor
    (196.00, [196.00, 246.94, 293.66]),   # Sol mayor
]
COMPAS = 2.0


def cama(duracion, ganancia=1.0):
    """La cama musical: bajo, triada sostenida y un pulso cada medio compás."""
    n = int(duracion * SR)
    fuera = np.zeros(n, dtype=np.float32)
    if ganancia <= 0:
        return fuera

    compases = int(math.ceil(duracion / COMPAS))
    for c in range(compases):
        t0 = c * COMPAS
        bajo, triada = PROGRESION[c % len(PROGRESION)]
        # El bajo una octava abajo, largo y muy suave.
        trozos = [(t0, tone(bajo / 2, dur=COMPAS * 0.98, gain=0.085 * ganancia, attack=0.25))]
        for f in triada:
            trozos.append((t0 + 0.04, tone(f, dur=COMPAS * 0.9, gain=0.032 * ganancia, attack=0.4)))
        # Pulso a negras: da marcha sin meterse en medio.
        for k in range(4):
            trozos.append((t0 + k * (COMPAS / 4), tone(bajo / 4, dur=0.1, gain=0.075 * ganancia)))
        parte = _mezclar(trozos)
        i = int(t0 * SR)
        fin = min(n, i + len(parte))
        if fin > i:
            fuera[i:fin] += parte[:fin - i]

    # Entra y sale sin cortes.
    entrada = int(0.9 * SR)
    salida = int(1.4 * SR)
    if n > entrada + salida:
        fuera[:entrada] *= np.linspace(0, 1, entrada)
        fuera[-salida:] *= np.linspace(1, 0, salida)
    return fuera


# ------------------------------------------------------------------- mezcla

def construir(eventos, duracion, musica=1.0, efectos=1.0):
    """
    Monta la pista entera: la cama debajo y un sonido por evento encima.
    `eventos` es lo que escupe la propia página: [{t, sonido, ganancia}].
    """
    n = int(math.ceil(duracion * SR))
    pista = cama(duracion, musica)

    for ev in eventos:
        muestra = receta(ev.get("sonido", "click"))
        g = float(ev.get("ganancia") or 1.0) * efectos
        i = int(float(ev["t"]) * SR)
        if i >= n:
            continue
        fin = min(n, i + len(muestra))
        pista[i:fin] += muestra[:fin - i] * g

    # Se normaliza por pico a 0.85: sin esto la mezcla sale sobre 0.28 y el
    # video entra mucho mas flojo que lo que hay alrededor en el feed, que es
    # la forma mas tonta de que alguien pase de largo. Escalar el conjunto
    # entero respeta las proporciones entre efectos y cama, y de paso nunca
    # recorta un pico ni mete distorsion.
    pico = float(np.max(np.abs(pista))) if len(pista) else 0.0
    if pico > 0:
        pista *= 0.85 / pico
    return pista


def escribir_wav(ruta, pista):
    """WAV de 16 bits y dos canales, que es lo que quiere ffmpeg sin preguntar."""
    import wave

    datos = np.clip(pista, -1.0, 1.0)
    enteros = (datos * 32767).astype("<i2")
    estereo = np.repeat(enteros[:, None], 2, axis=1).reshape(-1)
    with wave.open(str(ruta), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(estereo.tobytes())
    return ruta
