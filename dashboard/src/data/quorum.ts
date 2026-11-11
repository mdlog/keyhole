/**
 * The council's approval count for a sputnikdao2 policy, as src/packs/sputnik-v2.ts's requiredApprovals computes it:
 * RoleWeight only; threshold [num, den] → floor(num × size / den) + 1, capped at the council's size; at least `quorum`.
 * Null when the policy does not decide it that way (no council Group, token weight, malformed).
 */
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

export const COUNCIL = 'council'

export function councilMembers(policy: unknown): string[] | null {
  if (!isObj(policy) || !Array.isArray(policy.roles)) return null
  const role = policy.roles.find((r) => isObj(r) && r.name === COUNCIL)
  const group = isObj(role) && isObj(role.kind) ? role.kind.Group : undefined
  return Array.isArray(group) ? group.map(String) : null
}

function policyLabel(kind: unknown): string | undefined {
  const variant = typeof kind === 'string' ? kind : isObj(kind) && Object.keys(kind).length === 1 ? Object.keys(kind)[0] : undefined
  if (!variant) return undefined
  if (variant === 'FunctionCall') return 'call'
  if (variant === 'SetStakingContract') return 'set_vote_token'
  return variant.replace(/^Change(?=[A-Z])/, '').replace(/[A-Z]/g, (c, i: number) => (i ? '_' : '') + c.toLowerCase())
}

export function requiredApprovals(policy: unknown, kind?: unknown): number | null {
  const members = councilMembers(policy)
  if (!members || !isObj(policy) || !Array.isArray(policy.roles)) return null
  const role = policy.roles.find((r) => isObj(r) && r.name === COUNCIL) as Obj
  const label = kind === undefined ? undefined : policyLabel(kind)
  const perKind = label !== undefined && isObj(role.vote_policy) && Object.prototype.hasOwnProperty.call(role.vote_policy, label) ? role.vote_policy[label] : undefined
  const vp = perKind ?? policy.default_vote_policy
  if (!isObj(vp) || vp.weight_kind !== 'RoleWeight') return null
  const size = BigInt(members.length)
  let weight: bigint
  try {
    if (Array.isArray(vp.threshold)) {
      const [num, den] = vp.threshold.map((x) => BigInt(String(x)))
      if (den === 0n) return null
      weight = (num * size) / den + 1n
    } else {
      weight = BigInt(String(vp.threshold))
    }
    if (weight > size) weight = size
    const quorum = BigInt(String(vp.quorum))
    return Number(quorum > weight ? quorum : weight)
  } catch {
    return null
  }
}

/** A proposal kind in a few words: `Transfer 5.0000 NEAR → attacker.x.testnet`, or its variant name. */
export function kindName(kind: unknown): string {
  if (typeof kind === 'string') return kind
  if (isObj(kind)) return Object.keys(kind)[0] ?? 'unknown'
  return 'unknown'
}
