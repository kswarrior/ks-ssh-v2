import type { FileEntry } from '@shared'

// VS Code-style per-type SVG icons with type colors.
const COLORS: Record<string, string> = {
  js: '#f1e05a', ts: '#3178c6', jsx: '#61dafb', tsx: '#3178c6',
  py: '#3572A5', go: '#00ADD8', json: '#f1e05a', yml: '#cb171e',
  yaml: '#cb171e', html: '#e34c26', css: '#563d7c', scss: '#c6538c',
  sh: '#89e051', md: '#519aba', zip: '#ffb13b', tar: '#ffb13b',
  gz: '#ffb13b', img: '#a074c4', pdf: '#da2d1e', mp3: '#8f8f8f',
  mp4: '#974ec3', log: '#9a9a9a', conf: '#6d8086', sql: '#dad8d8',
  rs: '#dea584', java: '#b07219', c: '#555555', cpp: '#f34b7d',
  php: '#a071c9', rb: '#701516', xml: '#0060ac', csv: '#237346',
  lock: '#bbbbbb', file: '#9aa0a6', folder: '#dcb67a',
}

function FolderIcon() {
  return (
    <svg className="file-icon" viewBox="0 0 16 16">
      <path fill="#dcb67a" d="M1.5 3h4.2l1.3 1.6h7.5V13H1.5z" />
    </svg>
  )
}

function GenericIcon(type: string) {
  const c = COLORS[type] ?? COLORS.file
  return (
    <svg className="file-icon" viewBox="0 0 16 16">
      <path fill={c} opacity="0.92"
        d="M4 1.5h5.2L12.5 4.8v9.7H4z" />
      <path fill="#00000033" d="M9.2 1.5l3.3 3.3H9.2z" />
      {type !== 'file' && (
        <text x="8.1" y="12.2" fontSize="5.4" textAnchor="middle"
          fill="#fff" fontFamily="monospace">{type.slice(0, 3)}</text>
      )}
    </svg>
  )
}

export function FileIcon(e: Pick<FileEntry, 'isDir' | 'itemType'>) {
  if (e.isDir || e.itemType === 'folder') return <FolderIcon />
  return GenericIcon(e.itemType)
}
