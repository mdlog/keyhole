/**
 * R5 `keyhole inspect ID`: the cage card re-read from chain. Loads no private key.
 *
 * The chain is the source of truth: the key comes from view_access_key and the code hash from view_account
 * (buildCageCard "chain"). When the session file and the chain disagree, the chain wins and a line says so.
 */
import { buildCageCard } from "../core/cage.js";
import { UnknownSessionError } from "../core/errors.js";
import { loadSession } from "../core/session.js";
import type { Network, Session } from "../core/types.js";
import { renderCageCard } from "../render/cage-card.js";
import { link, neutralizeControls, sgr } from "../render/style.js";
import { termCaps } from "../render/term.js";
import { renderTxLineRows } from "../render/tx-line.js";
import { type Command, type Io, sessionIdArg } from "./args.js";

/** The label of the BURNED block's tx line. */
const DELETE_KEY = "DeleteKey ";

/** Explorer account pages by network; sandbox has none. */
const EXPLORER_ADDRESS: Record<Network, string | null> = {
  testnet: "https://testnet.nearblocks.io/address/",
  sandbox: null,
};

/** The CONTRACT functions inspect calls. Tests replace any of them. */
export interface InspectDeps {
  loadSession: typeof loadSession;
  buildCageCard: typeof buildCageCard;
}

export function createInspectCommand(overrides: Partial<InspectDeps> = {}): Command {
  const d: InspectDeps = { loadSession, buildCageCard, ...overrides };
  const cmd: Command = {
    name: "inspect",
    args: "ID",
    keys: "no key",
    async run(argv, io) {
      const id = sessionIdArg(cmd, argv, io);
      if (id === null) return 0;
      const caps = termCaps(io.stdout ?? {}, io.env ?? process.env);
      const session = await loadOrList(id, io, d.loadSession);
      if (session === null) return 1;

      const card = await d.buildCageCard(session, "chain");
      io.out(`${sgr(caps, "bold", "KEYHOLE inspect")} · ${id} · ${session.network} · ${modeLabel(session)}`);

      if (card.key === null) {
        // BURNED: the 3-line block replaces the card (4 rows on testnet, where the DeleteKey line breaks before its URL). The tx and the time are the session file's; the absence is the chain's.
        io.out(`${sgr(caps, "bold", "BURNED")} · no such key on chain (view_access_key)`);
        const hashes = session.status === "burned" ? (session.burnTxHashes ?? []) : [];
        if (hashes.length === 0) io.out("DeleteKey tx: none recorded in the session file");
        // A testnet line is 114 cells with its label: it breaks before the URL, the second row hung under the tx (m-1 of fix round 1, C-T18d).
        for (const hash of hashes) for (const row of renderTxLineRows(hash, session.network, caps, caps.width, DELETE_KEY, " ".repeat(DELETE_KEY.length))) io.out(row);
        io.out(session.status === "burned" && session.burnedAt ? `burned at ${session.burnedAt}` : "burned at: not recorded in the session file");
        if (session.status === "live") {
          io.out("");
          io.out("local session file says live; chain has no key — the chain is the source of truth");
          io.out("");
          io.out(sgr(caps, "bold", "NEXT"));
          io.out(`  keyhole burn ${id} (records the burn locally; no transaction is sent)`);
        }
        return 0;
      }

      io.out(renderCageCard(card, "full", caps));
      if (session.status === "burned") io.out("local session file says burned; chain has the key — the chain is the source of truth");
      const account = neutralizeControls(session.accountId);
      io.out(`verify independently: RPC query, request_type view_access_key, account_id ${account}, public_key ${neutralizeControls(session.publicKey)}`);
      const explorer = EXPLORER_ADDRESS[session.network];
      if (explorer === null) io.out(`${session.network} (no explorer)`);
      else {
        const url = `${explorer}${encodeURIComponent(session.accountId)}`;
        io.out(`explorer  ${link(caps, url, url)}`);
      }
      io.out("");
      io.out(sgr(caps, "bold", "NEXT"));
      io.out(`  keyhole burn ${id}`);
      return 0;
    },
  };
  return cmd;
}

export const inspect: Command = createInspectCommand();

/** `on-account` or `sub-account`, as the headers print the mode. */
export function modeLabel(session: Pick<Session, "mode">): string {
  return session.mode === "subaccount" ? "sub-account" : "on-account";
}

/**
 * The session, or null after printing LAYOUT R5's "Unknown ID" answer on stderr: the known sessions, one per line
 * with receiver and status (exit 1 is the caller's). Any other error is thrown.
 */
export async function loadOrList(id: string, io: Io, load: typeof loadSession): Promise<Session | null> {
  try {
    return await load(id);
  } catch (e) {
    if (!(e instanceof UnknownSessionError)) throw e;
    if (e.known.length === 0) {
      io.err(e.line());
      return null;
    }
    io.err(`unknown session ${e.id} · known sessions:`);
    for (const known of e.known) {
      try {
        const s = await load(known);
        io.err(`  ${known} · ${neutralizeControls(s.receiverId)} · ${s.status}`);
      } catch {
        io.err(`  ${known} · session file unreadable`);
      }
    }
    return null;
  }
}
