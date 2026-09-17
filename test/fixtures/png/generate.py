"""Writes the PNG fixtures of this folder. Run once: `python3 generate.py` (needs Pillow, to cross-check).

The encoder below is deliberately not the core's: it picks the filter by row number, so every filter
type is exercised, and splits the data over several IDAT chunks. Pillow then decodes each supported
file and must see exactly the pixels of `pixel()`, which `src/diffusion/png.test.ts` recomputes too.
"""
import struct
import zlib

WIDTH, HEIGHT = 31, 17


def pixel(x, y, channels):
    rgb = ((x * 7 + y * 13) & 255, (x * x + y) & 255, (x ^ (y * 5)) & 255)
    return rgb + (((x * y) & 255),) if channels == 4 else rgb


def paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)


def png(channels, bit_depth=8, color_type=None, interlace=0, idat_parts=3):
    color_type = color_type if color_type is not None else (2 if channels == 3 else 6)
    rows = [[v for x in range(WIDTH) for v in pixel(x, y, channels)] for y in range(HEIGHT)]
    raw = bytearray()
    for y, row in enumerate(rows):
        kind = y % 5
        up = rows[y - 1] if y > 0 else [0] * len(row)
        raw.append(kind)
        for i, value in enumerate(row):
            left = row[i - channels] if i >= channels else 0
            up_left = up[i - channels] if i >= channels else 0
            predicted = [0, left, up[i], (left + up[i]) >> 1, paeth(left, up[i], up_left)][kind]
            raw.append((value - predicted) & 255)
    data = zlib.compress(bytes(raw), 9)
    step = max(1, len(data) // idat_parts)
    parts = [data[i:i + step] for i in range(0, len(data), step)]
    ihdr = struct.pack('>IIBBBBB', WIDTH, HEIGHT, bit_depth, color_type, 0, 0, interlace)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + b''.join(chunk(b'IDAT', p) for p in parts) + chunk(b'IEND', b'')


if __name__ == '__main__':
    import io
    from PIL import Image

    for name, channels in (('rgb-all-filters.png', 3), ('rgba-all-filters.png', 4)):
        data = png(channels)
        decoded = Image.open(io.BytesIO(data))
        decoded.load()
        expected = [pixel(x, y, channels) for y in range(HEIGHT) for x in range(WIDTH)]
        assert list(decoded.getdata()) == expected, name
        open(name, 'wb').write(data)

    # Flavours the core's decoder refuses. It decides on IHDR alone, so for the interlaced one the
    # flag is enough; the others are real files from Pillow.
    open('interlaced.png', 'wb').write(png(3, interlace=1))
    gray = Image.new('L', (8, 8), 128)
    gray.save('gray8.png')
    palette = Image.new('P', (8, 8), 3)
    palette.save('palette.png')
    deep = Image.new('I;16', (8, 8), 40000)
    deep.save('gray16.png')
    print('ok')
