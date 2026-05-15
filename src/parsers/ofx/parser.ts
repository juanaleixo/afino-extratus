/**
 * OFX 1.x SGML / OFX 2.x XML parser.
 *
 * Ported from bradenmacdonald/ofx-js (MIT, ~200 LOC) and extended for the BR reality:
 *   - Banks here ship OFX 1.0.2 SGML with CHARSET:1252 (Windows-1252) and frequently emit
 *     non-self-closed tags ("<TAG>value" without "</TAG>"), which the original ofx-js already
 *     handles via regex normalization.
 *   - Some BR exports include numeric character references like "&#231;" for "ç" inside MEMO,
 *     which the original parser would leave untouched. We decode them here.
 *   - Parser is sync because we run it on a string the caller already decoded; the original's
 *     Promise wrapper added no value once we ditched the implicit fetch.
 *
 * Original copyright:
 *   The MIT License (MIT)
 *   Copyright (c) 2014-2020 various contributors; pure-JS rewrite (c) 2020 Braden MacDonald.
 */

export interface OfxHeader {
  OFXHEADER?: string
  DATA?: string
  VERSION?: string
  SECURITY?: string
  ENCODING?: string
  CHARSET?: string
  COMPRESSION?: string
  OLDFILEUID?: string
  NEWFILEUID?: string
  [key: string]: string | undefined
}

/** Parsed OFX as a JSON-friendly tree. Repeated tags become arrays; leaves become strings. */
export type OfxNode = string | { [tag: string]: OfxNode | OfxNode[] }

export interface OfxDocument {
  header: OfxHeader
  OFX: OfxNode
}

export class OfxParseError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'OfxParseError'
  }
}

/**
 * Parse an OFX 1.x or 2.x payload.
 *
 * The caller is responsible for decoding bytes to a string with the right charset (BR usually
 * needs `windows-1252` / `iso-8859-1` — peek at the header first via `detectOfxCharset()`).
 */
export function parseOfx(text: string): OfxDocument {
  if (!text || typeof text !== 'string') {
    throw new OfxParseError('OFX payload vazio')
  }

  const trimmed = stripBom(text)
  const splitIdx = trimmed.indexOf('<OFX>')
  if (splitIdx < 0) throw new OfxParseError('Tag <OFX> não encontrada — arquivo não é um OFX válido')

  const headerRaw = trimmed.slice(0, splitIdx)
  const body = trimmed.slice(splitIdx)

  const header = parseHeader(headerRaw)

  // OFX 2.x is real XML with `<?xml ?>` declaration.
  // OFX 1.x is SGML with unmatched closing tags. Try strict XML first; fall back to SGML mangling.
  let tree: { OFX: OfxNode }
  try {
    tree = parseXml(body)
  } catch (xmlErr) {
    try {
      tree = parseXml(sgmlToXml(body))
    } catch (sgmlErr) {
      throw new OfxParseError(
        `Falha ao parsear OFX: ${(xmlErr as Error).message} / ${(sgmlErr as Error).message}`,
        sgmlErr,
      )
    }
  }

  return { header, OFX: tree.OFX }
}

/**
 * Peek at the OFX header to discover declared CHARSET. Returns the IANA name suitable for
 * `TextDecoder` (e.g. `'windows-1252'`), or `'utf-8'` when nothing useful is declared.
 *
 * The header is ASCII-safe regardless of the actual body encoding, so probing the first
 * ~1 KB as Latin-1 is fine.
 */
