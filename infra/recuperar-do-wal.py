#!/usr/bin/env python3
"""
Recupera os registros apagados de ops.kickoff_registro lendo os bytes crus.

Não há backup nem archive_mode, mas o WAL é escrito sempre: a imagem da tupla de cada
INSERT está no segmento. Este script varre os bytes procurando o começo de uma tupla
desta tabela e decodifica na mão o heap tuple e o jsonb.

Colunas, na ordem física:
  id uuid(16, align c) · tipo text · time text · dados jsonb · autor_email text
  · criado_em timestamptz(int64, align d)

Como texto curto (<127 bytes) usa varlena de 1 byte e varlena de 1 byte NÃO recebe
alinhamento, `tipo` vem imediatamente depois do uuid. Isso dá uma assinatura
procurável: [len][tipo][len][time][varlena jsonb].
"""
import re
import struct
import sys
import json
import uuid as _uuid
from datetime import datetime, timedelta, timezone

TIPOS = [b'dores', b'dados', b'planilhas', b'metricas', b'jornadas', b'automacoes', b'roadmap']
TIMES = [b'comercial', b'financeiro', b'operacoes', b'juridico', b'todos']

JB_FOBJECT = 0x20000000
JB_CMASK = 0x0FFFFFFF
JE_OFFLEN = 0x0FFFFFFF
JE_TYPE = 0x70000000
JE_HAS_OFF = 0x80000000
T_STRING, T_NUMERIC, T_FALSE, T_TRUE, T_NULL, T_CONTAINER = (
    0x00000000, 0x10000000, 0x20000000, 0x30000000, 0x40000000, 0x50000000)

POSTGRES_EPOCH = datetime(2000, 1, 1, tzinfo=timezone.utc)


def varlena_curto(b, i):
    """Texto com cabeçalho de 1 byte. Devolve (valor, próximo índice) ou None."""
    if i >= len(b):
        return None
    h = b[i]
    if h & 0x01 != 1 or h == 0x01:      # bit 0 ligado = 1 byte; 0x01 = TOAST pointer
        return None
    n = (h >> 1) - 1                     # o tamanho inclui o próprio cabeçalho
    if n < 0 or i + 1 + n > len(b):
        return None
    return b[i + 1:i + 1 + n], i + 1 + n


def varlena(b, i):
    """Varlena de 1 ou 4 bytes. Devolve (miolo, próximo índice) ou None."""
    if i >= len(b):
        return None
    h = b[i]
    if h & 0x01 == 1:
        r = varlena_curto(b, i)
        return r
    if h & 0x03 == 0x00:                 # 4 bytes, não comprimido
        if i + 4 > len(b):
            return None
        total = struct.unpack_from('<I', b, i)[0] >> 2
        if total < 4 or i + total > len(b):
            return None
        return b[i + 4:i + total], i + total
    return None                          # comprimido (não ocorre neste tamanho)


def numerico(raw):
    """Decodifica numeric binário do Postgres. Só aparece se algum campo virar número."""
    if len(raw) < 8:
        return None
    ndigits, weight, sign, dscale = struct.unpack_from('>hhHh', raw, 0)
    if len(raw) < 8 + 2 * ndigits:
        return None
    digits = struct.unpack_from('>%dh' % ndigits, raw, 8)
    v = 0
    for d in digits:
        v = v * 10000 + d
    expo = (weight + 1 - ndigits) * 4
    val = v * (10 ** expo) if expo >= 0 else v / (10 ** -expo)
    if sign == 0x4000:
        val = -val
    return round(val, dscale) if dscale else val


def ler_jsonb(raw):
    """jsonb binário → dict. Só objeto no topo, que é o formato que gravamos."""
    if len(raw) < 4:
        return None
    hdr = struct.unpack_from('<I', raw, 0)[0]
    if not (hdr & JB_FOBJECT):
        return None
    n = hdr & JB_CMASK
    if n == 0 or n > 200 or len(raw) < 4 + 8 * n:
        return None
    entradas = struct.unpack_from('<%dI' % (2 * n), raw, 4)
    base = 4 + 4 * 2 * n

    pedacos, corrido = [], 0
    for e in entradas:
        campo = e & JE_OFFLEN
        if e & JE_HAS_OFF:
            ini, fim = corrido, campo      # guarda o offset FINAL
        else:
            ini, fim = corrido, corrido + campo
        if fim < ini or base + fim > len(raw):
            return None
        pedacos.append((e & JE_TYPE, base + ini, base + fim))
        corrido = fim

    def valor(t, a, z):
        if t == T_STRING:
            return raw[a:z].decode('utf-8', 'replace')
        if t == T_TRUE:
            return True
        if t == T_FALSE:
            return False
        if t == T_NULL:
            return None
        if t == T_NUMERIC:
            # numeric vem alinhado a 4 bytes dentro do jsonb
            p = a + ((4 - (a % 4)) % 4)
            return numerico(raw[p:z])
        return '<container>'

    chaves = [raw[a:z].decode('utf-8', 'replace') for _, a, z in pedacos[:n]]
    vals = [valor(t, a, z) for t, a, z in pedacos[n:]]
    if len(chaves) != len(vals):
        return None
    return dict(zip(chaves, vals))


def varrer(caminho):
    b = open(caminho, 'rb').read()
    achados = {}
    for tipo in TIPOS:
        assinatura = bytes([(len(tipo) + 1) << 1 | 1]) + tipo
        for m in re.finditer(re.escape(assinatura), b):
            i = m.start()
            if i < 16:
                continue
            j = i + len(assinatura)
            r = varlena_curto(b, j)
            if not r or r[0] not in TIMES:
                continue
            time_, j = r[0].decode(), r[1]
            r = varlena(b, j)
            if not r:
                continue
            dados = ler_jsonb(r[0])
            if dados is None:
                continue
            j = r[1]
            r = varlena(b, j)
            autor = ''
            if r and b'@' in r[0] and len(r[0]) < 120:
                autor, j = r[0].decode('utf-8', 'replace'), r[1]
            # criado_em: int64 alinhado a 8 bytes
            criado = ''
            k = j + ((8 - (j % 8)) % 8)
            if k + 8 <= len(b):
                us = struct.unpack_from('<q', b, k)[0]
                if 0 < us < 2 * 10**15:
                    criado = (POSTGRES_EPOCH + timedelta(microseconds=us)).isoformat()
            ident = str(_uuid.UUID(bytes=b[i - 16:i]))
            chave = (ident, tipo.decode())
            if chave not in achados:
                achados[chave] = {
                    'uuid': ident, 'tipo': tipo.decode(), 'time': time_,
                    'autor_email': autor, 'criado_em': criado, 'dados': dados,
                }
    return list(achados.values())


if __name__ == '__main__':
    tudo = {}
    for caminho in sys.argv[1:]:
        rs = varrer(caminho)
        print('   %-22s %d registro(s)' % (caminho.split('/')[-1], len(rs)), file=sys.stderr)
        for r in rs:
            tudo.setdefault((r['tipo'], json.dumps(r['dados'], sort_keys=True)), r)
    saida = sorted(tudo.values(), key=lambda r: (r['criado_em'], r['tipo']))
    print(json.dumps(saida, ensure_ascii=False, indent=2))
    print('   ── total distinto: %d' % len(saida), file=sys.stderr)
