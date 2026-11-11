import type { ReactNode } from 'react'

export type Tone = 'live' | 'verified' | 'warning' | 'muted' | 'error' | 'demo' | 'protocol' | 'violet'

export default function StatusBadge({ children, tone = 'muted', dot = false }: { children: ReactNode; tone?: Tone; dot?: boolean }) {
  return <span className={`status-badge tone-${tone}`}>{dot && <i className="badge-dot" />}{children}</span>
}
