#!/usr/bin/env python3
"""Generate PWA icons (dark bg, teal step-sequencer motif) with stdlib only."""
import struct, zlib

BG = (14, 17, 22, 255)
TEAL = (61, 214, 195, 255)
AMBER = (224, 164, 88, 255)
DIM = (42, 52, 66, 255)

# 4x4 sequencer motif: which cells are "notes"
NOTES = {(0, 2): TEAL, (1, 0): TEAL, (2, 3): AMBER, (3, 1): TEAL}

def make(size, path):
    px = [[BG] * size for _ in range(size)]
    pad = size // 8
    cell = (size - 2 * pad) // 4
    gap = max(2, size // 48)
    for gy in range(4):
        for gx in range(4):
            color = NOTES.get((gx, gy), DIM)
            x0 = pad + gx * cell + gap
            y0 = pad + gy * cell + gap
            for y in range(y0, y0 + cell - 2 * gap):
                for x in range(x0, x0 + cell - 2 * gap):
                    px[y][x] = color
    raw = b''.join(b'\x00' + b''.join(bytes(c) for c in row) for row in px)
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data))
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    open(path, 'wb').write(png)
    print(path, len(png), 'bytes')

make(192, 'icon-192.png')
make(512, 'icon-512.png')
