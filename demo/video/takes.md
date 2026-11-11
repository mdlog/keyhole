# Keyhole video: shot list

Status: recorded on 2026-11-11 (Task 21b), captions revised the same day (fix rounds 1 and 2). The captures, the render pipeline and its inputs (`~/keyhole-video/render/`) and the rendered video live outside the repo, in `~/keyhole-video/`.

The video is at most 90 s and follows PRD §8. Every take is a real terminal capture of the commands below; the only stills are the near-mcp README lines (Take A) and the README end card (Take E).

## Fixed ids

These come from the Task 15 state, read through the program's own loader:

```
KEYHOLE_OPERATOR=kh-op-021e.testnet npm run bootstrap:testnet -- --check
```

On 2026-11-06 it printed DAO `kh-2c19.sputnik-v2.testnet`, council [seat, cosigner], 2-of-2.

| Role | Account |
|---|---|
| operator | `kh-op-021e.testnet` |
| DAO | `kh-2c19.sputnik-v2.testnet` (sputnik-v2 code `ZGdM2TFdQpcXrxPxvq25514EViyi9xBSboetDiB3Uiq`, bond 0.1 NEAR) |
| seat (the agent's account) | `seat.kh-op-021e.testnet` |
| cosigner (the scripted second vote) | `cosigner.kh-op-021e.testnet` |
| grantee (paid by the payout) | `grantee.kh-op-021e.testnet` |

Two placeholders are filled while recording:
- `<A>` is the session id that Take A's wrap prints (`session ks-XXXX · live · …`).
- `<id>` is the payout id that Take B's `--proposals` prints (`proposal #N (grant payout) · …`).

**The judging session is `ks-70aa`** (`demo/judging-session.json`). No take uses it, and it is never burned before 2026-11-25. Take D burns `<A>` only.

## Before recording (once)

1. Check the balances. On 2026-11-06 the operator had 3.41 NEAR, the cosigner 0.899 and the seat 0.499.
   - The cosigner pays 0.2 NEAR of bonds per `--proposals` and per testnet demo run. The payout's bond comes back when the payout is approved; the injected proposal's bond stays locked until that proposal expires (168 h).
   - `--proposals` refuses, and signs nothing, unless the cosigner holds 0.4 NEAR: two bonds plus 100 TGas of prepaid gas for each send.
   - The seat pays the gas of each wrap and burn (about 0.00004 NEAR each, as measured on the judging wrap).
   - One `demo --testnet` run cost 0.1015 NEAR in Task 16.
2. Make the output folder, outside the repo: `mkdir -p ~/keyhole-video/take-b ~/keyhole-video/take-c`.
3. Capture the Take A still before any recording. It is never loaded live on camera. The 2026-11-11 still is an element clip of the "Security Considerations" section of `https://github.com/nearai/near-mcp`, taken with Playwright and Chrome (`channel: "chrome"`) and scaled to 1236 px wide. A 3 px Ink outline is added around the two quoted bullets, and the video's chip says "(outline added)":

   ```
   cd ~/keyhole-video/render/node && node still-nearmcp.mjs ../stills/near-mcp-section.png
   ```

   (`render/node/` keeps `package.json` and `package-lock.json` but not `node_modules`: install them first.) Confirm that the PNG shows the two README lines PRD §1 quotes: "Account private keys are stored in a local unencrypted keystore", and `import_account` ("allows the model to import an account from a private key"). If they are below the fold, capture the README section that holds them (the glama mirror, `https://glama.ai/mcp/servers/@nearai/near-mcp`, also carries them).
4. Set up the terminal:
   - exactly 100 columns × 30 rows (`stty size` prints `30 100`);
   - the "Keyhole Paper" theme (DESIGN_BRIEF §4): background Paper `#F2F0E9`, foreground Ink `#111110`, ANSI 0 Ink, 1 Fault `#B3261E`, 2 Mint `#00EC97`, 3 Amber `#E8B100`, 15 Paper, and every other slot Ink;
   - a UTF-8 locale, so the box glyphs and arrows render.
5. Use this shell for every take:

   ```
   cd ~/Project-MDlabs/near/project-b/keyhole
   export FORCE_COLOR=1 KEYHOLE_OPERATOR=kh-op-021e.testnet LANG=en_US.UTF-8
   unset NO_COLOR KEYHOLE_ASCII KEYHOLE_DEMO_OUT
   ```
6. Keep a byte copy of the frozen evidence from before the first take, outside the repo, as the base for the check after every take (see "Frozen evidence" below):

   ```
   mkdir -p ~/keyhole-video/demo-base && cp -a demo/. ~/keyhole-video/demo-base/
   ```
7. Rehearse every take before you record it (mandatory). See the next section.

Every capture line below uses `npm run --silent keyhole -- …`. That is the same command as `npm run keyhole -- …` without npm's 4-line banner. The banner would push the top of Take A's 29-row preview (header, card title) off the 30-row frame.

## Rehearse and check (before every take, and after it)

Nothing on screen may show the home directory, the user name, or the Claude Code account's email or name. Run each take's rehearsal once, captured the same way into `~/keyhole-video/rehearse-<take>.typescript`, then check that file. A rehearsal signs nothing.

| Take | Rehearsal (signs nothing) |
|---|---|
| A | the take's own command; answer `no` at the typed prompt (wrap prints that nothing was signed and exits 1) |
| B1, B3 | `npm run --silent stage:testnet -- --covote 99999999`: it loads the state, verifies the DAO, finds no proposal #99999999 and exits 2 before any send |
| B2 | the take's own `claude` command, from the same folder; check the welcome box and `/mcp`, prompt only `List the proposals of the DAO.`, then `/exit`. Never ask it to vote |
| C | `npm run --silent keyhole -- demo --sandbox --step` (the same printer; no testnet) |
| D | `npm run --silent keyhole -- inspect <A>` only (`inspect` is read-only) |

The check, on the rehearsal file and again on the real take's file right after recording:

```
f=~/keyhole-video/rehearse-b2.typescript   # or the take's own file
s=$(mktemp)   # the file with every escape sequence removed: CSI, OSC, charset and keypad modes
perl -pe 's/\e\[[0-?]*[ -\/]*[@-~]//g; s/\e\][^\a\e]*(?:\a|\e\\)//g; s/\e[()][0-9A-Za-z]//g; s/\e[=>78NOM]//g' "$f" > "$s"
grep -c "/home/" "$s"; grep -ci "$USER" "$s"; grep -ciE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' "$s"; grep -ci -e '<your display name>' "$s"
```

- Strip the escape sequences first, as above. A colored or redrawn word carries escape codes between its letters, and a grep on the raw file misses it.
- The email pattern is generic: it finds any address, not only the account's.
- Every count must be `0`. One exception: Take A's real capture holds NEXT's `attach:` line, which prints the repo's absolute path, so it trips both the `/home/` grep and the `$USER` grep. Run `grep -n "/home/" "$s"; grep -ni "$USER" "$s"` and check that every hit of either grep is on the `attach:` line or below it, after the cut line (step 4 of Take A).
- Also replay the file (`scriptreplay -t <take>.timing <take>.typescript`) and watch it. A redraw can split a path with escape codes, and grep would miss it.
- If a check fails in a rehearsal, fix the cause before recording. If it fails on a real take, cut the clip before the line, or re-shoot. Re-shoot only a take that spends nothing, or when the balances in step 1 still cover it. Take D cannot be re-shot once `<A>` is burned.

### Frozen evidence (after every take, rehearsals included)

No take may change the committed Task 16 evidence. After every take, compare it byte for byte with the base copy from step 6 of the setup:

```
b=~/keyhole-video/demo-base
for f in transcript.md run.testnet.json run.sandbox.json transcript.sandbox.md capture.sandbox.md judging-session.json status.html; do cmp "$b/$f" "demo/$f" || echo "CHANGED demo/$f"; done
diff -r "$b/fixtures" demo/fixtures && echo "fixtures identical"
```

Every `cmp` must print nothing, and `diff -r` must print `fixtures identical`. Take C is the take that could break this: without `KEYHOLE_DEMO_OUT`, a testnet demo writes its evidence into the repo's `demo/`. If anything differs, stop: restore the file from the base copy and find out which command wrote it before the next take.

## The takes

| Take | Time | What is on screen | Captured as |
|---|---|---|---|
| A | 0–12 s | the near-mcp README still, then `wrap` up to the typed prompt and `yes` | `render/stills/near-mcp-section.png`, `take-a.typescript` |
| B | 12–35 s | `stage:testnet --proposals`; Claude Code over MCP lists the proposals and votes on the payout; `stage:testnet --covote` | `take-b1`, `take-b2`, `take-b3` `.typescript` |
| C | 35–65 s | `demo --testnet --step`, beat 3/5, inside the 100×30 frame | `take-c.typescript` |
| D | 65–80 s | `inspect <A>`, then `burn <A>` | `take-d.typescript` |
| E | 80–90 s | the top of the README as the end card | rendered from `README.md` lines 1–13 (no capture) |

Each take is captured with `script -q -T TAKE.timing -c 'CMD' TAKE.typescript` into `~/keyhole-video/`, after its rehearsal, and checked as above right after. `script` writes the command into the file's first line, so the commands use `~` or `$HOME` inside the quotes, never an expanded path.

### Take A (0–12 s): the hook and the wrap

```
script -q -T ~/keyhole-video/take-a.timing -c 'npm run --silent keyhole -- wrap kh-2c19.sputnik-v2.testnet --allow act_proposal --gas 0.05N --on-account seat.kh-op-021e.testnet' ~/keyhole-video/take-a.typescript
```

1. Hold on the PREVIEW cage card until the typed prompt, `Sign 1 transaction with seat.kh-op-021e.testnet's full-access key? Only "yes" continues:`.
2. Type `yes`.
3. Write down the session id it prints: that id is `<A>`.
4. Cut the clip at the `key … · function-call key on seat.kh-op-021e.testnet` line, before the NEXT block. NEXT's `attach:` line prints the repo's absolute path, which names the home directory and the user.

Caption: "Keyhole gives the agent one key that the NEAR protocol limits."

### Take B (12–35 s): a real agent over MCP. Needs the user's Claude Code login.

**This take needs the user's own Claude Code login on camera.** Use plain `claude`, not one of the gateway wrappers.

1. Add the proposals as the cosigner. Write down the payout id: that id is `<id>`. The injected proposal is `<id>+1`.

   ```
   script -q -T ~/keyhole-video/take-b1.timing -c 'npm run --silent stage:testnet -- --proposals' ~/keyhole-video/take-b1.typescript
   ```

   It ends with `cosigner adds proposal #<id> (grant payout) and #<id+1> (injected description) · bond 0.1000 NEAR each`.

   `--proposals` reuses the demo's payout text (`Grant payout: 0.0100 NEAR to grantee… for milestone 1 (docs translation).`), so on this DAO `#<id>` is a word-for-word copy of the demo's approved payout #0. An agent may flag it as a double payment: the 2026-11-11 agent did. The video keeps that warning on screen, and the rail says the flag is advice and that the council's votes decide. For a re-shoot, consider a payout text that is unique per run.
2. Point Claude Code at Take A's session with a config file passed on the command line, never a project `.mcp.json`. Claude Code 2.1.319 heads a project server in `/mcp` with the file's full path (`/home/<user>/…/.mcp.json`). A server from `--mcp-config` (dynamic scope) is listed under the heading "Built-in MCPs (always available)", with no path; 2.1.322 shows the same heading. Write the file from `examples/claude-code.mcp.json` with this repo's absolute path and `<A>` (run this in the repo shell):

   ```
   node -e 'const c=require("./examples/claude-code.mcp.json").mcpServers;c.keyhole.args=[process.cwd()+"/bin/keyhole.mjs","serve",process.argv[1]];require("fs").writeFileSync(process.env.HOME+"/keyhole-video/take-b/keyhole.mcp.json",JSON.stringify({mcpServers:c},null,2)+"\n")' <A>
   mkdir -p /tmp/kh-take-b && cd /tmp/kh-take-b
   script -q -T ~/keyhole-video/take-b2.timing -c 'claude --settings '"'"'{"theme":"light"}'"'"' --no-chrome --permission-mode default --mcp-config "$HOME/keyhole-video/take-b/keyhole.mcp.json" --strict-mcp-config --allowedTools "mcp__keyhole__dao_list_proposals,mcp__keyhole__dao_get_policy,mcp__keyhole__keyhole_inspect"' ~/keyhole-video/take-b2.typescript
   ```

   - The folder is an empty one outside home, because Claude Code's welcome box shows the working folder.
   - `--strict-mcp-config` loads only `keyhole`. The user's other MCP servers do not load and are not listed, and nothing is written to their config. With it, no claude.ai connector is listed either (checked in the 2.1.322 rehearsal), so `ENABLE_CLAUDEAI_MCP_SERVERS=false` is not needed. If a connector does show in the rehearsal, put `ENABLE_CLAUDEAI_MCP_SERVERS=false` in front of `claude` inside the quotes.
   - `--no-chrome` drops the built-in `claude-in-chrome` server, which `/mcp` otherwise lists above `keyhole` with its own 20 tools. `/mcp` then reads `1 server`, `Built-in MCPs (always available)`, `keyhole 5 tools`.
   - `--permission-mode default` keeps the `dao_vote` permission prompt on camera when the account's default mode is auto mode, which can approve the call without asking.
   - `--settings '{"theme":"light"}'` sets the light theme for this session only, to match the Paper background; nothing is written to the user's settings.
   - Rehearse this exact command first (see Rehearse and check). The rehearsal also clears the first-start dialogs, so they are not in the take. A new folder asks once whether to trust it: answer yes in the rehearsal. In 2.1.322 the dialog's cursor starts on "No, exit", so press Down, then Enter.
3. What appears on camera, and how to handle it:
   - **No approval dialog for the server.** That dialog is for a project `.mcp.json`. A `--mcp-config` server loads without one. If one appears in the rehearsal anyway, approve it there.
   - **Permission prompts for tool calls.** `--allowedTools` pre-approves the three read tools: `dao_list_proposals`, `dao_get_policy` and `keyhole_inspect`. `dao_vote` still asks once, on camera, with the proposal id and the action. Answer `Yes` (the first option), not the "don't ask again" option, which writes a settings file into the folder. Confirm the exact tool names in the rehearsal: `/mcp` lists them, and Claude Code names them `mcp__keyhole__<tool>`.
   - **The welcome box.** If it shows the account's email or name, cut or crop it out of the clip; the check above finds it.
4. In Claude Code:
   - `/mcp` shows the `keyhole` server with 5 tools: `keyhole_inspect`, `dao_list_proposals`, `dao_get_policy`, `dao_vote`, `keyhole_attempt`. Do not open the server's detail view on camera: it shows the command's absolute path.
   - Prompt: `List the proposals of the DAO, then approve proposal #<id>, the grant payout.`
   - The agent lists the proposals. The description of `#<id+1>` carries the injected instruction. The agent votes to approve `#<id>`, and the reply carries the tx hash and the approval count. The wording varies by run: on 2026-11-11 the reply said "it now has 1 of the 2 council approvals it needs", and its table said `InProgress (now 1/2 approvals)`.
5. Go back to the repo shell (step 5 of the setup), then cast the scripted second vote:

   ```
   script -q -T ~/keyhole-video/take-b3.timing -c 'npm run --silent stage:testnet -- --covote <id>' ~/keyhole-video/take-b3.typescript
   ```

   It ends with `proposal #<id> Approved · payout executed`. It refuses, and signs nothing, if `<id>` is not the grant payout or if the agent has not voted yet.

Caption: "2/5 IN SCOPE · the key votes; the quorum decides"

### Take C (35–65 s): assume the injection works

`KEYHOLE_DEMO_OUT` sends this run's evidence to `~/keyhole-video/take-c/demo/`. Without it, the run would overwrite the committed Task 16 evidence (`demo/transcript.md`, `demo/run.testnet.json`, `demo/fixtures/testnet.*`).

```
script -q -T ~/keyhole-video/take-c.timing -c 'KEYHOLE_DEMO_OUT=$HOME/keyhole-video/take-c npm run --silent keyhole -- demo --testnet --step' ~/keyhole-video/take-c.typescript
```

1. Press Enter at each beat boundary. Each beat starts on the top row.
2. The clip is beat 3/5: four refusal groups, the caption line, the chain check. It fits the 100×30 frame (`test/transcript.test.ts` R18b, 26 rows on the Task 16 bodies).
3. The WRAP beat (1/5) fits as well: its card's key line breaks before ` on ` (C-T16a).

This run wraps and burns its own session on the seat. It never touches `<A>` or `ks-70aa`. The video's 3/5 clip opens for 3.2 s on this run's own 1/5 wrap lines, which print `session ks-03bb` (2026-11-11), and its rail names that session, so its allowance is not read as `<A>`'s.

The public RPC `https://rpc.testnet.near.org` can answer HTTP 429 in the middle of a run (it did on 2026-11-11 at step [10]. Steps [11] to [13] then failed on 429s for their RPC queries; [13], the burn, did not delete the key, and [14] printed `not sent: the burn [13] did not finish, so the key may still be on chain`. The run ended `9/14 PASS · 5 FAIL`, and its session `ks-5683` stayed live). The 2026-11-11 takes C and D were recorded against another public endpoint, which Keyhole reads from `KEYHOLE_TESTNET_RPC`; the demo header then prints that origin:

```
script -q -T ~/keyhole-video/take-c.timing -c 'KEYHOLE_TESTNET_RPC=https://rpc.testnet.fastnear.com KEYHOLE_DEMO_OUT=$HOME/keyhole-video/take-c npm run --silent keyhole -- demo --testnet --step' ~/keyhole-video/take-c.typescript
```

If a run fails with a 429 anyway, the run's last lines name the live session: burn it before the next take, with the override so the burn does not hit the 429 again: `KEYHOLE_TESTNET_RPC=https://rpc.testnet.fastnear.com npm run keyhole -- burn ks-XXXX`. README step 3 carries the same RPC note.

`ks-5683` was burned by the controller (2026-11-11 01:29:25Z, DeleteKey tx `7x8V3JH5umxhMvm7YBTuLkzpYdtTEgVkhKGjVZMww84V`, final). `inspect ks-5683` now prints `BURNED · no such key on chain`.

Fallback: the sandbox take, `npm run --silent keyhole -- demo --sandbox --step` (no testnet).

Caption: "rejected at validation — never in a block; the RPC response is the evidence"

### Take D (65–80 s): inspect and burn

```
script -q -T ~/keyhole-video/take-d.timing -c 'npm run --silent keyhole -- inspect <A> && npm run --silent keyhole -- burn <A>' ~/keyhole-video/take-d.typescript
```

The 2026-11-11 take ran the same two commands with `KEYHOLE_TESTNET_RPC=https://rpc.testnet.fastnear.com` in front of each (see Take C), and `sleep 4` between them so the `[LIVE]` card holds on screen before the burn.

1. `inspect` shows the card read from chain, tagged `[LIVE]`, with the allowance Take B's vote left.
2. `burn` sends the `DeleteKey`, then proves it with the same key: `PASS: refused by protocol (AccessKeyNotFound)`.

Never put `ks-70aa` in this take.

Caption: "5/5 BURN · DeleteKey, then the same key again"

### Take E (80–90 s): the end card

The top of the README (Task 20) as a still. The repo was private on 2026-11-11, so the end card is not a screenshot: the render draws `README.md` lines 1–13, through `marked` with GitHub-like CSS, inside the video frame (`render/node/edl.mjs`, segment E), and the chip says "keyhole README.md, lines 1–13". Line 14, which holds the `X_POST_URL` / `VIDEO_URL` placeholders, is left out. Once the repo is public, a screenshot of its URL can replace the render:

```
google-chrome --headless=new --hide-scrollbars --window-size=1300,936 --screenshot="$HOME/keyhole-video/take-e-readme.png" '<the repo README URL>'
```

In the video the caption is split over two 4.5 s cards: "No contract to audit. The key limits the method, not the vote.", then "2-of-2 is the control." with the `npm run keyhole -- demo --sandbox` box.

Caption: "No contract to audit. The key limits the method, not the vote, and 2-of-2 is the control. `npm run keyhole -- demo --sandbox`"

## Render

Render with the **making-demo-videos** skill pipeline. The 2026-11-11 pipeline and its inputs (stills, fonts, `timeline.json`, `site/frame.html`, `node/*.mjs`) are kept in `~/keyhole-video/render/`, without `node_modules`; `node/edl.mjs` is the edit and the rail text, and `node/render.mjs` renders it:
- The terminal is xterm.js in Chrome, driven by Playwright with `channel: "chrome"`. The bundled Chromium build is missing on this machine.
- It replays each `.typescript` file with its `.timing` file.

| Element | Setting |
|---|---|
| frame | 1920×1080 |
| terminal grid | 100×30, Iosevka Term 26 px, at x 64, y 72. Rows are 31 px (1300×930): xterm.js refuses a `lineHeight` below 1, so the font's `@font-face` ascent and descent are overridden to 96 % and 24 % with `lineHeight` 1 |
| top strip | `keyhole · NEAR testnet` and `real terminal captures, 2026-11-11 · waits shortened, screens held for reading`, on every frame |
| right rail | x 1400–1856; the beat index (`3/5`) in D-DIN Condensed Bold 120 px; the caption at 56 px, at most 4 lines |
| captions | appear on their beat's first frame and hold at least 3 s |
| tally (Take C) | `REFUSED BY PROTOCOL 1/4 … 4/4`, stepping up on the frame where each stamp lands in the real output |
| cuts | hard cuts only: no zoom, pan or transition |
| overlap | nothing ever overlaps the terminal grid |

## Export

H.264 High, 30 fps, at least 8 Mbps, yuv420p tagged BT.709. Re-encode if the pipeline emits yuvj420p:

```
ffmpeg -i ~/keyhole-video/render.mp4 -c:v libx264 -profile:v high -r 30 -b:v 8M -maxrate 10M -bufsize 16M -pix_fmt yuv420p -color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709 -movflags +faststart ~/keyhole-video/keyhole-demo.mp4
```

Then check:
- `ffprobe -v error -show_entries format=duration -of csv=p=0 ~/keyhole-video/keyhole-demo.mp4` prints at most `90.0`;
- `ls -l ~/keyhole-video/*.mp4` lists the one final file.
