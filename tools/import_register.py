#!/usr/bin/env python3
"""Build data/extinguishers.json from the plant's QR register workbook.

Usage:
    python3 tools/import_register.py Fire_Extinguishers_QR.xlsx > data/extinguishers.json

Reads the sheet named "QR REGISTER" (columns: ID NO, Unit, Location, Type, Size).
Only the Python standard library is needed.

The QR labels on the extinguishers hold the same five fields as text:
    UNIT: ...  ID NO: ...  LOCATION: ...  TYPE: ...  SIZE: ...
Some ID numbers appear on more than one extinguisher (and some say "NO TAG"),
so those get a unique app code such as "NO TAG #3". The app tells them apart
by matching all five fields of the scanned label.
"""
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from datetime import date

NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
      'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
SHEET_NAME = 'QR REGISTER'


def clean(s):
    return re.sub(r'\s+', ' ', s or '').strip()


def label_key(unit, tag, location, type_, size):
    """Normalised label text; must match labelKey() in app.js."""
    text = f'UNIT: {unit} ID NO: {tag} LOCATION: {location} TYPE: {type_} SIZE: {size}'
    return clean(text).upper()


def read_sheet(path, name):
    z = zipfile.ZipFile(path)
    strings = []
    if 'xl/sharedStrings.xml' in z.namelist():
        for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si', NS):
            strings.append(''.join(t.text or '' for t in si.iter(f"{{{NS['m']}}}t")))
    wb = ET.fromstring(z.read('xl/workbook.xml'))
    rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
    targets = {r.get('Id'): r.get('Target') for r in rels}
    for s in wb.find('m:sheets', NS):
        if s.get('name').strip().upper() == name:
            target = targets[s.get(f"{{{NS['r']}}}id")].lstrip('/')
            sheet_path = target if target.startswith('xl/') else 'xl/' + target
            break
    else:
        sys.exit(f'Sheet "{name}" not found')

    def col(ref):
        n = 0
        for ch in re.match(r'[A-Z]+', ref).group():
            n = n * 26 + ord(ch) - 64
        return n - 1

    rows = []
    for r in ET.fromstring(z.read(sheet_path)).iter(f"{{{NS['m']}}}row"):
        row = {}
        for c in r.findall('m:c', NS):
            v = c.find('m:v', NS)
            if c.get('t') == 'inlineStr':
                val = ''.join(t.text or '' for t in c.iter(f"{{{NS['m']}}}t"))
            elif v is None:
                continue
            elif c.get('t') == 's':
                val = strings[int(v.text)]
            else:
                val = v.text
            row[col(c.get('r'))] = val
        rows.append(row)
    return rows


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    rows = read_sheet(sys.argv[1], SHEET_NAME)
    header = [clean(rows[0].get(i, '')).upper() for i in range(5)]
    if header != ['ID NO', 'UNIT', 'LOCATION', 'TYPE', 'SIZE']:
        sys.exit(f'Unexpected header in {SHEET_NAME}: {header}')

    items = []
    for row in rows[1:]:
        tag, unit, location, type_, size = (clean(row.get(i, '')) for i in range(5))
        if not (tag or unit or location):
            continue
        items.append({'tag': (tag or 'NO TAG').upper(), 'unit': unit, 'location': location,
                      'type': type_, 'size': size})

    counts = Counter(i['tag'] for i in items)
    seen = defaultdict(int)
    out = []
    for i in items:
        code = i['tag']
        if counts[code] > 1:
            seen[code] += 1
            code = f"{code} #{seen[code]}"
        out.append({
            'code': code,
            'tag': i['tag'],
            'name': '',
            # Tidy "Gas Area 1- 4" -> "Gas Area 1-4" so the unit filter groups them.
            'unit': re.sub(r'(\d)\s*-\s*(\d)', r'\1-\2', i['unit']),
            'location': i['location'],
            'type': i['type'],
            'capacity': i['size'],
            'notes': '',
            'order': len(out) + 1,  # register row order (the walking route)
            'labelKey': label_key(i['unit'], i['tag'], i['location'], i['type'], i['size']),
        })

    json.dump({'version': date.today().isoformat() + f'-{len(out)}', 'source': SHEET_NAME,
               'extinguishers': out}, sys.stdout, ensure_ascii=False, indent=1)
    sys.stdout.write('\n')
    dupes = sum(1 for c in counts.values() if c > 1)
    print(f'{len(out)} extinguishers, {dupes} ID numbers shared by more than one', file=sys.stderr)


if __name__ == '__main__':
    main()
