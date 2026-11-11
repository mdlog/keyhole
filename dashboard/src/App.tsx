import { useEffect } from 'react'
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import AppShell from './components/AppShell'
import LandingPage from './pages/LandingPage'
import OverviewPage from './pages/OverviewPage'
import SessionsPage from './pages/SessionsPage'
import SessionDetailPage from './pages/SessionDetailPage'
import InspectPage from './pages/InspectPage'
import ProposalsPage from './pages/ProposalsPage'
import EvidencePage from './pages/EvidencePage'
import ActivityPage from './pages/ActivityPage'
import CommandsPage from './pages/CommandsPage'
import SecurityPage from './pages/SecurityPage'

/** The site's root is the landing page; the operator console lives under it, inside the shell. */
export default function App() {
  const { pathname } = useLocation()
  useEffect(() => { window.scrollTo(0, 0) }, [pathname])
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route element={<AppShell><Outlet /></AppShell>}>
        <Route path="/overview" element={<OverviewPage />} />
        <Route path="/sessions" element={<SessionsPage />} />
        <Route path="/sessions/:sessionId" element={<SessionDetailPage />} />
        <Route path="/inspect" element={<InspectPage />} />
        <Route path="/proposals" element={<ProposalsPage />} />
        <Route path="/evidence" element={<EvidencePage />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/commands" element={<CommandsPage />} />
        <Route path="/security" element={<SecurityPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
