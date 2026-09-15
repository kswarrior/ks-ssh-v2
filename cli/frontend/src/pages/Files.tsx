import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

type FileEntry = {
  name: string
  path: string
  is_dir: boolean
  size: number
  modified: number | null
  mode?: number | null
  is_symlink?: boolean
}

type ListResponse = {
  home: string
  path: string
  parent: string | null
  entries: FileEntry[]
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u += 1
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`
}

function formatDate(secs: number | null): string {
  if (secs == null) return '—'
  const d = new Date(secs * 1000)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
}

function downloadUrl(path: string): string {
  return `/api/files/download?path=${encodeURIComponent(path)}`
}

function previewUrl(path: string): string {
  return `/api/files/download?path=${encodeURIComponent(path)}&inline=1`
}

function zipUrl(path: string): string {
  return `/api/files/download-zip?path=${encodeURIComponent(path)}`
}

function isZipName(name: string): boolean {
  return extOf(name) === 'zip'
}

type StatResponse = {
  path: string
  name: string
  is_dir: boolean
  size: number
  modified: number | null
  uid?: number
  gid?: number
  mode: number
  mode_octal: string
  readonly: boolean
}

type SearchHit = {
  name: string
  path: string
  is_dir: boolean
  size: number
  modified: number | null
}

type SearchResponse = {
  root: string
  query: string
  truncated: boolean
  count: number
  entries: SearchHit[]
}

type Crumb = { name: string; path: string }

function buildCrumbs(home: string, path: string): Crumb[] {
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  const h = norm(home)
  const p = norm(path)
  const root: Crumb = { name: '~', path: home }
  if (p === h) return [root]
  if (!p.startsWith(h + '/')) return [{ name: path, path }]
  const rel = p.slice(h.length + 1).split('/').filter(Boolean)
  const crumbs: Crumb[] = [root]
  rel.forEach((seg, i) => {
    // Rebuild with the original home prefix so `load()` gets a valid abs path.
    const abs = `${h}/${rel.slice(0, i + 1).join('/')}`
    crumbs.push({ name: seg, path: i === rel.length - 1 ? path : abs })
  })
  return crumbs
}

type ContentKind = 'text' | 'binary' | 'too-large'

type FileTypeFilter = 'all' | 'dirs' | 'files'

type SortKey = 'name' | 'size' | 'modified'
type SortDir = 'asc' | 'desc'
type ViewMode = 'grid' | 'list'
type TransferMode = 'copy' | 'move'
type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | null

function formatMode(mode: number | null | undefined): string {
  if (mode == null) return '—'
  const chars = ['r', 'w', 'x']
  let out = ''
  for (let i = 8; i >= 0; i--) {
    out += mode & (1 << i) ? chars[(8 - i) % 3] : '-'
  }
  return `${out} (${mode.toString(8).padStart(3, '0')})`
}

/** Media preview kind for a file name, or null when not previewable. */
function previewKindOf(name: string): PreviewKind {
  const base = name.split('/').pop() ?? name
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
  if (!ext) return null
  if (ext === 'pdf') return 'pdf'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'].includes(ext)) return 'image'
  if (['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(ext)) return 'video'
  if (['mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac'].includes(ext)) return 'audio'
  return null
}

/** Suggest `name copy.ext`, `name copy 2.ext`, … that doesn't collide (exact match). */
function suggestCopyName(name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let candidate = `${stem} copy${ext}`
  for (let i = 2; taken.has(candidate); i++) {
    candidate = `${stem} copy ${i}${ext}`
  }
  return candidate
}

/* ---------- File categories: a distinct icon + color per kind ---------- */

type FileCat =
  | 'dir'
  | 'image'
  | 'video'
  | 'audio'
  | 'archive'
  | 'pdf'
  | 'doc'
  | 'data'
  | 'code'
  | 'script'
  | 'text'

function extOf(name: string): string {
  const base = name.split('/').pop() ?? name
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'tif', 'tiff', 'heic', 'heif'])
const VIDEO_EXT = new Set(['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', '3gp', 'flv', 'wmv', 'mpg', 'mpeg'])
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'mid', 'midi'])
const ARCHIVE_EXT = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', 'txz', 'rar', '7z', 'zst', 'deb', 'rpm', 'jar', 'war'])
const DOC_EXT = new Set(['doc', 'docx', 'odt', 'rtf', 'pages', 'xls', 'xlsx', 'ods', 'numbers', 'ppt', 'pptx', 'odp', 'key'])
const DATA_EXT = new Set(['json', 'jsonc', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'csv', 'tsv', 'db', 'sqlite', 'sqlite3', 'sql', 'xml', 'plist'])
const CODE_EXT = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte', 'astro', 'html', 'htm', 'xhtml', 'css', 'scss', 'less', 'sass', 'py', 'pyw', 'rb', 'php', 'java', 'kt', 'kts', 'swift', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'hh', 'cc', 'cxx', 'cs', 'scala', 'pl', 'pm', 'lua', 'r', 'jl', 'dart', 'elm', 'ex', 'exs', 'hs', 'ml', 'groovy', 'coffee'])
const SCRIPT_EXT = new Set(['sh', 'bash', 'zsh', 'fish', 'ksh', 'ps1', 'bat', 'cmd'])

function fileCat(name: string, isDir: boolean): FileCat {
  if (isDir) return 'dir'
  const ext = extOf(name)
  if (!ext) return 'text'
  if (ext === 'pdf') return 'pdf'
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  if (ARCHIVE_EXT.has(ext)) return 'archive'
  if (DOC_EXT.has(ext)) return 'doc'
  if (SCRIPT_EXT.has(ext)) return 'script'
  if (CODE_EXT.has(ext)) return 'code'
  if (DATA_EXT.has(ext)) return 'data'
  return 'text'
}

function CatSvg({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

function FileCatIcon({ cat }: { cat: FileCat }) {
  switch (cat) {
    case 'dir':
      return (
        <CatSvg>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </CatSvg>
      )
    case 'image':
      return (
        <CatSvg>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="9" cy="9" r="2" />
          <path d="m21 15-5-5L5 21" />
        </CatSvg>
      )
    case 'video':
      return (
        <CatSvg>
          <path d="m22 8-6 4 6 4V8Z" />
          <rect x="2" y="6" width="14" height="12" rx="2" />
        </CatSvg>
      )
    case 'audio':
      return (
        <CatSvg>
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </CatSvg>
      )
    case 'archive':
      return (
        <CatSvg>
          <rect x="2" y="3" width="20" height="5" rx="1" />
          <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
          <path d="M10 12h4" />
        </CatSvg>
      )
    case 'pdf':
      return (
        <CatSvg>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M9 13h6M9 17h6" />
        </CatSvg>
      )
    case 'doc':
      return (
        <CatSvg>
          <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
        </CatSvg>
      )
    case 'data':
      return (
        <CatSvg>
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M3 5v14a9 3 0 0 0 18 0V5" />
          <path d="M3 12a9 3 0 0 0 18 0" />
        </CatSvg>
      )
    case 'code':
      return (
        <CatSvg>
          <path d="m16 18 6-6-6-6" />
          <path d="m8 6-6 6 6 6" />
        </CatSvg>
      )
    case 'script':
      return (
        <CatSvg>
          <path d="m4 17 6-6-6-6" />
          <path d="M12 19h8" />
        </CatSvg>
      )
    case 'text':
    default:
      return (
        <CatSvg>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </CatSvg>
      )
  }
}

/* ---------- Language detection + lightweight syntax highlighting ---------- */

type LangId =
  | 'ts' | 'js' | 'json' | 'html' | 'css' | 'md' | 'py' | 'sh'
  | 'yaml' | 'toml' | 'ini' | 'sql' | 'rs' | 'go' | 'clang' | 'plain'

function detectLang(name: string): { id: LangId; label: string } {
  const ext = extOf(name)
  switch (ext) {
    case 'ts': case 'mts': case 'cts': return { id: 'ts', label: 'TypeScript' }
    case 'tsx': return { id: 'ts', label: 'TSX' }
    case 'js': case 'mjs': case 'cjs': return { id: 'js', label: 'JavaScript' }
    case 'jsx': return { id: 'js', label: 'JSX' }
    case 'json': case 'jsonc': return { id: 'json', label: 'JSON' }
    case 'html': case 'htm': case 'xhtml': case 'vue': case 'svelte': case 'astro':
      return { id: 'html', label: 'HTML' }
    case 'xml': case 'xsl': case 'xsd': case 'plist': case 'svg':
      return { id: 'html', label: 'XML' }
    case 'css': case 'scss': case 'less': case 'sass': return { id: 'css', label: 'CSS' }
    case 'md': case 'markdown': case 'mdown': return { id: 'md', label: 'Markdown' }
    case 'py': case 'pyw': return { id: 'py', label: 'Python' }
    case 'sh': case 'bash': case 'zsh': case 'fish': case 'ksh': return { id: 'sh', label: 'Shell' }
    case 'yml': case 'yaml': return { id: 'yaml', label: 'YAML' }
    case 'toml': return { id: 'toml', label: 'TOML' }
    case 'ini': case 'cfg': case 'conf': case 'env': case 'properties':
      return { id: 'ini', label: 'Config' }
    case 'sql': return { id: 'sql', label: 'SQL' }
    case 'rs': return { id: 'rs', label: 'Rust' }
    case 'go': return { id: 'go', label: 'Go' }
    case 'c': case 'h': return { id: 'clang', label: 'C' }
    case 'cpp': case 'hpp': case 'hh': case 'cc': case 'cxx': return { id: 'clang', label: 'C++' }
    case 'java': return { id: 'clang', label: 'Java' }
    case 'cs': return { id: 'clang', label: 'C#' }
    case 'php': return { id: 'clang', label: 'PHP' }
    case 'swift': return { id: 'clang', label: 'Swift' }
    case 'kt': case 'kts': return { id: 'clang', label: 'Kotlin' }
    case 'rb': case 'pl': case 'lua': case 'scala': case 'dart': return { id: 'clang', label: 'Code' }
    default: {
      const base = (name.split('/').pop() ?? '').toLowerCase()
      if (
        base === 'dockerfile' || base === 'makefile' || base === 'gnumakefile' ||
        ext === 'bat' || ext === 'cmd' || ext === 'ps1'
      ) {
        return { id: 'sh', label: 'Shell' }
      }
      return { id: 'plain', label: 'Text' }
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Walk a named-group master pattern, escaping plain text and wrapping tokens. */
function paint(text: string, re: RegExp): string {
  re.lastIndex = 0
  let out = ''
  let last = 0
  for (;;) {
    const m = re.exec(text)
    if (!m) break
    const tok = m[0]
    const start = m.index
    if (tok === '') {
      re.lastIndex = start + 1
      continue
    }
    out += escapeHtml(text.slice(last, start))
    const g = m.groups ?? {}
    const cls =
      g.com ? 'tok-com'
      : g.str ? 'tok-str'
      : g.num ? 'tok-num'
      : g.kw ? 'tok-kw'
      : g.fn ? 'tok-fn'
      : g.vari ? 'tok-var'
      : g.attr ? 'tok-attr'
      : g.tag ? 'tok-tag'
      : g.sec ? 'tok-sec'
      : g.pun ? 'tok-pun'
      : ''
    out += cls ? `<span class="${cls}">${escapeHtml(tok)}</span>` : escapeHtml(tok)
    last = start + tok.length
  }
  return out + escapeHtml(text.slice(last))
}

const JS_KW = 'async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|from|function|get|if|import|in|instanceof|let|new|of|return|set|static|super|switch|this|throw|try|typeof|var|void|while|with|yield|as'
const TS_KW = `${JS_KW}|type|interface|enum|namespace|readonly|private|protected|public|abstract|override|implements|keyof|infer|asserts|never|any|unknown|string|number|boolean|bigint|symbol|object|declare|satisfies`
const PY_KW = 'False|None|True|and|as|assert|async|await|break|case|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|match|nonlocal|not|or|pass|raise|return|try|while|with|yield'
const RS_KW = 'as|async|await|break|const|continue|crate|dyn|else|enum|extern|false|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|true|type|union|unsafe|use|where|while|abstract|become|box|do|final|macro|override|priv|typeof|unsized|virtual|yield|try'
const GO_KW = 'break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var|nil|true|false|iota|append|cap|close|complex|copy|delete|imag|len|make|new|panic|print|println|real|recover'
const CLANG_KW = 'auto|break|case|catch|char|class|const|constexpr|continue|default|delete|do|double|else|enum|explicit|export|extern|false|final|finally|float|for|friend|goto|if|inline|int|long|namespace|new|nullptr|private|protected|public|return|short|signed|sizeof|static|struct|switch|template|this|throw|true|try|typedef|typename|union|unsigned|using|virtual|void|volatile|while|extends|implements|import|instanceof|package|super|synchronized|throws|function|var|let|async|await|yield|val|fun|object|data|sealed|internal|is|override|open|abstract|self|nil|guard|defer|echo|print|foreach|require|include|operator|record|mutating|some|where'
const SH_KW = 'if|then|else|elif|fi|for|while|until|in|do|done|case|esac|function|select|echo|cd|ls|export|source|alias|exit|return|set|local|readonly|declare|typeset|test|true|false|time|exec|trap|shift|continue|break|command|builtin|eval|pwd|pushd|popd|history|jobs|kill|wait|printf|read|mapfile|shopt|complete'
const SQL_KW = 'select|from|where|insert|into|values|update|set|delete|create|table|alter|add|drop|join|left|right|full|inner|outer|cross|on|group|by|order|having|limit|offset|fetch|distinct|union|all|except|intersect|as|and|or|not|null|is|in|like|ilike|between|exists|case|when|then|else|end|primary|key|foreign|references|unique|check|constraint|index|view|trigger|procedure|begin|commit|rollback|transaction|grant|revoke|count|sum|avg|min|max|coalesce|cast|over|partition|rows|range|unbounded|preceding|following|current|row|only|with|recursive'

function clPattern(kw: string): RegExp {
  return new RegExp(
    '(?<com>//[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|$))' +
      "|(?<str>'(?:[^'\\\\\\n]|\\\\.)*(?:'|$)|\"(?:[^\"\\\\\\n]|\\\\.)*(?:\"|$)|`(?:[^`\\\\]|\\\\.)*(?:`|$))" +
      '|(?<num>\\b0[xX][\\dA-Fa-f_]+\\b|\\b\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d[\\d_]*)?[nN]?\\b)' +
      `|(?<kw>\\b(?:${kw})\\b)` +
      '|(?<fn>\\b[A-Za-z_$][\\w$]*(?=\\s*\\())',
    'g',
  )
}

