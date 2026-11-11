/**
 * The shape of public/data/keyhole.json, written by scripts/dashboard-data.ts (npm run site:data) from demo/ and
 * src/packs/. Keep in step with that script's Dash* interfaces; test/dashboard.test.ts checks the file itself.
 */
export interface Tool { name: string; kind: string; method: string; gasTGas: number; classification?: string; evidence?: string }

export interface Session {
  id: string
  network: string
  mode: 'on-account' | 'subaccount'
  accountId: string
  receiverId: string
  methodNames: string[]
  allowanceYocto: string
  publicKey: string
  codeHashPin: string
  packId: string
  createdAt: string
  role: string
  source: string
  runId: string | null
  wrap: { txHash: string; step: number | null }
  burn: { txHash: string; step: number; label: string; note: string | null } | null
  lastRead: { allowanceRemainingYocto: string; codeHashNow: string; readAt: string; step: number } | null
  tools: Tool[] | null
}

export interface Step {
  n: number
  total: number
  phase: string
  label: string
  signer: string
  pass: boolean
  txHashes: string[]
  note: string | null
  fixture: string | null
  sessionId: string | null
  proposal: { id: number; status: string; approvals: number; required: number } | null
  attempt: { receiverId: string; action: string; method: string | null; depositYocto: string | null; gasTGas: number | null; violates: string | null } | null
  chainCheck: { before: string; after: string } | null
}

export interface Run {
  id: string
  label: string
  network: string
  file: string
  transcript: string
  startedAt: string
  durationMs: number
  exitCode: number
  result: { pass: string; parts: string[] }
  steps: Step[]
}

export interface Refusal {
  n: number
  fixture: string
  network: string
  pack: string
  test: string
  attempt: string
  rule: string
  boundary: string
  errorName: string
  family: string
  path: string[]
  body: string
  runId: string
  step: number
  sessionId: string | null
}

export interface Pack { id: string; description: string; codeHash: string | null; notEnforced: string; exposure: { label: string; value: string } | null; tools: Tool[]; outOfScope: string[] }

export interface Dao { accountId: string; network: string; packId: string; codeHashPin: string; create: { txHash: string; runId: string; step: number; label: string }; seeded: { id: number; note: string }[] }

export interface DashboardData {
  repo: string
  judgingSessionId: string
  sessions: Session[]
  runs: Run[]
  refusals: Refusal[]
  packs: Pack[]
  dao: Dao
}
