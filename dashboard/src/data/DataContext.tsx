import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { KeyRound } from 'lucide-react'
import type { DashboardData } from './types'

const DataContext = createContext<DashboardData | null>(null)

/** The recorded half of the console: public/data/keyhole.json, served next to the page. */
export function DataProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('./data/keyhole.json', { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: DashboardData) => setData(d))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  if (error) return <div className="boot-screen"><KeyRound size={20} /><strong>The console could not load data/keyhole.json</strong><span>{error}. The same records are in the repo under demo/.</span></div>
  if (!data) return <div className="boot-screen"><KeyRound size={20} /><span>Loading the recorded runs…</span></div>
  return <DataContext.Provider value={data}>{children}</DataContext.Provider>
}

export function useData(): DashboardData {
  const d = useContext(DataContext)
  if (!d) throw new Error('useData outside DataProvider')
  return d
}