function pyPattern(): RegExp {
  return new RegExp(
    '(?<com>#[^\\n]*)' +
      "|(?<str>[bBfFrR]{0,2}'''(?:[^\\\\]|\\\\.)*?(?:'''|$)|[bBfFrR]{0,2}\"\"\"(?:[^\\\\]|\\\\.)*?(?:\"\"\"|$)|[bBfFrR]?(?:'(?:[^'\\\\\\n]|\\\\.)*(?:'|$)|\"(?:[^\"\\\\\\n]|\\\\.)*(?:\"|$)))" +
      '|(?<num>\\b0[xX][\\dA-Fa-f_]+\\b|\\b\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d[\\d_]*)?[jJ]?\\b)' +
      '|(?<vari>@[A-Za-z_]\\w*)' +
      `|(?<kw>\\b(?:${PY_KW})\\b)` +
      '|(?<fn>\\b[A-Za-z_]\\w*(?=\\s*\\())',
    'g',
  )
}

function shPattern(): RegExp {
  return new RegExp(
    '(?<com>#[^\\n]*)' +
      "|(?<str>'[^']*(?:'|$)|\"(?:[^\"\\\\]|\\\\.)*(?:\"|$)|\\$'(?:[^'\\\\]|\\\\.)*(?:'|$))" +
      '|(?<vari>\\$(?:[\\w#?*$!@-]+|\\{[^}\\n]*\\}?|\\([^)\\n]*\\)?))' +
      '|(?<num>\\b\\d+\\b)' +
      `|(?<kw>\\b(?:${SH_KW})\\b)`,
    'g',
  )
}

function jsonPattern(): RegExp {
  return new RegExp(
    '(?<com>//[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|$))' +
      '|(?<attr>"(?:[^"\\\\\\n]|\\\\.)*"(?=\\s*:))' +
      "|(?<str>\"(?:[^\"\\\\\\n]|\\\\.)*(?:\"|$))" +
      '|(?<num>-?\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)' +
      '|(?<kw>\\b(?:true|false|null)\\b)',
    'g',
  )
}

function yamlPattern(): RegExp {
  return new RegExp(
    '(?<com>#[^\\n]*)' +
      "|(?<str>\"(?:[^\"\\\\\\n]|\\\\.)*(?:\"|$)|'(?:[^'\\n]|'')*(?:'|$))" +
      '|(?<num>(?<![\\w/.:-])\\d+(?:\\.\\d+)?\\b)' +
      '|(?<kw>\\b(?:true|false|null|yes|no|on|off)\\b|---|\\.\\.\\.)' +
      '|(?<attr>[\\w./-]+(?=\\s*:))',
    'gm',
  )
}

function tomlPattern(): RegExp {
  return new RegExp(
    '(?<com>[#;][^\\n]*)' +
      "|(?<str>\"(?:[^\"\\\\\\n]|\\\\.)*(?:\"|$)|'(?:[^'\\n])*(?:'|$))" +
      '|(?<num>\\b\\d+(?:\\.\\d+)?\\b)' +
      '|(?<kw>\\b(?:true|false)\\b)' +
      '|(?<sec>^\\s*\\[[^\\]\\n]*\\]?)' +
      '|(?<attr>[\\w.-]+(?=\\s*=))',
    'gm',
  )
}

function cssPattern(): RegExp {
  return new RegExp(
    '(?<com>/\\*[\\s\\S]*?(?:\\*/|$))' +
      "|(?<str>\"(?:[^\"\\\\\\n]|\\\\.)*(?:\"|$)|'(?:[^'\\\\\\n]|\\\\.)*(?:'|$))" +
      '|(?<num>#[\\dA-Fa-f]{3,8}\\b|\\b\\d+(?:\\.\\d+)?(?:px|r?em|%|s|ms|deg|fr|ch|ex|lh|rlh|vw|vh|vmin|vmax|svw|svh|dvw|dvh|cqw|cqh|pt|pc|in|cm|mm|q)?\\b)' +
      '|(?<kw>@[\\w-]+|!important\\b)' +
      '|(?<attr>[a-zA-Z-][\\w-]*(?=\\s*:))',
    'g',
  )
}

function mdPattern(): RegExp {
  return new RegExp(
    '(?<tag>^#{1,6}\\s+[^\\n]*|^\\s*```[^\\n]*|^\\s*\\|?(?::?-{3,}:?[ \\t]*\\|?)+[ \\t]*$|^>[^\\n]*|^\\s*[-*_]{3,}[ \\t]*$)' +
      "|(?<str>`[^`\\n]+`|\\*\\*[^*\\n]+\\*\\*|\\*[^*\\n]+\\*|__[^_\\n]+__|_[^_\\n]+_|\\[[^\\]\\n]*\\]\\([^)\\n]*\\)|\\[[^\\]\\n]*\\]\\[[^\\]\\n]*\\])",
    'gm',
  )
}

function sqlPattern(): RegExp {
  return new RegExp(
    '(?<com>--[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|$))' +
      "|(?<str>'(?:[^']|'')*'|\"(?:[^\"]*)\"?|`(?:[^`\\\\]|\\\\.)*`?)" +
      '|(?<num>\\b\\d+(?:\\.\\d+)?\\b)' +
      `|(?<kw>\\b(?:${SQL_KW})\\b)`,
    'gi',
  )
}

function highlightTag(tok: string): string {
  const open = /^(<\/?)([A-Za-z][\w:.-]*)/.exec(tok)
  if (!open) return escapeHtml(tok)
  let out = `<span class="tok-pun">${escapeHtml(open[1])}</span><span class="tok-tag">${escapeHtml(open[2])}</span>`
  const rest = tok.slice(open[0].length)
  const re = /[\w:.-]+(?=\s*=\s*)|"(?:[^"\n]*)"?|'(?:[^'\n]*)'?/g
  let last = 0
  for (;;) {
    const m = re.exec(rest)
    if (!m) break
    const a = m[0]
    if (a === '') {
      re.lastIndex = m.index + 1
      continue
    }
    out += escapeHtml(rest.slice(last, m.index))
    const cls = a[0] === '"' || a[0] === "'" ? 'tok-str' : 'tok-attr'
    out += `<span class="${cls}">${escapeHtml(a)}</span>`
    last = m.index + a.length
  }
  return out + escapeHtml(rest.slice(last))
}

