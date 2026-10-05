#!/usr/bin/env python3
"""Print a PNG/JPEG/GIF inline in Harbor's terminal using the iTerm image protocol."""
import argparse
import base64
from pathlib import Path
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('image', type=Path)
parser.add_argument('--width', type=int, default=480, help='Display width in pixels (64–1600).')
args = parser.parse_args()
if not 64 <= args.width <= 1600:
    parser.error('--width must be between 64 and 1600.')
try:
    with args.image.open('rb') as source:
        data = source.read(2 * 1024 * 1024 + 1)
except OSError as error:
    parser.error(str(error))
if len(data) > 2 * 1024 * 1024:
    parser.error('Inline images are limited to 2MB. Open larger images in Harbor preview.')
if not (data.startswith(b'\x89PNG\r\n\x1a\n') or data.startswith(b'\xff\xd8\xff') or data[:6] in (b'GIF87a', b'GIF89a')):
    parser.error('Use a PNG, JPEG or GIF image.')
name = base64.b64encode(args.image.name.encode('utf-8')).decode('ascii')
payload = base64.b64encode(data).decode('ascii')
sys.stdout.write(f'\033]1337;File=name={name};size={len(data)};width={args.width}px;preserveAspectRatio=1;inline=1:{payload}\a\n')
sys.stdout.flush()