export function detectOfxCharset(buffer: Uint8Array): string {
  const probe = new TextDecoder('latin1').decode(buffer.slice(0, 1024))
  // OFX 1.x header line: `CHARSET:1252`
  const m1 = probe.match(/CHARSET:\s*(\S+)/i)
  if (m1) {
    const v = m1[1]?.trim().toLowerCase()
    if (v === '1252') return 'windows-1252'
    if (v === '8859-1' || v === 'iso-8859-1') return 'iso-8859-1'
    if (v === 'utf-8' || v === 'utf8') return 'utf-8'
    if (v === 'usascii' || v === 'us-ascii') return 'utf-8' // ASCII is a UTF-8 subset
    if (v) return v
  }
  // OFX 2.x XML declaration: `<?xml version="1.0" encoding="ISO-8859-1" ?>`
  const m2 = probe.match(/encoding\s*=\s*["']([^"']+)["']/i)
  if (m2?.[1]) return m2[1].toLowerCase()
  return 'utf-8'
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function parseHeader(raw: string): OfxHeader {
  const out: OfxHeader = {}
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    // OFX 2.x sometimes embeds an XML declaration before the OFX tag.
    if (line.startsWith('<?')) continue
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim().toUpperCase()
    const value = line.slice(colon + 1).trim()
    if (key) out[key] = value
  }
  return out
}

// ---------------------------------------------------------------------------
// SGML → XML (the BR-OFX special sauce)
// ---------------------------------------------------------------------------

/**
 * Turn OFX 1.x SGML into well-formed XML by inferring missing closing tags. The transformations
 * are deliberately conservative — we only touch shapes the OFX spec actually uses.
 *
 *   1. Collapse whitespace between adjacent tags so the regexes can match across line breaks.
 *   2. If a leaf tag is already self-contained (`<X>v</X>`), keep it as-is.
 *   3. Strip dots from tag names ("INV.TRAN" → "INVTRAN") because XML doesn't allow them.
 *      OFX 1.x technically uses dots in some tags; flattening them is the long-standing convention.
 *   4. For any leaf with content but no closing tag (`<TAG>value` ending at the next `<`), inject `</TAG>`.
 *   5. For empty leaf tags right before a closing tag (`<MEMO></STMTTRN>`, common in BR exports),
 *      inject the missing `</TAG>`. We DON'T do the same for `<TAG><OTHER_OPEN>` because that
 *      shape is ambiguous between "empty leaf" and "aggregate with one child".
 */
