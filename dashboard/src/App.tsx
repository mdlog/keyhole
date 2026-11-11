import { Navigate, Route, Routes } from 'react-router-dom'
import AppShell from './components/AppShell'
import OverviewPage from './pages/OverviewPage'
import SessionsPage from './pages/SessionsPage'
import SessionDetailPage from './pages/SessionDetailPage'
import InspectPage from './pages/InspectPage'
import ProposalsPage from './pages/ProposalsPage'
import EvidencePage from './pages/EvidencePage'
import ActivityPage from './pages/ActivityPage'
import CommandsPage from './pages/CommandsPage'
import SecurityPage from './pages/SecurityPage'

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/sessions" element={<SessionsPage />} />
        <Route path="/sessions/:sessionId" element={<SessionDetailPage />} />
        <Route path="/inspect" element={<InspectPage />} />
        <Route path="/proposals" element={<ProposalsPage />} />
        <Route path="/evidence" element={<EvidencePage />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/commands" element={<CommandsPage />} />
        <Route path="/security" element={<SecurityPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  )
}