function highlightMarkup(text: string): string {
  const re = /<!--[\s\S]*?(?:-->|$)|<\/?[A-Za-z][\w:.-]*(?:\s+[^\s<>/="']+(?:\s*=\s*(?:"[^"\n]*"?|'[^'\n]*'?|[^\s<>"'`]+))?)*\s*\/?>/g
  let out = ''
  let last = 0
  for (;;) {
    const m = re.exec(text)
    if (!m) break
    const tok = m[0]
    if (tok === '') {
      re.lastIndex = m.index + 1
      continue
    }
    out += escapeHtml(text.slice(last, m.index))
    out += tok.startsWith('<!--') ? `<span class="tok-com">${escapeHtml(tok)}</span>` : highlightTag(tok)
    last = m.index + tok.length
  }
  return out + escapeHtml(text.slice(last))
}

function highlightCode(text: string, lang: LangId): string {
  switch (lang) {
    case 'ts': return paint(text, clPattern(TS_KW))
    case 'js': return paint(text, clPattern(JS_KW))
    case 'json': return paint(text, jsonPattern())
    case 'html': return highlightMarkup(text)
    case 'css': return paint(text, cssPattern())
    case 'md': return paint(text, mdPattern())
    case 'py': return paint(text, pyPattern())
    case 'sh': return paint(text, shPattern())
    case 'yaml': return paint(text, yamlPattern())
    case 'toml':
    case 'ini': return paint(text, tomlPattern())
    case 'sql': return paint(text, sqlPattern())
    case 'rs': return paint(text, clPattern(RS_KW))
    case 'go': return paint(text, clPattern(GO_KW))
    case 'clang': return paint(text, clPattern(CLANG_KW))
    case 'plain': return escapeHtml(text)
  }
}
type ContentResponse = {
  path: string
  name: string
  size: number
  modified: number | null
  kind: ContentKind
  content?: string
}

export default function FilesPage() {
  const [data, setData] = useState<ListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(true)
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<FileTypeFilter>('all')
  const [bulkBusy, setBulkBusy] = useState(false)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  // Deep (recursive) search results; null = browse mode.
  const [deep, setDeep] = useState<{ query: string; results: SearchHit[]; truncated: boolean; loading: boolean; error: string | null } | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [selected, setSelected] = useState<string[]>([])
  const [view, setView] = useState<ViewMode>('grid')
  const [previewing, setPreviewing] = useState<FileEntry | null>(null)
  const [propsEntry, setPropsEntry] = useState<FileEntry | null>(null)
  const [propsStat, setPropsStat] = useState<StatResponse | null>(null)
  const [propsStatLoading, setPropsStatLoading] = useState(false)
  const [propsMode, setPropsMode] = useState('')
  const [propsBusy, setPropsBusy] = useState(false)
  const [propsError, setPropsError] = useState<string | null>(null)
  const [transfer, setTransfer] = useState<{ entry: FileEntry; mode: TransferMode } | null>(null)
  const [transferDir, setTransferDir] = useState('')
  const [transferName, setTransferName] = useState('')
  const [transferBusy, setTransferBusy] = useState(false)
  const [transferError, setTransferError] = useState<string | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const dragDepth = useRef(0)
  const [menuOpen, setMenuOpen] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  // Editor state.
  const [editing, setEditing] = useState<FileEntry | null>(null)
  const [editorKind, setEditorKind] = useState<ContentKind | null>(null)
  const [editorText, setEditorText] = useState('')
  const [editorSaved, setEditorSaved] = useState('')
  const [editorLoading, setEditorLoading] = useState(false)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [editorSaving, setEditorSaving] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const editorDirty = editorText !== editorSaved
  const editLang = detectLang(editing?.name ?? '')
  const editCat: FileCat = fileCat(editing?.name ?? '', false)
  const highlighted = useMemo(
    () => highlightCode(editorText, editLang.id),
    [editorText, editLang.id],
  )
  const gutterText = useMemo(() => {
    const n = editorText.split('\n').length
    return Array.from({ length: n }, (_, i) => String(i + 1)).join('\n')
  }, [editorText])

  const syncCodeScroll = () => {
    const ta = codeRef.current
    if (!ta) return
    if (hlRef.current) {
      hlRef.current.scrollTop = ta.scrollTop
      hlRef.current.scrollLeft = ta.scrollLeft
    }
    if (gutRef.current) gutRef.current.scrollTop = ta.scrollTop
  }
  // Create dialog state.
  const [creating, setCreating] = useState<null | 'file' | 'folder'>(null)
  const [createName, setCreateName] = useState('')
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const createInputRef = useRef<HTMLInputElement | null>(null)
  // Upload dialog state.
  const [uploading, setUploading] = useState<null | 'local' | 'url'>(null)
  const [uploadFiles, setUploadFiles] = useState<File[]>([])
  const [uploadUrl, setUploadUrl] = useState('')
  const [uploadName, setUploadName] = useState('')
  const [uploadBusy, setUploadBusy] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadDone, setUploadDone] = useState<string[]>([])
  const [uploadProgress, setUploadProgress] = useState('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // Code editor overlay refs (transparent textarea over highlighted <pre>).
  const codeRef = useRef<HTMLTextAreaElement | null>(null)
  const hlRef = useRef<HTMLPreElement | null>(null)
  const gutRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async (path?: string) => {
    setLoading(true)
    setError(null)
    try {
      const url = path
        ? `/api/files?path=${encodeURIComponent(path)}`
        : '/api/files'
      const res = await fetch(url)
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text || `request failed (${res.status})`)
      }
      const json = (await res.json()) as ListResponse
      setData(json)
      setMenuOpen(null)
      setRenaming(null)
      setConfirmDelete(null)
      setActionError(null)
      setSelected([])
      setConfirmBulkDelete(false)
      setDeep(null)
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Cannot reach the host. Files works on the local UI (http://127.0.0.1:8080) — not over the relay view.',
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Close the ⋮ menu on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return
    const onDocClick = () => setMenuOpen(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(null)
        setConfirmDelete(null)
      }
    }
    document.addEventListener('click', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  // Focus the rename field when it opens.
  useEffect(() => {
    if (renaming) {
      const t = setTimeout(() => renameInputRef.current?.select(), 30)
      return () => clearTimeout(t)
    }
  }, [renaming])

  // Escape closes the editor (twice when there are unsaved changes).
  // Body scroll is locked so the editor feels like a real full page.
  // Split in two so typing (editorText changes) doesn't re-subscribe the
  // listener or flicker body overflow on every keystroke.
  useEffect(() => {
    if (!editing) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [editing])

  useEffect(() => {
    if (!editing) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Same two-step logic as closeEditor(), inlined so this effect only
      // re-subscribes when the dirty/discard flags change (not per keystroke).
      if (editorDirty && !confirmDiscard) {
        setConfirmDiscard(true)
      } else {
        setEditing(null)
        setEditorKind(null)
        setEditorText('')
        setEditorSaved('')
        setEditorError(null)
        setConfirmDiscard(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
    }
  }, [editing, editorDirty, confirmDiscard])

  // Reset code scroll when another file is opened in the editor.
  useEffect(() => {
    if (!editing) return
    codeRef.current?.scrollTo(0, 0)
    if (hlRef.current) {
      hlRef.current.scrollTop = 0
      hlRef.current.scrollLeft = 0
    }
    if (gutRef.current) gutRef.current.scrollTop = 0
  }, [editing])

  // Focus the create input + Escape closes the create dialog.
  useEffect(() => {
    if (!creating) return
    const t = setTimeout(() => createInputRef.current?.select(), 30)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !createBusy) setCreating(null)
    }
    document.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(t)
      document.removeEventListener('keydown', onKey)
    }
  }, [creating, createBusy])

  // Escape closes the upload dialog (when idle).
  useEffect(() => {
    if (!uploading) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !uploadBusy) setUploading(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [uploading, uploadBusy])

  // Escape closes preview / properties / transfer dialogs (when idle).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (previewing) setPreviewing(null)
      else if (propsEntry && !propsBusy) {
        setPropsEntry(null)
        setPropsStat(null)
        setPropsError(null)
      } else if (transfer && !transferBusy) {
        setTransfer(null)
        setTransferError(null)
      }
    }
    if (!previewing && !propsEntry && !transfer) return
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [previewing, propsEntry, propsBusy, transfer, transferBusy])

  const base = useMemo(
    () =>
      (data?.entries ?? []).filter(
        (e) => showHidden || !e.name.startsWith('.'),
      ),
    [data, showHidden],
  )
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const out = base.filter((e) => {
      if (typeFilter === 'dirs' && !e.is_dir) return false
      if (typeFilter === 'files' && e.is_dir) return false
      if (!q) return true
      return e.name.toLowerCase().includes(q)
    })
    // Folders stay grouped first (backend parity), then the chosen sort.
    const dir = sortDir === 'asc' ? 1 : -1
    out.sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1
      switch (sortKey) {
        case 'size':
          return (a.size - b.size) * dir
        case 'modified':
          return ((a.modified ?? -1) - (b.modified ?? -1)) * dir
        case 'name':
        default:
          return a.name.toLowerCase().localeCompare(b.name.toLowerCase()) * dir
      }
    })
    return out
  }, [base, typeFilter, query, sortKey, sortDir])
  const filtering = query.trim() !== '' || typeFilter !== 'all'
  const dirCount = base.filter((e) => e.is_dir).length
  const fileCount = base.length - dirCount

  const startRename = (e: FileEntry) => {
    setMenuOpen(null)
    setConfirmDelete(null)
    setActionError(null)
    setRenaming(e.path)
    setNewName(e.name)
  }

  const submitRename = async (e: FileEntry) => {
    const name = newName.trim()
    if (!name || name === e.name) {
      setRenaming(null)
      return
    }
    if (name === '.' || name === '..') {
      setActionError('Name cannot be . or ..')
      return
    }
    if (name.includes('/') || name.includes('\\')) {
      setActionError('Name cannot contain / or \\.')
      return
    }
    setBusy(true)
    setActionError(null)
    try {
      const to = `${data?.path ?? ''}/${name}`
      const res = await fetch('/api/files/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: e.path, to }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text || `rename failed (${res.status})`)
      }
      await load(data?.path)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Rename failed.')
    } finally {
      setBusy(false)
    }
  }

  const submitDelete = async (e: FileEntry) => {
    setBusy(true)
    setActionError(null)
    try {
      const res = await fetch(
        `/api/files?path=${encodeURIComponent(e.path)}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text || `delete failed (${res.status})`)
      }
      await load(data?.path)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Delete failed.')
    } finally {
      setBusy(false)
    }
  }

  // Click a card: folders open, media previews, other files open in the editor.
  const openEntry = (e: FileEntry) => {
    if (renaming === e.path || confirmDelete === e.path) return
    if (e.is_dir) {
      void load(e.path)
    } else if (!e.is_symlink && previewKindOf(e.name)) {
      setPreviewing(e)
    } else {
      void openEditor(e)
    }
  }

  /* ---------- Selection + bulk actions ---------- */

  const toggleSelect = (path: string) => {
    setSelected((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path],
    )
  }

  const selectedEntries = useMemo(
    () => (data?.entries ?? []).filter((e) => selected.includes(e.path)),
    [data, selected],
  )

  const submitBulkDelete = async () => {
    if (selectedEntries.length === 0) return
    setBusy(true)
    setActionError(null)
    const failed: string[] = []
    for (const e of selectedEntries) {
      try {
        const res = await fetch(
          `/api/files?path=${encodeURIComponent(e.path)}`,
          { method: 'DELETE' },
        )
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(text || `delete failed (${res.status})`)
        }
      } catch (err) {
        failed.push(`${e.name}: ${err instanceof Error ? err.message : 'failed'}`)
      }
    }
    await load(data?.path)
    setBusy(false)
    if (failed.length > 0) {
      setActionError(`Could not delete ${failed.length} item(s):\n${failed.join('\n')}`)
    }
  }

  const submitBulkDownload = () => {
    const files = selectedEntries.filter((e) => !e.is_dir)
    if (files.length === 0) return
    // Sequential trigger so the browser keeps every download.
    files.forEach((e, i) => {
      window.setTimeout(() => {
        const a = document.createElement('a')
        a.href = downloadUrl(e.path)
        a.download = e.name
        document.body.appendChild(a)
        a.click()
        a.remove()
      }, i * 400)
    })
  }

  /* ---------- Bulk zip + per-item zip/extract ---------- */

  const submitBulkZip = async () => {
    if (!data || selectedEntries.length === 0) return
    setBulkBusy(true)
    setActionError(null)
    try {
      const names = selectedEntries.map((e) => e.name)
      const out = `bulk-${selectedEntries.length}-items.zip`
      const res = await fetch('/api/files/zip-many', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: data.path, names, out }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text || `zip failed (${res.status})`)
      }
      const json = (await res.json()) as { path?: string }
      // Fetch the freshly created archive, then refresh the listing.
      const a = document.createElement('a')
      a.href = downloadUrl(json.path ?? `${data.path}/${out}`)
      a.download = out
      document.body.appendChild(a)
      a.click()
      a.remove()
      await load(data.path)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Zip failed.')
    } finally {
      setBulkBusy(false)
    }
  }

  const submitExtract = async (e: FileEntry) => {
    setMenuOpen(null)
    setActionError(null)
    setBusy(true)
    try {
      const res = await fetch('/api/files/unzip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: e.path }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text || `extract failed (${res.status})`)
      }
      await load(data?.path)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Extract failed.')
    } finally {
      setBusy(false)
    }
  }

  /* ---------- Deep (recursive) search ---------- */

  const runDeepSearch = async () => {
    const q = query.trim()
    if (!data || !q) return
    setDeep({ query: q, results: [], truncated: false, loading: true, error: null })
    try {
      const res = await fetch(
        `/api/files/search?root=${encodeURIComponent(data.path)}&q=${encodeURIComponent(q)}&max=100`,
      )
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text || `search failed (${res.status})`)
      }
      // Old backends (and the relay view) answer unknown /api/* routes with
      // the app HTML shell (200 OK) — detect that before .json() throws
      // "Unexpected token '<'".
      const ctype = res.headers.get('content-type') ?? ''
      if (!ctype.includes('application/json')) {
        throw new Error(
          'Deep search needs an up-to-date ks-ssh on the local UI (http://127.0.0.1:8080). ' +
            'The relay view and older backends return the app page here instead of results — ' +
            'rebuild with ./rebuild.sh and reopen this tab locally.',
        )
      }
      const json = (await res.json()) as SearchResponse
      setDeep({ query: q, results: json.entries ?? [], truncated: !!json.truncated, loading: false, error: null })
    } catch (err) {
      setDeep({ query: q, results: [], truncated: false, loading: false, error: err instanceof Error ? err.message : 'Search failed.' })
    }
  }

  const openDeepHit = (h: SearchHit) => {
    setDeep(null)
    if (h.is_dir) {
      void load(h.path)
    } else if (previewKindOf(h.name)) {
      setPreviewing({ name: h.name, path: h.path, is_dir: false, size: h.size, modified: h.modified } as FileEntry)
    } else {
      void openEditor({ name: h.name, path: h.path, is_dir: false, size: h.size, modified: h.modified } as FileEntry)
    }
  }

  /* ---------- Copy / move / duplicate ---------- */

  const openTransfer = (entry: FileEntry, mode: TransferMode) => {
    setMenuOpen(null)
    setConfirmDelete(null)
    setActionError(null)
    setTransfer({ entry, mode })
    setTransferDir(data?.path ?? '')
    setTransferName(entry.name)
    setTransferError(null)
  }

  const transferValid = (() => {
    const n = transferName.trim()
    const d = transferDir.trim()
    if (!transfer || !n || !d) return false
    if (n === '.' || n === '..') return false
    if (n.includes('/') || n.includes('\\')) return false
    return true
  })()

  const submitTransfer = async () => {
    if (!transfer || !transferValid) return
    const to = `${transferDir.trim().replace(/\/+$/, '')}/${transferName.trim()}`
    if (to === transfer.entry.path) {
      setTransferError('Destination is the same file.')
      return
    }
    setTransferBusy(true)
    setTransferError(null)
    try {
      const res = await fetch(
        transfer.mode === 'copy' ? '/api/files/copy' : '/api/files/rename',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: transfer.entry.path, to }),
        },
      )
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text || `transfer failed (${res.status})`)
      }
      setTransfer(null)
      await load(data?.path)
    } catch (err) {
      setTransferError(err instanceof Error ? err.message : 'Transfer failed.')
    } finally {
      setTransferBusy(false)
    }
  }

  const submitDuplicate = async (e: FileEntry) => {
    if (!data) return
    setMenuOpen(null)
    setActionError(null)
    const taken = new Set((data.entries ?? []).map((x) => x.name))
    const name = suggestCopyName(e.name, taken)
    setBusy(true)
    try {
      const res = await fetch('/api/files/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: e.path, to: `${data.path}/${name}` }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text || `duplicate failed (${res.status})`)
      }
      await load(data.path)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Duplicate failed.')
    } finally {
      setBusy(false)
    }
  }

  /* ---------- Properties + permissions ---------- */

  const openProps = (e: FileEntry) => {
    setMenuOpen(null)
    setConfirmDelete(null)
    setActionError(null)
    setPropsEntry(e)
    setPropsStat(null)
    setPropsStatLoading(true)
    setPropsMode(e.mode != null ? e.mode.toString(8) : '')
    setPropsError(null)
    // Fresh stat (owner, live mode, readonly flag) for the dialog.
    void (async () => {
      try {
        const res = await fetch(
          `/api/files/stat?path=${encodeURIComponent(e.path)}`,
        )
        if (!res.ok) return
        const json = (await res.json()) as StatResponse
        setPropsStat(json)
      } catch {
        // Listing data already shown — stat is a bonus.
      } finally {
        setPropsStatLoading(false)
      }
    })()
  }

  const submitChmod = async () => {
    if (!propsEntry) return
    const m = Number.parseInt(propsMode.trim(), 8)
    if (!Number.isInteger(m) || m < 0 || m > 0o7777) {
      setPropsError('Mode must be octal 0..7777 (e.g. 644).')
      return
    }
    setPropsBusy(true)
    setPropsError(null)
    try {
      const res = await fetch('/api/files/chmod', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: propsEntry.path, mode: m }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text || `chmod failed (${res.status})`)
      }
      setPropsEntry({ ...propsEntry, mode: m })
      await load(data?.path)
    } catch (err) {
      setPropsError(err instanceof Error ? err.message : 'Chmod failed.')
    } finally {
      setPropsBusy(false)
    }
  }

  /* ---------- Drag & drop upload ---------- */

  const dropHasFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes('Files')

  const onDropFiles = (e: React.DragEvent) => {
    e.preventDefault()
    dragDepth.current = 0
    setDropActive(false)
    if (uploading || !data || error) return
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.size > 0 || f.name)
    if (files.length === 0) return
    setUploadFiles(files)
    setUploadUrl('')
    setUploadName('')
    setUploadError(null)
    setUploadDone([])
    setUploadProgress('')
    setUploading('local')
  }

  const openEditor = async (e: FileEntry) => {
    setEditing(e)
    setEditorKind(null)
    setEditorText('')
    setEditorSaved('')
    setEditorError(null)
    setConfirmDiscard(false)
    setEditorLoading(true)
    try {
      const res = await fetch(
        `/api/files/content?path=${encodeURIComponent(e.path)}`,
      )
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text || `cannot open file (${res.status})`)
      }
      const json = (await res.json()) as ContentResponse
      setEditorKind(json.kind)
      if (json.kind === 'text') {
        setEditorText(json.content ?? '')
        setEditorSaved(json.content ?? '')
      }
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : 'Cannot open file.')
    } finally {
      setEditorLoading(false)
    }
  }

  const closeEditor = () => {
    if (editorDirty && !confirmDiscard) {
      setConfirmDiscard(true)
      return
    }
    setEditing(null)
    setEditorKind(null)
    setEditorText('')
    setEditorSaved('')
    setEditorError(null)
    setConfirmDiscard(false)
  }

  const saveEditor = async () => {
    if (!editing || !editorDirty) return
    setEditorSaving(true)
    setEditorError(null)
    try {
      const res = await fetch('/api/files/content', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: editing.path, content: editorText }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text || `save failed (${res.status})`)
      }
      setEditorSaved(editorText)
      setConfirmDiscard(false)
      await load(data?.path)
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : 'Save failed.')
    } finally {
      setEditorSaving(false)
    }
  }

  const openCreate = () => {
    setCreateName('')
    setCreateError(null)
    setCreating('file')
  }

  const openUpload = () => {
    setUploadFiles([])
    setUploadUrl('')
    setUploadName('')
    setUploadError(null)
    setUploadDone([])
    setUploadProgress('')
    setUploading('local')
  }

  const submitLocalUpload = async () => {
    if (!data || uploadFiles.length === 0) return
    setUploadBusy(true)
    setUploadError(null)
    setUploadDone([])
    const done: string[] = []
    const failed: string[] = []
    for (const f of uploadFiles) {
      setUploadProgress(`Uploading ${f.name} (${done.length + 1}/${uploadFiles.length})…`)
      try {
        const res = await fetch(
          `/api/files/upload?dir=${encodeURIComponent(data.path)}&name=${encodeURIComponent(f.name)}`,
          { method: 'POST', body: f },
        )
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(text || `upload failed (${res.status})`)
        }
        done.push(f.name)
      } catch (err) {
        failed.push(`${f.name}: ${err instanceof Error ? err.message : 'failed'}`)
      }
    }
    setUploadDone(done)
    setUploadProgress('')
    setUploadBusy(false)
    await load(data.path)
    if (failed.length > 0) {
      setUploadError(failed.join('\n'))
    } else {
      setUploadFiles([])
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const submitUrlUpload = async () => {
    const url = uploadUrl.trim()
    if (!data || !url) return
    setUploadBusy(true)
    setUploadError(null)
    setUploadDone([])
    setUploadProgress(`Fetching…`)
    try {
      const res = await fetch('/api/files/upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dir: data.path,
          url,
          name: uploadName.trim() || undefined,
        }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text || `fetch failed (${res.status})`)
      }
      const json = (await res.json()) as { path?: string }
      const saved = json.path?.split('/').pop() ?? url
      setUploadDone([saved])
      setUploadUrl('')
      setUploadName('')
      await load(data.path)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Fetch failed.')
    } finally {
      setUploadBusy(false)
      setUploadProgress('')
    }
  }

  const createNameValid = (() => {
    const n = createName.trim()
    if (!n || n === '.' || n === '..') return false
    if (n.includes('/') || n.includes('\\')) return false
    return true
  })()

  const submitCreate = async () => {
    const name = createName.trim()
    if (!creating || !data || !createNameValid) return
    if (
      (data.entries ?? []).some(
        (x) => x.name.toLowerCase() === name.toLowerCase(),
      )
    ) {
      setCreateError(`"${name}" already exists here.`)
      return
    }
    const target = `${data.path}/${name}`
    setCreateBusy(true)
    setCreateError(null)
    try {
      if (creating === 'folder') {
        const res = await fetch('/api/files/mkdir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: target }),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(text || `cannot create folder (${res.status})`)
        }
        setCreating(null)
        await load(data.path)
      } else {
        const res = await fetch('/api/files/content', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: target, content: '' }),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(text || `cannot create file (${res.status})`)
        }
        setCreating(null)
        await load(data.path)
        await openEditor({
          name,
          path: target,
          is_dir: false,
          size: 0,
          modified: null,
        })
      }
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Create failed.')
    } finally {
      setCreateBusy(false)
    }
  }

  return (
    <section
      className={`page files-page${dropActive ? ' files-drop-active' : ''}`}
      aria-labelledby="page-title-files"
      onDragEnter={(e) => {
        if (!dropHasFiles(e)) return
        e.preventDefault()
        dragDepth.current += 1
        setDropActive(true)
      }}
      onDragOver={(e) => {
        if (!dropHasFiles(e)) return
        e.preventDefault()
      }}
      onDragLeave={(e) => {
        if (!dropHasFiles(e)) return
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDropActive(false)
      }}
      onDrop={onDropFiles}
    >
      <div className="page-head files-head">
        <h1 id="page-title-files" className="sr-only">
          Files
        </h1>
        <div className="row-actions ports-actions files-actions">
          <label className="ports-search">
            <span className="sr-only">Search files in this folder</span>
            <svg className="ports-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && query.trim() && data && !loading) {
                  e.preventDefault()
                  void runDeepSearch()
                }
              }}
              placeholder="Search files…"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void runDeepSearch()}
            disabled={loading || busy || !!error || !data || !query.trim()}
            title="Search file names in this folder and all subfolders"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
              <path d="M11 8v6M8 11h6" />
            </svg>
            <span className="btn-label">Deep</span>
          </button>
          <div className="ports-right">
            <label className="ports-select-wrap">
              <span className="sr-only">File type filter</span>
              <select
                className="ports-select"
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value as FileTypeFilter)}
                aria-label="File type filter"
              >
                <option value="all">All</option>
                <option value="dirs">Folders</option>
                <option value="files">Files</option>
              </select>
              <svg className="ports-select-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </label>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={openCreate}
              disabled={loading || busy || !!error || !data}
              title="Create a file or folder here"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              <span className="btn-label">Create</span>
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={openUpload}
              disabled={loading || busy || !!error || !data}
              title="Upload files or fetch a URL here"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <path d="m17 8-5-5-5 5" />
                <path d="M12 3v12" />
              </svg>
              <span className="btn-label">Upload</span>
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void load(data?.home)}
              disabled={loading || busy}
              title="Go to HOME"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <path d="M9 22V12h6v10" />
              </svg>
              <span className="btn-label">Home</span>
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => data?.parent && void load(data.parent)}
              disabled={loading || busy || !data?.parent}
              title={data?.parent ?? 'Already at HOME'}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 19V5" />
                <path d="m5 12 7-7 7 7" />
              </svg>
              <span className="btn-label">Up</span>
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void load(data?.path)}
              disabled={loading || busy}
              title="Refresh"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <path d="M21 3v6h-6" />
              </svg>
              <span className="btn-label">Refresh</span>
            </button>
          </div>
        </div>
      </div>

      <div className="files-body">
        <div className="files-pathrow">
          <nav
            className="files-path files-crumbs"
            aria-label="Current folder"
            title={data?.path ?? 'HOME of host'}
          >
            {!data ? (
              <span className="crumb-current">~</span>
            ) : (
              <ol>
                {buildCrumbs(data.home, data.path).map((c, i, arr) => {
                  const isLast = i === arr.length - 1
                  return (
                    <li key={`${c.path}-${i}`}>
                      {isLast ? (
                        <span className="crumb-current" aria-current="page" title={c.path}>
                          {c.name}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="crumb-link"
                          title={`Open ${c.path}`}
                          disabled={loading || busy}
                          onClick={() => void load(c.path)}
                        >
                          {c.name}
                        </button>
                      )}
                      {!isLast && (
                        <span className="crumb-sep" aria-hidden="true">
                          /
                        </span>
                      )}
                    </li>
                  )
                })}
              </ol>
            )}
          </nav>
          <div className="files-path-tools">
            <label className="ports-select-wrap" title="Sort order">
              <span className="sr-only">Sort files</span>
              <select
                className="ports-select"
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
                aria-label="Sort files"
              >
                <option value="name">Name</option>
                <option value="size">Size</option>
                <option value="modified">Date</option>
              </select>
              <svg className="ports-select-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </label>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
              title={sortDir === 'asc' ? 'Ascending — switch to descending' : 'Descending — switch to ascending'}
              aria-label={sortDir === 'asc' ? 'Sort ascending' : 'Sort descending'}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {sortDir === 'asc' ? (
                  <path d="M12 19V5m-7 7 7-7 7 7" />
                ) : (
                  <path d="M12 5v14m7-7-7 7-7-7" />
                )}
              </svg>
              <span className="btn-label">{sortDir === 'asc' ? 'Asc' : 'Desc'}</span>
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setView((v) => (v === 'grid' ? 'list' : 'grid'))}
              title={view === 'grid' ? 'Switch to list view' : 'Switch to grid view'}
              aria-label={view === 'grid' ? 'List view' : 'Grid view'}
              aria-pressed={view === 'list'}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {view === 'grid' ? (
                  <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
                ) : (
                  <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" />
                )}
              </svg>
              <span className="btn-label">{view === 'grid' ? 'List' : 'Grid'}</span>
            </button>
            <label className="files-toggle">
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(e) => setShowHidden(e.target.checked)}
              />
              Hidden
            </label>
          </div>
        </div>
        {dropActive && (
          <div className="files-drop-hint" aria-hidden="true">
            <p>Drop files to upload them here</p>
          </div>
        )}
        <p className="files-sub">
          {loading
            ? 'Loading…'
            : error
              ? 'Could not list host files.'
              : filtering
                ? `${visible.length} of ${base.length} items`
                : `${dirCount} folders · ${fileCount} files`}
        </p>

        {actionError && !error && (
          <div className="banner-error" role="alert">
            <p>{actionError}</p>
          </div>
        )}

        {error ? (
          <div className="banner-error" role="alert">
            <p>{error}</p>
            <p>
              Tip: run <code>ks-ssh --port 8080</code> on the host and open
              this tab there. The fullscreen relay view has no host
              filesystem access.
            </p>
            <div className="row-actions">
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => void load(data?.path)}
                title="Retry loading files"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                  <path d="M21 3v6h-6" />
                </svg>
                <span className="btn-label">Retry</span>
              </button>
            </div>
          </div>
        ) : loading ? (
          <ul
            className="file-grid"
            aria-label="Loading host files"
            aria-busy="true"
          >
            {Array.from({ length: 8 }, (_, i) => (
              <li
                key={i}
                className="file-card ports-skeleton"
                aria-hidden="true"
              >
                <div className="file-card-top">
                  <span className="skeleton skeleton-icon" />
                  <span className="skeleton skeleton-title" />
                </div>
                <div className="file-meta">
                  <span className="skeleton skeleton-meta" />
                </div>
              </li>
            ))}
            <span className="sr-only" role="status">
              Loading host files…
            </span>
          </ul>
        ) : visible.length === 0 ? (
          filtering ? (
            <div className="ports-empty">
              <h2>No matches</h2>
              <p>Nothing in this folder matches the search or filter.</p>
              <div className="row-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    setQuery('')
                    setTypeFilter('all')
                  }}
                  title="Clear search and filter"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                  <span className="btn-label">Clear</span>
                </button>
              </div>
            </div>
          ) : (
            <p>Empty folder.</p>
          )
        ) : (
          <>
            {selected.length > 0 && (
              <div className="bulk-bar" role="toolbar" aria-label={`${selected.length} selected`}>
                <span className="bulk-count" aria-live="polite">
                  {selected.length} selected
                </span>
                <div className="bulk-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy || bulkBusy || selectedEntries.filter((x) => !x.is_dir).length === 0}
                    onClick={submitBulkDownload}
                    title="Download selected files (folders are skipped)"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <path d="m7 10 5 5 5-5" />
                      <path d="M12 15V3" />
                    </svg>
                    <span className="btn-label">Get</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy || bulkBusy || selectedEntries.length === 0}
                    onClick={() => void submitBulkZip()}
                    title="Zip the selection and download it as one archive"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="2" y="3" width="20" height="5" rx="1" />
                      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
                      <path d="M10 12h4" />
                    </svg>
                    <span className="btn-label">{bulkBusy ? 'Zipping…' : 'Zip'}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    disabled={busy || bulkBusy}
                    onClick={() => {
                      if (confirmBulkDelete) {
                        setConfirmBulkDelete(false)
                        void submitBulkDelete()
                      } else {
                        setConfirmBulkDelete(true)
                      }
                    }}
                    title={confirmBulkDelete ? `Click again to delete ${selected.length} selected item(s)` : `Delete ${selected.length} selected item(s)`}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M3 6h18" />
                      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                    </svg>
                    <span className="btn-label">{busy ? 'Deleting…' : confirmBulkDelete ? `Confirm (${selected.length})` : 'Delete'}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy || bulkBusy}
                    onClick={() => {
                      setSelected([])
                      setConfirmBulkDelete(false)
                    }}
                    title="Clear selection"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                    <span className="btn-label">Clear</span>
                  </button>
                </div>
              </div>
            )}
          <ul className={view === 'grid' ? 'file-grid' : 'file-list'} aria-label={`Files in ${data?.path}`}>
            {visible.map((e) => {
              const isMenu = menuOpen === e.path
              const isRenaming = renaming === e.path
              const isConfirm = confirmDelete === e.path
              const isChecked = selected.includes(e.path)
              const previewKind = !e.is_dir && !e.is_symlink ? previewKindOf(e.name) : null
              const cat: FileCat = e.is_dir ? 'dir' : fileCat(e.name, false)
              const metaText = `${e.is_dir ? 'folder' : formatSize(e.size)} · ${formatDate(e.modified)}${e.is_symlink ? ' · link' : ''}`
              return (
                <li
                  key={e.path}
                  className={`file-card${isChecked ? ' selected' : ''}`}
                  onClick={() => openEntry(e)}
                  title={e.is_dir ? `Open ${e.path}` : previewKind ? `Preview ${e.path}` : `Edit ${e.path}`}
                >
                  <div
                    className={`file-card-top${e.is_dir ? ' is-dir' : ''}`}
                  >
                    <input
                      type="checkbox"
                      className="files-select-checkbox"
                      checked={isChecked}
                      onChange={() => toggleSelect(e.path)}
                      onClick={(ev) => ev.stopPropagation()}
                      aria-label={`Select ${e.name}`}
                      title={`Select ${e.name}`}
                    />
                    <span
                      className="file-icon"
                      aria-hidden="true"
                      data-kind={cat}
                    >
                      <FileCatIcon cat={cat} />
                    </span>
                    {isRenaming ? (
                      <form
                        className="file-rename-form"
                        onSubmit={(ev) => {
                          ev.preventDefault()
                          void submitRename(e)
                        }}
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        <input
                          ref={renameInputRef}
                          className="file-rename-input"
                          type="text"
                          value={newName}
                          onChange={(ev) => setNewName(ev.target.value)}
                          aria-label={`New name for ${e.name}`}
                          maxLength={255}
                          disabled={busy}
                        />
                      </form>
                    ) : e.is_dir ? (
                      <button
                        type="button"
                        className="file-name file-link"
                        onClick={(ev) => {
                          ev.stopPropagation()
                          void load(e.path)
                        }}
                        title={`Open ${e.path}`}
                      >
                        {e.name}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="file-name file-link"
                        onClick={(ev) => {
                          ev.stopPropagation()
                          if (previewKind) setPreviewing(e)
                          else void openEditor(e)
                        }}
                        title={previewKind ? `Preview ${e.path}` : `Edit ${e.path}`}
                      >
                        {e.name}
                      </button>
                    )}
                    <div
                      className="file-menu-wrap"
                      onClick={(ev) => ev.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="file-dots"
                        aria-label={`Actions for ${e.name}`}
                        aria-haspopup="menu"
                        aria-expanded={isMenu}
                        title="Actions"
                        onClick={(ev) => {
                          ev.stopPropagation()
                          setMenuOpen(isMenu ? null : e.path)
                          setConfirmDelete(null)
                        }}
                      >
                        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                          <circle cx="12" cy="5" r="1.8" />
                          <circle cx="12" cy="12" r="1.8" />
                          <circle cx="12" cy="19" r="1.8" />
                        </svg>
                      </button>
                      {isMenu && (
                        <div className="file-menu" role="menu">
                          {e.is_dir ? (
                            <button
                              type="button"
                              role="menuitem"
                              className="file-menu-item"
                              onClick={() => void load(e.path)}
                            >
                              Open
                            </button>
                          ) : (
                            <>
                              {previewKind && (
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="file-menu-item"
                                  onClick={() => {
                                    setMenuOpen(null)
                                    setPreviewing(e)
                                  }}
                                >
                                  Preview
                                </button>
                              )}
                              <button
                                type="button"
                                role="menuitem"
                                className="file-menu-item"
                                onClick={() => {
                                  setMenuOpen(null)
                                  void openEditor(e)
                                }}
                              >
                                Open in editor
                              </button>
                              <a
                                role="menuitem"
                                className="file-menu-item"
                                href={downloadUrl(e.path)}
                                download={e.name}
                              >
                                Download
                              </a>
                              <a
                                role="menuitem"
                                className="file-menu-item"
                                href={zipUrl(e.path)}
                                download={`${e.name}.zip`}
                                title={`Download ${e.name} as a .zip archive`}
                              >
                                Download .zip
                              </a>
                              {!e.is_dir && isZipName(e.name) && (
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="file-menu-item"
                                  onClick={() => void submitExtract(e)}
                                  title={`Extract ${e.name} into this folder`}
                                >
                                  Extract here
                                </button>
                              )}
                            </>
                          )}
                          {e.is_dir && (
                            <a
                              role="menuitem"
                              className="file-menu-item"
                              href={zipUrl(e.path)}
                              download={`${e.name}.zip`}
                              title={`Download ${e.name} as a .zip archive`}
                            >
                              Download .zip
                            </a>
                          )}
                          <button
                            type="button"
                            role="menuitem"
                            className="file-menu-item"
                            onClick={() => startRename(e)}
                          >
                            Rename
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="file-menu-item"
                            onClick={() => void submitDuplicate(e)}
                          >
                            Duplicate
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="file-menu-item"
                            onClick={() => openTransfer(e, 'copy')}
                          >
                            Copy to…
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="file-menu-item"
                            onClick={() => openTransfer(e, 'move')}
                          >
                            Move to…
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="file-menu-item"
                            onClick={() => openProps(e)}
                          >
                            Properties
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="file-menu-item danger"
                            onClick={() => setConfirmDelete(e.path)}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="file-meta" title={metaText}>
                    {e.is_dir ? 'folder' : formatSize(e.size)} ·{' '}
                    {formatDate(e.modified)}
                    {e.is_symlink ? ' · link' : ''}
                  </div>

                  {isRenaming && (
                    <div
                      className="file-inline-actions"
                      onClick={(ev) => ev.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={busy || !newName.trim() || newName.trim() === e.name}
                        onClick={() => void submitRename(e)}
                        title="Save new name"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                          <path d="M17 21v-8H7v8" />
                          <path d="M7 3v5h8" />
                        </svg>
                        <span className="btn-label">Save</span>
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={() => {
                          setRenaming(null)
                          setActionError(null)
                        }}
                        title="Cancel rename"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                        <span className="btn-label">Cancel</span>
                      </button>
                    </div>
                  )}

                  {isConfirm && (
                    <div
                      className="file-confirm"
                      role="alertdialog"
                      aria-label={`Delete ${e.name}?`}
                      onClick={(ev) => ev.stopPropagation()}
                    >
                      <p>
                        Delete <strong>{e.name}</strong>
                        {e.is_dir ? ' and everything inside it?' : '?'}
                      </p>
                      <div className="file-inline-actions">
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          disabled={busy}
                          onClick={() => void submitDelete(e)}
                          title={`Delete ${e.name}`}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M3 6h18" />
                            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                          </svg>
                          <span className="btn-label">{busy ? 'Deleting…' : 'Delete'}</span>
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy}
                          onClick={() => setConfirmDelete(null)}
                          title="Keep file"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M9 14 4 9l5-5" />
                            <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
                          </svg>
                          <span className="btn-label">Keep</span>
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          </>
        )}
      </div>

      {previewing && (
        <div
          className="editor-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`Preview ${previewing.name}`}
          onClick={() => setPreviewing(null)}
        >
          <div
            className="editor-window preview-window"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="editor-head">
              <div className="editor-title">
                <strong>{previewing.name}</strong>
                <code title={previewing.path}>{previewing.path}</code>
              </div>
              <button
                type="button"
                className="icon-btn editor-close"
                aria-label="Close preview"
                title="Close"
                onClick={() => setPreviewing(null)}
              >
                ×
              </button>
            </div>
            <div className="preview-body">
              {previewKindOf(previewing.name) === 'image' && (
                <img
                  className="preview-media"
                  src={previewUrl(previewing.path)}
                  alt={previewing.name}
                />
              )}
              {previewKindOf(previewing.name) === 'video' && (
                <video
                  className="preview-media"
                  src={previewUrl(previewing.path)}
                  controls
                  preload="metadata"
                />
              )}
              {previewKindOf(previewing.name) === 'audio' && (
                <audio
                  className="preview-audio"
                  src={previewUrl(previewing.path)}
                  controls
                  preload="metadata"
                />
              )}
              {previewKindOf(previewing.name) === 'pdf' && (
                <iframe
                  className="preview-frame"
                  src={previewUrl(previewing.path)}
                  title={previewing.name}
                />
              )}
            </div>
            <div className="row-actions editor-actions">
              <a
                className="btn btn-sm btn-primary"
                href={downloadUrl(previewing.path)}
                download={previewing.name}
                title={`Download ${previewing.name}`}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <path d="m7 10 5 5 5-5" />
                  <path d="M12 15V3" />
                </svg>
                <span className="btn-label">Download</span>
              </a>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  const p = previewing
                  setPreviewing(null)
                  void openEditor(p)
                }}
                title="Open in editor"
              >
                <span className="btn-label">Editor</span>
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setPreviewing(null)}
                title="Close preview"
              >
                <span className="btn-label">Close</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {propsEntry && (
        <div
          className="editor-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`Properties of ${propsEntry.name}`}
          onClick={() => {
            if (!propsBusy) {
              setPropsEntry(null)
              setPropsStat(null)
              setPropsError(null)
            }
          }}
        >
          <div
            className="editor-window create-window"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="editor-head">
              <div className="editor-title">
                <strong>Properties</strong>
                <code title={propsEntry.path}>{propsEntry.path}</code>
              </div>
              <button
                type="button"
                className="icon-btn editor-close"
                aria-label="Close properties"
                title="Close"
                disabled={propsBusy}
                onClick={() => {
                  setPropsEntry(null)
                  setPropsStat(null)
                  setPropsError(null)
                }}
              >
                ×
              </button>
            </div>
            <dl className="props-table">
              <div>
                <dt>Name</dt>
                <dd title={propsEntry.name}>{propsEntry.name}</dd>
              </div>
              <div>
                <dt>Type</dt>
                <dd>{propsEntry.is_dir ? 'Folder' : 'File'}</dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd>{propsEntry.is_dir ? '—' : `${formatSize(propsEntry.size)} (${propsEntry.size} B)`}</dd>
              </div>
              <div>
                <dt>Modified</dt>
                <dd>{formatDate(propsEntry.modified)}</dd>
              </div>
              <div>
                <dt>Link</dt>
                <dd>{propsEntry.is_symlink ? 'Symbolic link' : 'No'}</dd>
              </div>
              <div>
                <dt>Permissions</dt>
                <dd>{formatMode(propsStat?.mode ?? propsEntry.mode)}</dd>
              </div>
              <div>
                <dt>Owner</dt>
                <dd>
                  {propsStatLoading && !propsStat
                    ? 'Loading…'
                    : propsStat
                      ? `${propsStat.uid ?? '—'} : ${propsStat.gid ?? '—'}${propsStat.readonly ? ' · read-only' : ''}`
                      : '—'}
                </dd>
              </div>
            </dl>
            {propsEntry.mode != null ? (
              <form
                onSubmit={(ev) => {
                  ev.preventDefault()
                  void submitChmod()
                }}
              >
                <div className="perm-grid" role="group" aria-label="Permissions">
                  {(['Owner', 'Group', 'Other'] as const).map((who, wi) => (
                    <div key={who} className="perm-row">
                      <span className="perm-who">{who}</span>
                      {(['r', 'w', 'x'] as const).map((p, pi) => {
                        const bit = 1 << (8 - (wi * 3 + pi))
                        const cur = Number.parseInt(propsMode.trim(), 8)
                        const checked = Number.isInteger(cur) && (cur & bit) !== 0
                        return (
                          <label key={p} className="perm-check">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={propsBusy || !Number.isInteger(cur)}
                              onChange={() => {
                                const base = Number.isInteger(cur) ? cur : (propsEntry.mode ?? 0)
                                const next = checked ? base & ~bit : base | bit
                                setPropsMode(next.toString(8))
                                setPropsError(null)
                              }}
                            />
                            {p}
                          </label>
                        )
                      })}
                    </div>
                  ))}
                </div>
                <label className="create-field">
                  Octal mode
                  <input
                    className="file-rename-input"
                    type="text"
                    value={propsMode}
                    onChange={(ev) => {
                      setPropsMode(ev.target.value)
                      setPropsError(null)
                    }}
                    placeholder="644"
                    maxLength={4}
                    disabled={propsBusy}
                    autoComplete="off"
                    spellCheck={false}
                    inputMode="numeric"
                  />
                </label>
              </form>
            ) : (
              <p className="files-sub">Permissions are only available on unix hosts.</p>
            )}
            {propsError && (
              <div className="banner-error" role="alert">
                <p>{propsError}</p>
              </div>
            )}
            <div className="row-actions editor-actions">
              <button
                type="button"
                className="btn btn-sm"
                disabled={propsBusy}
                onClick={() => {
                  setPropsEntry(null)
                  setPropsStat(null)
                  setPropsError(null)
                }}
                title="Close properties"
              >
                <span className="btn-label">Close</span>
              </button>
              {propsEntry.mode != null && (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={propsBusy || !propsMode.trim()}
                  onClick={() => void submitChmod()}
                  title="Apply permissions"
                >
                  <span className="btn-label">{propsBusy ? 'Applying…' : 'Apply'}</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {transfer && (
        <div
          className="editor-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`${transfer.mode === 'copy' ? 'Copy' : 'Move'} ${transfer.entry.name}`}
          onClick={() => {
            if (!transferBusy) {
              setTransfer(null)
              setTransferError(null)
            }
          }}
        >
          <div
            className="editor-window create-window"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="editor-head">
              <div className="editor-title">
                <strong>{transfer.mode === 'copy' ? 'Copy' : 'Move'} “{transfer.entry.name}”</strong>
                <code title={transfer.entry.path}>{transfer.entry.path}</code>
              </div>
              <button
                type="button"
                className="icon-btn editor-close"
                aria-label="Close transfer dialog"
                title="Close"
                disabled={transferBusy}
                onClick={() => {
                  setTransfer(null)
                  setTransferError(null)
                }}
              >
                ×
              </button>
            </div>
            <form
              onSubmit={(ev) => {
                ev.preventDefault()
                void submitTransfer()
              }}
            >
              <label className="create-field">
                Destination folder
                <input
                  className="file-rename-input"
                  type="text"
                  value={transferDir}
                  onChange={(ev) => {
                    setTransferDir(ev.target.value)
                    setTransferError(null)
                  }}
                  placeholder={data?.path ?? '~'}
                  disabled={transferBusy}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label className="create-field">
                Name
                <input
                  className="file-rename-input"
                  type="text"
                  value={transferName}
                  onChange={(ev) => {
                    setTransferName(ev.target.value)
                    setTransferError(null)
                  }}
                  maxLength={255}
                  disabled={transferBusy}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            </form>
            {transferError && (
              <div className="banner-error" role="alert">
                <p>{transferError}</p>
              </div>
            )}
            <div className="row-actions editor-actions">
              <button
                type="button"
                className="btn btn-sm"
                disabled={transferBusy}
                onClick={() => {
                  setTransfer(null)
                  setTransferError(null)
                }}
                title="Cancel"
              >
                <span className="btn-label">Cancel</span>
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={!transferValid || transferBusy}
                onClick={() => void submitTransfer()}
                title={transfer.mode === 'copy' ? 'Copy here' : 'Move here'}
              >
                <span className="btn-label">
                  {transferBusy
                    ? transfer.mode === 'copy'
                      ? 'Copying…'
                      : 'Moving…'
                    : transfer.mode === 'copy'
                      ? 'Copy'
                      : 'Move'}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {deep && (
        <div
          className="editor-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`Deep search results for ${deep.query}`}
          onClick={() => {
            if (!deep.loading) setDeep(null)
          }}
        >
          <div
            className="editor-window create-window"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="editor-head">
              <div className="editor-title">
                <strong>Deep search: “{deep.query}”</strong>
                <code title={data?.path}>{data?.path} + subfolders</code>
              </div>
              <button
                type="button"
                className="icon-btn editor-close"
                aria-label="Close deep search"
                title="Close"
                disabled={deep.loading}
                onClick={() => setDeep(null)}
              >
                ×
              </button>
            </div>

            {deep.loading ? (
              <p className="files-sub" role="status">Searching subfolders…</p>
            ) : deep.error ? (
              <div className="banner-error" role="alert">
                <p>{deep.error}</p>
              </div>
            ) : deep.results.length === 0 ? (
              <p className="files-sub">No file names match “{deep.query}” under this folder.</p>
            ) : (
              <>
                <p className="files-sub" aria-live="polite">
                  {deep.results.length} match{deep.results.length === 1 ? '' : 'es'}
                  {deep.truncated ? ' (more may exist — narrow the query)' : ''}
                </p>
                <ul className="upload-list" aria-label="Deep search results">
                  {deep.results.map((h) => (
                    <li key={h.path} className="upload-row">
                      <button
                        type="button"
                        className="file-name file-link upload-name"
                        onClick={() => openDeepHit(h)}
                        title={h.is_dir ? `Open folder ${h.path}` : `Open ${h.path}`}
                      >
                        {h.is_dir ? '📁 ' : '📄 '}{h.name}
                      </button>
                      <span className="upload-size" title={h.path}>
                        {h.is_dir ? 'folder' : formatSize(h.size)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <div className="row-actions editor-actions">
              <button
                type="button"
                className="btn btn-sm"
                disabled={deep.loading}
                onClick={() => setDeep(null)}
                title="Back to browsing"
              >
                <span className="btn-label">Back to browse</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <div
          className="editor-overlay editor-full"
          role="dialog"
          aria-modal="true"
          aria-label={`Edit ${editing.name}`}
        >
          <div
            className="editor-window editor-page"
          >
            <div className="editor-head">
              <span
                className="file-icon editor-file-icon"
                aria-hidden="true"
                data-kind={editCat}
              >
                <FileCatIcon cat={editCat} />
              </span>
              <div className="editor-title">
                <strong>{editing.name}</strong>
                <code title={editing.path}>{editing.path}</code>
              </div>
              {editorDirty && (
                <span className="dirty-dot" title="Unsaved changes">
                  ●
                </span>
              )}
              <button
                type="button"
                className="icon-btn editor-close"
                aria-label="Close editor"
                title="Close editor"
                onClick={() => closeEditor()}
              >
                ×
              </button>
            </div>

            {editorLoading ? (
              <div className="editor-skeleton" aria-busy="true" aria-label="Loading file contents">
                <span className="skeleton skeleton-line" />
                <span className="skeleton skeleton-line" />
                <span className="skeleton skeleton-line short" />
                <span className="skeleton skeleton-line" />
                <span className="skeleton skeleton-line medium" />
                <span className="sr-only" role="status">
                  Loading file…
                </span>
              </div>
            ) : editorError ? (
              <div className="banner-error" role="alert">
                <p>{editorError}</p>
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={() => void openEditor(editing)}
                    title="Retry opening file"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                      <path d="M21 3v6h-6" />
                    </svg>
                    <span className="btn-label">Retry</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => closeEditor()}
                    title="Close editor"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                    <span className="btn-label">Close</span>
                  </button>
                </div>
              </div>
            ) : editorKind === 'text' ? (
              <>
                <div className="editor-codewrap">
                  <div className="editor-gutter" aria-hidden="true" ref={gutRef}>
                    <pre>{gutterText}</pre>
                  </div>
                  <div className="editor-codebox">
                    <pre className="editor-highlight" aria-hidden="true" ref={hlRef}>
                      <code dangerouslySetInnerHTML={{ __html: highlighted }} />
                    </pre>
                    <textarea
                      ref={codeRef}
                      className="editor-area editor-input"
                      value={editorText}
                      onChange={(ev) => {
                        setEditorText(ev.target.value)
                        setConfirmDiscard(false)
                      }}
                      onScroll={syncCodeScroll}
                      onKeyDown={(ev) => {
                        if (ev.key !== 'Tab' && ev.key !== 'Enter') return
                        const ta = ev.currentTarget
                        const s = ta.selectionStart
                        const e2 = ta.selectionEnd
                        const v = ta.value
                        if (ev.key === 'Tab') {
                          // Keep focus in the editor and indent with 2 spaces.
                          ev.preventDefault()
                          setEditorText(`${v.slice(0, s)}  ${v.slice(e2)}`)
                          setConfirmDiscard(false)
                          const pos = s + 2
                          requestAnimationFrame(() => {
                            ta.selectionStart = pos
                            ta.selectionEnd = pos
                          })
                          return
                        }
                        // Enter keeps the current line indent.
                        const lineStart = v.lastIndexOf('\n', s - 1) + 1
                        const indent = /^[ \t]*/.exec(v.slice(lineStart, s))?.[0] ?? ''
                        if (!indent) return
                        ev.preventDefault()
                        setEditorText(`${v.slice(0, s)}\n${indent}${v.slice(e2)}`)
                        setConfirmDiscard(false)
                        const pos = s + 1 + indent.length
                        requestAnimationFrame(() => {
                          ta.selectionStart = pos
                          ta.selectionEnd = pos
                        })
                      }}
                      disabled={editorSaving}
                      spellCheck={false}
                      autoComplete="off"
                      autoCapitalize="off"
                      wrap="off"
                      aria-label={`Contents of ${editing.name}`}
                    />
                  </div>
                </div>
                {editorError && (
                  <div className="banner-error" role="alert">
                    <p>{editorError}</p>
                  </div>
                )}
                <div className="editor-foot">
                  <span className="editor-status">
                    {editLang.label} · {editorText.split('\n').length} lines ·{' '}
                    {formatSize(new Blob([editorText]).size)}
                    {editorDirty ? ' · unsaved' : ' · saved'}
                    {editorSaving ? ' · saving…' : ''}
                  </span>
                  <div className="row-actions editor-actions">
                    <a
                      className="btn btn-sm"
                      href={downloadUrl(editing.path)}
                      download={editing.name}
                      title={`Download ${editing.name}`}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <path d="m7 10 5 5 5-5" />
                        <path d="M12 15V3" />
                      </svg>
                      <span className="btn-label">Get</span>
                    </a>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={!editorDirty || editorSaving}
                      onClick={() => void saveEditor()}
                      title="Save file"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                        <path d="M17 21v-8H7v8" />
                        <path d="M7 3v5h8" />
                      </svg>
                      <span className="btn-label">{editorSaving ? 'Saving…' : 'Save'}</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={editorSaving}
                      onClick={() => closeEditor()}
                      title="Close editor"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M18 6 6 18M6 6l12 12" />
                      </svg>
                      <span className="btn-label">{editorDirty
                        ? confirmDiscard
                          ? 'Discard?'
                          : 'Close'
                        : 'Close'}</span>
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="editor-fallback">
                <p>
                  {editorKind === 'binary'
                    ? 'This looks like a binary file, so it cannot be edited here.'
                    : 'This file is too large to edit here (over 1 MB).'}
                </p>
                <div className="row-actions">
                  <a
                    className="btn btn-sm btn-primary"
                    href={downloadUrl(editing.path)}
                    download={editing.name}
                    title={`Download ${editing.name}`}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <path d="m7 10 5 5 5-5" />
                      <path d="M12 15V3" />
                    </svg>
                    <span className="btn-label">Download</span>
                  </a>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => closeEditor()}
                    title="Close editor"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                    <span className="btn-label">Close</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {creating && (
        <div
          className="editor-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Create file or folder"
          onClick={() => {
            if (!createBusy) setCreating(null)
          }}
        >
          <div
            className="editor-window create-window"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="editor-head">
              <div className="editor-title">
                <strong>Create in this folder</strong>
                <code title={data?.path}>{data?.path}</code>
              </div>
              <button
                type="button"
                className="icon-btn editor-close"
                aria-label="Close create dialog"
                title="Close"
                disabled={createBusy}
                onClick={() => setCreating(null)}
              >
                ×
              </button>
            </div>

            <div className="create-tabs" role="tablist" aria-label="What to create">
              {(['file', 'folder'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={creating === t}
                  className={creating === t ? 'create-tab active' : 'create-tab'}
                  disabled={createBusy}
                  onClick={() => {
                    setCreating(t)
                    setCreateError(null)
                    setTimeout(() => createInputRef.current?.select(), 30)
                  }}
                >
                  {t === 'file' ? 'File' : 'Folder'}
                </button>
              ))}
            </div>

            <form
              onSubmit={(ev) => {
                ev.preventDefault()
                void submitCreate()
              }}
            >
              <label className="create-field">
                {creating === 'file' ? 'File name' : 'Folder name'}
                <input
                  ref={createInputRef}
                  className="file-rename-input"
                  type="text"
                  value={createName}
                  onChange={(ev) => {
                    setCreateName(ev.target.value)
                    setCreateError(null)
                  }}
                  placeholder={creating === 'file' ? 'notes.txt' : 'new-folder'}
                  maxLength={255}
                  disabled={createBusy}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
              </label>
            </form>

            {createError && (
              <div className="banner-error" role="alert">
                <p>{createError}</p>
              </div>
            )}

            <div className="row-actions editor-actions">
              <button
                type="button"
                className="btn btn-sm"
                disabled={createBusy}
                onClick={() => setCreating(null)}
                title="Cancel create"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
                <span className="btn-label">Cancel</span>
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={!createNameValid || createBusy}
                onClick={() => void submitCreate()}
                title={creating === 'file' ? 'Create file' : 'Create folder'}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                <span className="btn-label">{createBusy
                  ? 'Creating…'
                  : creating === 'file'
                    ? 'Create file'
                    : 'Create folder'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {uploading && (
        <div
          className="editor-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Upload to this folder"
          onClick={() => {
            if (!uploadBusy) setUploading(null)
          }}
        >
          <div
            className="editor-window create-window"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="editor-head">
              <div className="editor-title">
                <strong>Upload to this folder</strong>
                <code title={data?.path}>{data?.path}</code>
              </div>
              <button
                type="button"
                className="icon-btn editor-close"
                aria-label="Close upload dialog"
                title="Close"
                disabled={uploadBusy}
                onClick={() => setUploading(null)}
              >
                ×
              </button>
            </div>

            <div className="create-tabs" role="tablist" aria-label="Upload source">
              {(['local', 'url'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={uploading === t}
                  className={uploading === t ? 'create-tab active' : 'create-tab'}
                  disabled={uploadBusy}
                  onClick={() => {
                    setUploading(t)
                    setUploadError(null)
                    setUploadDone([])
                  }}
                >
                  {t === 'local' ? 'Local' : 'URL'}
                </button>
              ))}
            </div>

            {uploading === 'local' ? (
              <>
                <label className="create-field">
                  Choose files
                  <input
                    ref={fileInputRef}
                    className="upload-input"
                    type="file"
                    multiple
                    disabled={uploadBusy}
                    onChange={(ev) => {
                      setUploadFiles(Array.from(ev.target.files ?? []))
                      setUploadError(null)
                      setUploadDone([])
                    }}
                  />
                </label>
                {uploadFiles.length > 0 && (
                  <ul className="upload-list" aria-label="Selected files">
                    {uploadFiles.map((f) => (
                      <li key={`${f.name}-${f.size}-${f.lastModified}`} className="upload-row">
                        <span className="upload-name" title={f.name}>
                          {f.name}
                        </span>
                        <span className="upload-size">{formatSize(f.size)}</span>
                        <button
                          type="button"
                          className="file-dots"
                          aria-label={`Remove ${f.name}`}
                          title="Remove"
                          disabled={uploadBusy}
                          onClick={() =>
                            setUploadFiles((prev) => prev.filter((x) => x !== f))
                          }
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <form
                className="upload-url-form"
                onSubmit={(ev) => {
                  ev.preventDefault()
                  void submitUrlUpload()
                }}
              >
                <label className="create-field">
                  File URL
                  <input
                    className="file-rename-input"
                    type="url"
                    value={uploadUrl}
                    onChange={(ev) => {
                      setUploadUrl(ev.target.value)
                      setUploadError(null)
                    }}
                    placeholder="https://example.com/file.zip"
                    disabled={uploadBusy}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <label className="create-field">
                  Save as (optional)
                  <input
                    className="file-rename-input"
                    type="text"
                    value={uploadName}
                    onChange={(ev) => {
                      setUploadName(ev.target.value)
                      setUploadError(null)
                    }}
                    placeholder="keeps the URL file name when empty"
                    maxLength={255}
                    disabled={uploadBusy}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              </form>
            )}

            {uploadProgress && <p className="files-sub">{uploadProgress}</p>}

            {uploadDone.length > 0 && (
              <div className="upload-done" role="status">
                <p>Uploaded: {uploadDone.join(', ')}</p>
              </div>
            )}

            {uploadError && (
              <div className="banner-error" role="alert">
                <p>{uploadError}</p>
              </div>
            )}

            <div className="row-actions editor-actions">
              <button
                type="button"
                className="btn btn-sm"
                disabled={uploadBusy}
                onClick={() => setUploading(null)}
                title={uploadDone.length > 0 ? 'Close upload dialog' : 'Cancel upload'}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {uploadDone.length > 0 ? (
                    <path d="M20 6 9 17l-5-5" />
                  ) : (
                    <path d="M18 6 6 18M6 6l12 12" />
                  )}
                </svg>
                <span className="btn-label">{uploadDone.length > 0 ? 'Done' : 'Cancel'}</span>
              </button>
              {uploading === 'local' ? (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={uploadFiles.length === 0 || uploadBusy}
                  onClick={() => void submitLocalUpload()}
                  title="Upload selected files"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <path d="m17 8-5-5-5 5" />
                    <path d="M12 3v12" />
                  </svg>
                  <span className="btn-label">{uploadBusy
                    ? 'Uploading…'
                    : `Upload ${uploadFiles.length > 0 ? `${uploadFiles.length} file${uploadFiles.length > 1 ? 's' : ''}` : ''}`}</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={!uploadUrl.trim() || uploadBusy}
                  onClick={() => void submitUrlUpload()}
                  title="Fetch file from URL"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <path d="m7 10 5 5 5-5" />
                    <path d="M12 15V3" />
                  </svg>
                  <span className="btn-label">{uploadBusy ? 'Fetching…' : 'Fetch file'}</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

