import { Fragment } from 'react'
import type { ReactNode } from 'react'

export const EXPLORER = 'https://testnet.nearblocks.io'

export function shortAddress(value: string, start = 18, end = 11) {
  if (value.length <= start + end + 3) return value
  return `${value.slice(0, start)}…${value.slice(-end)}`
}

const NEAR = 10n ** 24n

/** yoctoNEAR → NEAR with `dp` decimals, truncated (the CLI's formatNear). */
export function formatNear(yocto: string, dp = 4): string {
  const v = BigInt(yocto)
  const fraction = (v % NEAR) / 10n ** BigInt(24 - dp)
  return `${v / NEAR}.${fraction.toString().padStart(dp, '0')}`
}

/** Remaining / initial, as a 0–100 width. */
export function percentOf(part: string, whole: string): number {
  const w = BigInt(whole)
  if (w === 0n) return 0
  return Math.max(0, Math.min(100, Number((BigInt(part) * 10000n) / w) / 100))
}

/** 2026-11-06T15:05:56.123Z → 2026-11-06 15:05:56 UTC */
export const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`

export const utcNow = (ms: number) => utc(new Date(ms).toISOString())

/** sputnikdao2 timestamps are nanoseconds since the epoch. */
export const nsToIso = (ns: string) => new Date(Number(BigInt(ns) / 1000000n)).toISOString()

export const txUrl = (network: string, hash: string) => (network === 'testnet' ? `${EXPLORER}/txns/${hash}` : null)
export const accountUrl = (network: string, account: string) => (network === 'testnet' ? `${EXPLORER}/address/${account}` : null)
export const repoFile = (repo: string, file: string) => `${repo}/blob/main/${file}`

/** `a` and `b` in backticks become <code>; the rest is text. */
export function Ticks({ text }: { text: string }) {
  return <>{text.split('`').map((part, i) => (i % 2 ? <code key={i}>{part}</code> : <Fragment key={i}>{part}</Fragment>))}</>
}

/** A tx hash, linked to the explorer on testnet; a sandbox hash stays text (that chain is gone). */
export function TxLink({ network, hash, short = true }: { network: string; hash: string; short?: boolean }) {
  const url = txUrl(network, hash)
  const label = short ? shortAddress(hash, 10, 6) : hash
  return url ? <a className="tx-link" href={url} target="_blank" rel="noreferrer" title={hash}><code>{label}</code></a> : <code className="tx-text" title={hash}>{label}</code>
}

export function AccountLink({ network, account }: { network: string; account: string }) {
  const url = accountUrl(network, account)
  return url ? <a className="tx-link" href={url} target="_blank" rel="noreferrer"><code>{account}</code></a> : <code>{account}</code>
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer">{children}</a>
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
