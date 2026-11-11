import { useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import {
  Activity, ArrowUpRight, BookOpen, Command, FileSearch2, Fingerprint, Github,
  LayoutDashboard, Menu, RefreshCw, ScanSearch, Search, ShieldCheck, X, Vote, KeyRound,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useData } from '../data/DataContext'
import { refreshAll, useBlock } from '../data/live'

const navSections = [
  {
    label: 'WORKSPACE',
    items: [
      { to: '/', label: 'Overview', icon: LayoutDashboard },
      { to: '/sessions', label: 'Sessions', icon: Fingerprint },
      { to: '/inspect', label: 'Key inspector', icon: ScanSearch },
      { to: '/proposals', label: 'DAO proposals', icon: Vote },
      { to: '/evidence', label: 'Refusal ledger', icon: FileSearch2 },
      { to: '/activity', label: 'Run log', icon: Activity },
    ],
  },
  {
    label: 'REFERENCE',
    items: [
      { to: '/commands', label: 'Command guide', icon: BookOpen },
      { to: '/security', label: 'Security model', icon: ShieldCheck },
    ],
  },
]

const pageTargets = navSections.flatMap((section) => section.items)

export default function AppShell({ children }: { children: ReactNode }) {
  const data = useData()
  const block = useBlock()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [showResults, setShowResults] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const location = useLocation()
  const navigate = useNavigate()

  const searchTargets = useMemo(() => [
    ...pageTargets.map(({ to, label }) => ({ to, label })),
    ...data.sessions.map((s) => ({ to: `/sessions/${s.id}`, label: `${s.id} · ${s.role}` })),
    ...data.refusals.map((r) => ({ to: `/evidence?fixture=${encodeURIComponent(r.fixture)}`, label: `${r.errorName} · ${r.boundary}` })),
  ], [data])

  const results = useMemo(() => {
    const normalized = query.toLowerCase().trim()
    return normalized ? searchTargets.filter((item) => item.label.toLowerCase().includes(normalized)).slice(0, 8) : []
  }, [query, searchTargets])

  useEffect(() => {
    setMobileOpen(false)
    setShowResults(false)
  }, [location.pathname, location.search])

  useEffect(() => {
    const handleKeys = (event: KeyboardEvent) => {
      if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes((event.target as HTMLElement)?.tagName ?? '')) {
        event.preventDefault()
        searchRef.current?.focus()
      }
      if (event.key === 'Escape') {
        setShowResults(false)
        setMobileOpen(false)
        searchRef.current?.blur()
      }
    }
    window.addEventListener('keydown', handleKeys)
    return () => window.removeEventListener('keydown', handleKeys)
  }, [])

  const judging = data.sessions.find((s) => s.id === data.judgingSessionId)
  const b = block.value

  const sidebar = (
    <>
      <div className="brand-lockup">
        <div className="brand-mark"><KeyRound size={19} strokeWidth={2.2} /></div>
        <div className="brand-copy"><strong>keyhole</strong><span>OPERATOR CONSOLE</span></div>
        <button className="icon-button mobile-close" aria-label="Close navigation" onClick={() => setMobileOpen(false)}><X size={18} /></button>
      </div>
      <div className="workspace-select" aria-label="Workspace">
        <div className="workspace-avatar"><span>KH</span></div>
        <div className="workspace-name"><strong>Judging workspace</strong><span>NEAR testnet · {judging?.id}</span></div>
      </div>
      <nav className="side-nav" aria-label="Main navigation">
        {navSections.map((section) => (
          <div className="nav-section" key={section.label}>
            <p className="nav-section-label">{section.label}</p>
            {section.items.map(({ to, label, icon: Icon }) => (
              <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
                <Icon size={17} strokeWidth={1.8} />
                <span>{label}</span>
                {to === '/sessions' && <span className="nav-count">{data.sessions.length}</span>}
                {to === '/evidence' && <span className="nav-count">{data.refusals.length}</span>}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-spacer" />
      <div className="sidebar-posture">
        <div className="posture-icon"><ShieldCheck size={17} /></div>
        <div><strong>Read-only console</strong><span>No wallet · no private key · signs nothing</span></div>
        <span className="pulse-dot" />
      </div>
      <div className="sidebar-foot"><span>KEYHOLE · MIT</span><a href={data.repo} target="_blank" rel="noreferrer">github.com/mdlog/keyhole</a></div>
    </>
  )

  return (
    <div className="app-frame">
      <aside className="sidebar desktop-sidebar">{sidebar}</aside>
      {mobileOpen && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
      <aside className={`sidebar mobile-sidebar${mobileOpen ? ' open' : ''}`}>{sidebar}</aside>
      <div className="app-main">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Menu size={20} /></button>
            <div className="breadcrumb"><span>Keyhole</span><span className="crumb-sep">/</span><strong>{getPageName(location.pathname)}</strong></div>
          </div>
          <div className="topbar-right">
            <div className="global-search">
              <Search size={15} />
              <input ref={searchRef} aria-label="Search pages, sessions and refusals" placeholder="Search pages, sessions…" value={query} onChange={(event) => { setQuery(event.target.value); setShowResults(true) }} onFocus={() => query && setShowResults(true)} onKeyDown={(event) => { if (event.key === 'Enter' && results[0]) { navigate(results[0].to); setQuery('') } }} />
              <kbd><Command size={10} /> /</kbd>
              {showResults && query && <div className="search-results">{results.length ? results.map((item) => <button key={item.to} onClick={() => { navigate(item.to); setQuery('') }}><span>{item.label}</span><ArrowUpRight size={14} /></button>) : <p>No match</p>}</div>}
            </div>
            <div className="topbar-divider" />
            <span className={`demo-chip chain-chip${b && !b.ok ? ' is-down' : ''}`} title={b?.ok ? `latest final block ${b.height} at ${b.time}` : b?.error ?? 'reading the latest block'}>
              <span className="chip-dot" />
              {!b ? 'TESTNET · …' : b.ok ? `TESTNET · #${b.height.toLocaleString('en-US')}` : 'RPC UNREACHABLE'}
            </span>
            <button className="icon-button" aria-label="Read everything again from chain" title="Read everything again from chain" onClick={refreshAll}><RefreshCw size={16} /></button>
            <a className="operator-avatar" href={data.repo} target="_blank" rel="noreferrer" aria-label="Source on GitHub" title="Source on GitHub"><Github size={15} /></a>
          </div>
        </header>
        <main className="page-content" onClick={() => showResults && setShowResults(false)}>{children}</main>
        <footer className="app-footer"><span>KEYHOLE · OPERATOR CONSOLE</span><span>Recorded runs and refusals from <a href={`${data.repo}/tree/main/demo`} target="_blank" rel="noreferrer">demo/</a> <i /> live reads from NEAR testnet RPC <i /> this page signs nothing</span></footer>
      </div>
    </div>
  )
}

function getPageName(path: string) {
  if (path === '/') return 'Overview'
  if (path.startsWith('/sessions/')) return 'Session detail'
  const route = pageTargets.find((item) => item.to === path)
  return route?.label ?? 'Overview'
}