function sgmlToXml(sgml: string): string {
  return (
    sgml
      .replace(/>\s+</g, '><') // remove whitespace between tags
      .replace(/\s+</g, '<') // remove whitespace before a tag
      .replace(/>\s+/g, '>') // remove whitespace after a tag
      .replace(/<([A-Za-z0-9_]+)>([^<]+)<\/\1>/g, '<$1>$2') // self-closed leaves stay as `<X>v` until rule 4
      .replace(/<([A-Z0-9_]*)\.+([A-Z0-9_]*)>([^<]+)/g, '<$1$2>$3') // drop dots in tag names
      .replace(/<(\w+?)>([^<]+)/g, '<$1>$2</$1>') // close every dangling leaf with content
      // Close empty leaves right before a parent's close tag (`<MEMO></STMTTRN>`). The
      // negative lookahead `(?!<\/\1>)` skips already-balanced `<TAG></TAG>` shapes — without
      // it the global replace would re-match its own output and recurse infinitely.
      .replace(/<(\w+?)>(?!<\/\1>)<\//g, '<$1></$1></')
  )
}

// ---------------------------------------------------------------------------
// Tiny XML parser (strict — refuses invalid trees so the SGML fallback can kick in)
// ---------------------------------------------------------------------------

interface XmlNode {
  name: string
  attributes: Record<string, string>
  children: XmlNode[]
  content: string
}

function parseXml(input: string): { OFX: OfxNode } {
  let xml = input.trim().replace(/<!--[\s\S]*?-->/g, '')
  const ast = document()
  if (!ast || ast.name !== 'OFX') throw new Error('OFX tree não tem raiz <OFX>')
  return { OFX: convertAst(ast) }

  function document(): XmlNode | null {
    // Skip optional `<?xml ... ?>` prolog
    if (peek('<?xml')) {
      const end = xml.indexOf('?>')
      if (end < 0) throw new Error('Declaração XML não fechada')
      xml = xml.slice(end + 2).trim()
    }
    return tag()
  }

  function tag(): XmlNode | null {
    const open = match(/^<([\w\-:.]+)\s*/)
    if (!open) return null
    const node: XmlNode = { name: open[1] as string, attributes: {}, children: [], content: '' }

    while (xml.length > 0 && !peek('>') && !peek('/>')) {
      const attr = attribute()
      if (!attr) break
      node.attributes[attr.name] = attr.value
    }

    if (match(/^\s*\/>\s*/)) return node
    if (!match(/^>\s*/)) throw new Error(`Tag mal-formada: <${node.name}>`)

    node.content = readContent()
    while (true) {
      const child = tag()
      if (!child) break
      node.children.push(child)
    }
    const close = match(/^<\/([\w\-:.]+)>\s*/)
    if (!close || close[1] !== node.name) {
      throw new Error(`Falta fechamento para <${node.name}>`)
    }
    return node
  }

  function attribute(): { name: string; value: string } | null {
    const m = match(/^([\w:-]+)\s*=\s*("[^"]*"|'[^']*'|\w+)\s*/)
    if (!m) return null
    const raw = (m[2] as string).replace(/^['"]|['"]$/g, '')
    return { name: m[1] as string, value: decodeEntities(raw) }
  }

  function readContent(): string {
    const m = match(/^([^<]*)/)
    return m ? decodeEntities(m[1] as string) : ''
  }

  function match(re: RegExp): RegExpMatchArray | null {
    const m = xml.match(re)
    if (!m) return null
    xml = xml.slice(m[0].length)
    return m
  }

  function peek(s: string): boolean {
    return xml.startsWith(s)
  }
}

/**
 * Decode the entity flavors we actually see in OFX 1.x BR exports:
 *   - the XML core five (`&lt; &gt; &amp; &quot; &apos;`)
 *   - HTML named entities common in PT-BR (`&nbsp; &aacute; &eacute;` ...)
 *   - numeric character references decimal (`&#231;`) and hex (`&#xE7;`)
 *
 * Anything we don't recognize stays verbatim — the goal isn't a full HTML decoder.
 */
function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => safeFromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => safeFromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => HTML_ENTITIES[name as keyof typeof HTML_ENTITIES] ?? m)
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  // XML core
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
  // HTML common (subset that actually appears in BR bank OFX MEMOs)
  nbsp: ' ',
  iexcl: '¡',
  cent: '¢',
  pound: '£',
  yen: '¥',
  copy: '©',
  reg: '®',
  deg: '°',
  plusmn: '±',
  sup2: '²',
  sup3: '³',
  micro: 'µ',
  para: '¶',
  middot: '·',
  agrave: 'à',
  aacute: 'á',
  acirc: 'â',
  atilde: 'ã',
  auml: 'ä',
  ccedil: 'ç',
  egrave: 'è',
  eacute: 'é',
  ecirc: 'ê',
  euml: 'ë',
  iacute: 'í',
  icirc: 'î',
  ntilde: 'ñ',
  oacute: 'ó',
  ocirc: 'ô',
  otilde: 'õ',
  ouml: 'ö',
  uacute: 'ú',
  ucirc: 'û',
  uuml: 'ü',
  Aacute: 'Á',
  Acirc: 'Â',
  Atilde: 'Ã',
  Ccedil: 'Ç',
  Eacute: 'É',
  Iacute: 'Í',
  Oacute: 'Ó',
  Otilde: 'Õ',
  Uacute: 'Ú',
}

// ---------------------------------------------------------------------------
// AST → JSON tree (xml2js with explicitArray: false)
// ---------------------------------------------------------------------------

function convertAst(node: XmlNode): OfxNode {
  if (node.children.length === 0) {
    return node.content || ''
  }
  const out: { [tag: string]: OfxNode | OfxNode[] } = {}
  for (const child of node.children) {
    const value = convertAst(child)
    const existing = out[child.name]
    if (existing === undefined) {
      out[child.name] = value
    } else if (Array.isArray(existing)) {
      existing.push(value)
    } else {
      out[child.name] = [existing, value]
    }
  }
  return out
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}
