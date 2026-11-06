<!--
DESIGN.md — reference from VoltAgent collection
Source: https://github.com/VoltAgent/awesome-design-md/tree/main/design-md/hashicorp
This is a REFERENCE — not a strict spec. Adapt to project context.
See docs/DESIGN_BRIEF.md for project-specific tone direction.
-->
---
brand: hashicorp
source_url: https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/hashicorp/DESIGN.md
fetched: 2026-11-06
fetched_by: "orchestrator via curl -4, HTTP 200, ~02:30Z; verbatim local dump at docs/.scout-dumps/voltagent-hashicorp/DESIGN.md (575 lines)"
selection_reason: DESIGN_BRIEF rec
why_this_brand: "DESIGN_BRIEF section 9 rank 1 for the tone 'industrial technical-mono, the rating plate'; no brand in the collection is the event sponsor, and Design is ESTIMATED 20% (JUDGING WEIGHTS NOT PUBLISHED), so the file is used for hierarchy, restraint and limits-as-a-section. The plan/confirm model is Terraform CLI behaviour named in the brief, not content of this file."
brief_tone: "Industrial technical-mono, 'the rating plate' (DESIGN_BRIEF section 2)"
root_copy_pending: true
---
<!-- trace: idea="Keyhole — wrap any NEAR contract's methods as MCP tools behind per-session least-privilege function-call keys; hero target pack = Sputnik DAO act_proposal" | track="security + open + social" | weights="Design: ESTIMATED 20% (JUDGING WEIGHTS NOT PUBLISHED; 5 x 20% estimated, emphasis #1 Tech Impl, #2 Impact)" | source=design-ref-fetcher -->
# Design reference: hashicorp, applied to Keyhole

> **This is a reference, not a spec.** `docs/DESIGN_BRIEF.md` (approved 2026-11-06) is the source of truth for tone, palette and type. `docs/LAYOUT_SPEC.md` (now present, generated 2026-11-06) owns structure and order. This file supplies technique only, and every clash with the brief is recorded in section 3. The upstream file is not reproduced here: the verbatim copy is at `docs/.scout-dumps/voltagent-hashicorp/DESIGN.md`, and "L123" below means line 123 of that copy.

**Source labels used in this file**

| Label | Meaning |
|---|---|
| [FILE Lnn] | Stated in the upstream file at that line. |
| [BRIEF §x] | Stated in `DESIGN_BRIEF.md`. |
| [LAYOUT Rn] | Stated in `LAYOUT_SPEC.md`. |
| [TERRAFORM] | Terraform CLI behaviour, taken from the brief's §2/§5.2/§9 rationale. It is NOT in the upstream file. Details beyond what the brief says are recalled from memory and unverified in this session. |
| [PROPOSAL] | An adaptation made by this reference. No source states it, and the build may reject it. |

## 1. What the upstream file is, and is not

**It is** a 575-line analysis of hashicorp.com marketing pages: home, /infrastructure-cloud, /products/terraform, /pricing and /resources [FILE L285]. Its system:
- a dark-only canvas with a charcoal surface-lift scale instead of shadows [FILE L279, L399];
- one typeface family, hashicorpSans, with a small weight set [FILE L333, L355];
- seven per-product accent colors used as identity tokens [FILE L307-317];
- an 8px spacing base with a 96px section rhythm [FILE L367-371];
- named component variants and a closing `Known Gaps` section [FILE L569-575].

**It is not** any of the following. Each was checked against the full text:
- **Terminal, CLI or mono guidance.** It says "No mono" [FILE L357].
- **A plan, apply or confirm flow, or a resource-diff table.** Its only table component is the pricing `comparison-row` [FILE L247-251, L486-489].
- **A docs or README hierarchy.** Only marketing pages were analysed [FILE L285].
- **A status page, or error and validation states.** "Form-field error and validation styling is not visible on the inspected pages" [FILE L573].
- **Motion.** No motion or animation guidance appears anywhere.
- **Light mode or shadow tokens** [FILE L572, L574].

So three things DESIGN_BRIEF §9 expected from this brand are **not supplied by the file**: the plan/confirm interaction, the doc/README hierarchy, and status-page restraint as a documented pattern. The brief's other §9 claims, "Vault's policy, lease and revoke vocabulary" and "docs voice neutral and test-shaped", are also absent from the file and are not carried here. What the file does supply is marketing-surface discipline: hierarchy, density, component restraint and limits-as-a-section. Section 4 takes exactly that. The plan/confirm model is taken from the brief and labelled [TERRAFORM].

## 2. Fetch verification (Step 2.5 gate, run on the verbatim on-disk text)

Three WebFetch attempts returned paraphrases (its summarizer enforces a 125-character quote limit). The Contents API and directory API returned 403 (GitHub core rate limit 0 of 60). The orchestrator then fetched the file with `curl -4`, and the gate below ran on that copy.

| Check | Required | Actual (counted from the file) | Result |
|---|---|---|---|
| `##` headings | >= 8 | **11**: Overview (L266), Colors (L283), Typography (L327), Layout (L363), Elevation & Depth (L384), Shapes (L401), Components (L422), Do's and Don'ts (L507), Responsive Behavior (L529), Iteration Guide (L559), Known Gaps (L569) | PASS |
| Color-themed section | 1 | `## Colors` (L283) | PASS |
| Typography-themed section | 1 | `## Typography` (L327) | PASS |
| Distinct hex codes | >= 10 | **22**: #000000 #ffffff #2b89ff #b2b6bd #656a76 #15181e #1f232b #3b3d45 #252830 #7b42bc #911ced #ffcf25 #e62b1e #14c6cb #12b6bb #1868f2 #00ca8e #f24c53 #fbeabf #bb5a00 #101a59 #a737ff | PASS |
| Named fonts and px/rem values | present | hashicorpSans; substitutes Inter, Geist Sans, IBM Plex Sans [FILE L361]; type ladder 12-80px, spacing 1-96px, radii 4-24px | PASS |
| Shadow values | (note only) | None. "No drop shadows on dark" [FILE L399, L526]; shadow tokens undocumented [FILE L572] | n/a by design |
| Non-stub | > 50 lines | **575 lines**, front matter plus 11 sections, ending with the `Known Gaps` list | PASS |
| Not summarized or truncated | verbatim | YAML tokens plus every body section are present, and values match between front matter and prose | PASS |

Live directory: the raw VoltAgent README lists hashicorp (83 slugs counted, with warp and ollama also present). The directory API itself returned 403, so the README stands in.

## 3. Conflict reconciliation with DESIGN_BRIEF

**The brief wins every row below.** The upstream file is a dark-first marketing system, and the brief is a light, paper-and-ink plate. Nothing in the "Upstream file" column is adopted as a value.

| # | Upstream file says | DESIGN_BRIEF says | Resolution |
|---|---|---|---|
| C1 | Canvas is pure black `#000000`. "Don't ship a light-mode marketing page. HashiCorp's marketing brand IS dark" [FILE L13, L521]. "Dark mode is the only marketing mode" [FILE L574]. | Paper `#F2F0E9` surface, Ink `#111110` text [BRIEF §4]. The dark scheme of the status page is Ink and Paper swapped, with stamps keeping their fills. | **Brief.** Paper is the page. The status page's dark scheme is the brief's swap, not `#000000`. |
| C2 | Charcoal surfaces `#15181e`, `#1f232b`, `#3b3d45` and hairline `#252830` [FILE L14-17]. | Ink, Paper and Graphite `#5C5A52` only [BRIEF §4]. | **Brief.** No file hex is adopted. |
| C3 | Seven per-product accents: Terraform purple `#7b42bc`, Vault yellow `#ffcf25`, Consul red `#e62b1e`, Waypoint cyan `#14c6cb`, Vagrant blue `#1868f2`, Nomad green `#00ca8e`, Boundary coral `#f24c53` [FILE L21-29]. | Mint `#00EC97` is the PASS fill and nothing else. Fault `#B3261E` and Amber `#E8B100` are functional fills with one meaning each [BRIEF §4]. | **Brief.** Only the discipline is taken (4.4). None of the file's palette. |
| C4 | Semantic success is Nomad green `#00ca8e`, warning is Vault yellow, error is Consul red [FILE L33-35, L320-322]. Semantic and identity colors are the same tokens. | Mint (NEAR's verified green) is PASS only. RUNTIME is Amber, FAIL is Fault. | **Brief.** The file's `#00ca8e` is close to NEAR mint but is not NEAR's color. Do not substitute it. |
| C5 | Links are blue `#2b89ff`, visited links purple `#a737ff` [FILE L290-291]. | Explorer links are underline + OSC 8 with no hue in the terminal [BRIEF §4]. No purple anywhere. | **Brief.** Links are Ink and underlined, and visited links are not recolored. |
| C6 | One family, hashicorpSans. "Don't replace hashicorpSans with a display-only sans for headlines and a different family for body" [FILE L527]. "No mono" [FILE L357]. | D-DIN Condensed (headline, labels) + Atkinson Hyperlegible (body) + Iosevka Term (mono) on the page. **No font choice in the terminal** [BRIEF §3]. | **Brief.** The brief's page stack is the two-family pairing the file forbids. Only the hierarchy logic is taken (4.2). |
| C7 | The font-substitution note recommends Inter, Geist Sans or IBM Plex Sans [FILE L361]. | Inter is on the banned list [BRIEF §3]. | **Brief.** Ignore the substitution note entirely. |
| C8 | Radii 8px for buttons and inputs, 12px for cards, 24px for banners, pill chips, and "Don't square off CTA corners" [FILE L409-413, L523]. | A ruled plate with square cells. State tags are bold bracketed text such as `[LIVE]`, not pills [BRIEF §5.1]. The status page has no CTA [BRIEF §5.6]. | **Brief.** Radius 0 on the plate and stamps [PROPOSAL, consistent with the DIN plate genre]. The file's corner rule has no object to apply to. |
| C9 | Product showcase cards "lift into per-product chromatic gradients"; navy `#101a59` is used in gradients; 3D product illustrations sit in hero columns [FILE L4, L325, L397]. | "No gradients anywhere" [BRIEF §4]. | **Brief.** No gradients, no illustration. |
| C10 | Marketing components: centered hero with CTA buttons, 3-up card grids, CTA banner, customer-logo marquee, top nav, footer [FILE L426-505]. | No centered headline, no CTA; a left-aligned `act_proposal` H1 over a 12-column plate + ledger [BRIEF §5.6]. | **Brief.** None of these components is adopted. |
| C11 | Mixed treatment of depth: charcoal surface lift plus translucent hairline `rgba(178,182,189,0.1)` [FILE L280, L389]. | Flat Paper, 2px Ink frame, Ink-filled PROTOCOL cells and outlined others [BRIEF §5.6]. | **Compatible in principle** (4.3). The translucent hairline is dark-theme specific, so it is not adopted. |

**Upstream inconsistencies. Do not copy these either way.**
- The Overview says "white pill-rounded buttons" [FILE L268], the button table says "Pill / square CTA buttons" [FILE L349], and every other mention says 8px, not a pill [FILE L270, L278, L409, L523]. Treat 8px as the file's real intent, and note it is moot here.
- The front-matter description says Consul is "pink" [FILE L4], while the palette says Consul red `#e62b1e` [FILE L24, L313].
- The Overview says product cards are "not decorative gradients" [FILE L272], while the description says they lift into "chromatic gradients" [FILE L4].

**Flags outside the file** (the build should resolve these; this reference takes no side beyond noting the Terraform behaviour):
1. **Confirm wording.** The brief's `wrap` confirmation is `Sign 1 transaction with seat.testnet's full-access key? Only "yes" continues:` [BRIEF §5.2]. LAYOUT_SPEC R2 block 7 specifies `[y/N]`, default No. The Terraform model the brief names is a typed word, and `[y/N]` is lighter friction for an operation that adds a key to a full-access account. Pick one at scaffold. Either way the non-TTY behaviour in [LAYOUT R2] (prints `not signed ...`, exits 2, never blocks) holds.
2. **Plate width versus the 12-column page.** Arithmetic only, no file claim. The brief sizes the plate at 98 cells max and Iosevka Term at 0.5 em advance, so 98 x 9 = 882 px at 18px. Columns 1-8 of a ~1280px content width are about 850px. The plate does not fit at 18px. Options: render the plate at 16px (98 x 8 = 784px), widen it to columns 1-9, or use a wider container (the file's default desktop width is 1440 [FILE L535]).

## 4. Technique, mapped onto Keyhole's surfaces

### 4.1 Plan, then confirm [TERRAFORM via DESIGN_BRIEF §2, §5.2, §9; not in the file]

This is the interaction model for `wrap` and `burn`. The wording below is the brief's.

```text
[PREVIEW card, footer: "PREVIEW · nothing signed"]

+ AddKey FunctionCall → seat.testnet · receiver kh-demo.sputnik-v2.testnet · methods act_proposal · allowance 0.05 NEAR

Sign 1 transaction with seat.testnet's full-access key? Only "yes" continues:
```

- **The plan is a list of actions, one line each.** A `+` line names the key that signs it [BRIEF §5.2]. Sub-account mode lists `+ CreateAccount`, `+ Transfer`, `+ AddKey FullAccess (operator)` and `+ AddKey FunctionCall`. `burn` lists `- DeleteKey`, plus `- DeleteAccount → beneficiary` in sub-account mode.
- **Nothing is signed before the confirm line.** The card tag reads `[PREVIEW]` until then, and flips to `[BURNED]` after `burn` [BRIEF §5.1].
- **Adaptation, drop the hue.** Terraform's plan output colors `+` and `-` (recalled from memory, unverified here). The brief forbids plain-foreground green and red [BRIEF §4]. So `+` and `-` stay in the default foreground and are **bold**. The glyph carries the meaning, and a stripped log is byte-identical to the styled one [BRIEF §4].
- **Optional, unverified.** Terraform's plan ends with a one-line count of adds, changes and destroys (recalled, not checked). A one-line `1 action` summary above the confirm would echo it. Check Terraform's docs before copying any wording.

### 4.2 Hierarchy from a small weight set, a line-height contrast and a mandatory label

- **What the file does.**
  - Three weights only: 500 body, 600 emphasis, 700 display. "No light / black extremes" [FILE L355].
  - Tight display line-height (1.17-1.21) against relaxed body (1.50-1.71). "The contrast IS the brand voice" [FILE L354, L514].
  - A 12px, 600-weight, 0.6px-tracked, uppercase **eyebrow above every section**. "Skipping it makes sections read as floating" [FILE L105-110, L356, L567].
- **Terminal.** There is no font choice [BRIEF §3], so only the label idea transfers. The 11-cell UPPERCASE LABEL column and the bold beat headers [BRIEF §5.1, §5.3] are the eyebrow. Every card row and every beat has one, and nothing floats. No tracking is possible in a terminal, so none is claimed.
- **README.** The same rule applies to section headings. `## Try it`, `## Verification — negative tests`, `## Evidence`, `## How it works`, `## Limits`, `## Roadmap` and `## Disclosures` [LAYOUT R1] each open their section, and nothing sits between sections unlabelled.
- **Status page.** The type ladder below uses the file's proportions and the brief's faces.

| Role | File spec [FILE L337-350] | Keyhole face (brief §3) | Application |
|---|---|---|---|
| Hero H1 `act_proposal` | 80px / 700 / lh 1.17 / -2.5px | D-DIN Condensed Bold, ~120px [BRIEF §5.6] | Take line-height 1.17-1.21. Negative tracking is ~-3% in the file; on an already-condensed face, set 0 and only add it after checking by eye [PROPOSAL]. |
| Section label (eyebrow) | 12px / 600 / lh 1.23 / +0.6px, uppercase | D-DIN Condensed Bold, uppercase | 14px with +0.6px tracking, because a condensed face reads smaller [PROPOSAL]. Verify on a projector. |
| Hero subline (lead body) | 18px / 500 / lh 1.69 | Atkinson Hyperlegible | 18px / 1.69 [BRIEF §5.6 asks for a body-text subline]. |
| Body, evidence list | 16px / 500 / lh 1.50 | Atkinson Hyperlegible | 16px / 1.5. |
| Caption, footnote | 13px / 500 / lh 1.38 / +0.2px | Atkinson Hyperlegible | 13px minimum. |
| Plate and raw RPC bodies | none ("No mono") | Iosevka Term, 18px [BRIEF §5.6] | Brief only. The file offers nothing here. |

At most three weights in use across the page, with no light or black weights.

### 4.3 Elevation by fill step, never by shadow

- **What the file does.** Hierarchy is canvas, then surface-1, then surface-2, with a 1px border and no drop shadows [FILE L279, L386-391, L399, L526]. "Sections separate by surface lift" instead of by gaps [FILE L382].
- **Status page.** Paper is the whitespace, and there are no shadows at all. Cells have two levels: **filled** (PROTOCOL: Ink fill, Paper text) and **outlined** (everything else), inside a 2px Ink frame [BRIEF §5.6]. That is already the file's technique in a different medium. Inner cell rules are 1px. Their color is open (Ink or Graphite `#5C5A52`) [PROPOSAL].
- **Terminal.** Inverse video is the fill step. A solid block is the "lifted" level, a plain cell is the "flat" level, and there is no third level [BRIEF §4, §7].

### 4.4 One color, one meaning; the inverse treatment is reserved

- **What the file does.**
  - Accent colors are "identity tokens, not decoration". "If you reach for a product color outside its product context, the brand is drifting" [FILE L566]. Mixing two accents in one viewport is forbidden [FILE L525].
  - The inverse surface is reserved: "Inverse Canvas ... used as the surface of `button-primary` only" [FILE L300].
  - Saturated fills take dark text: "yellow needs dark text" [FILE L440].
- **Keyhole already makes the same move, so this is confirmation, not new work.**
  - Inverse video belongs to NEAR's own voice only [BRIEF §7].
  - Mint is the PASS fill only, always under Ink text [BRIEF §4].
  - Amber is RUNTIME only, under Ink text.
  - Fault is FAIL only.
- **The difference to keep.** The file reuses its identity colors as its semantic colors (C4). Keyhole keeps them separate.

### 4.5 Component restraint: one component, named state variants

- **What the file does.** It defines each component once and varies it by token: `button-primary`, `-secondary`, `-tertiary`, then `button-product-*` that "follow the same pattern" [FILE L445]. It also names each state as its own variant: `button-primary-pressed` [FILE L140], `text-input-focused` [FILE L229, L479].
- **Keyhole.** The stamp is one component with three fills (PASS Mint, RUNTIME Amber, FAIL Fault). The card state tag is one component with four named variants: `[PREVIEW]`, `[LIVE]`, `[BURNED]` and `[REPLAY]` [BRIEF §5.1]. A state is a named variant, not a prose footnote. The status page reuses the terminal's vocabulary and invents no new component.
- **No pills, no rounded chips** (C8).

### 4.6 A dense table with a fixed label column that collapses instead of scrolling

- **What the file does.** The comparison table has a fixed-width left column, `hairline-soft` row separators and muted `body-sm` text [FILE L247-251, L377, L489]. Below 768px it becomes an accordion "to avoid horizontal scroll" [FILE L538, L551].
- **Terminal.** The cage card's 3-column layout is the same structure: LABEL 11 cells, VALUE up to 58, ENFORCED BY 21 [BRIEF §5.1]. The file adds nothing to its width rules.
- **README.** The boundary table stays 3 columns with short cells [LAYOUT R1 mobile]. GitHub controls the styling.
- **Status page, narrow viewports** [PROPOSAL]. Below 768px the plate grid stacks each row as label over value, with the ENFORCED BY tag beneath, so it never needs horizontal scroll. The brief's `details/summary` ledger already works at that width.

### 4.7 Limits are a labelled section, not a footnote

- **What the file does.** It ends with a `## Known Gaps` section that lists what the spec does *not* cover: shadow tokens, form-error styling, light mode, variants referenced in prose only [FILE L569-575]. Its `Do's and Don'ts` pair each prohibition with a reason [FILE L519-527].
- **README.** `## Limits` [LAYOUT R1 section 5] is the Known Gaps equivalent. It states the PRD WON'T HAVE list in plain words: no value cap; the key limits the method, not the vote; no protocol expiry; testnet only. It stays its own heading and does not move into Roadmap or Disclosures.
- **Terminal.** The same idea appears twice, and the brief already has it. The VOTE card row is the "limit as a row" [BRIEF §5.1]. The EXPOSURE block in `wrap` is the "limit as a block" [LAYOUT R2 block 5].
- **Copy rules** [BRIEF §5.8] are the Keyhole version of paired Do's and Don'ts: "Never write / Write instead".

### 4.8 Spacing scale, for the status page only

The file's scale [FILE L367-371]: 1, 4, 8, 12, 16, 24, 32, 48 and 96px, on an 8px base. Section rhythm is 96px. Card padding is 24, 32 and 48px. The file does not specify mobile section gaps; it specifies only gutters (48px down to 24px) and display type scaling (80px to ~36px) [FILE L375, L539].
- Use the same token set in the page CSS [PROPOSAL]: plate cell padding 4/8, ledger item gap 24, plate-to-ledger gutter 32, section gap 96 on desktop.
- The terminal has no spacing scale. Its rhythm is one full-width rule per beat and the 100x30 budget [BRIEF §3, §5.3].

## 5. Demo-critical techniques (Step 4b, read against PRD §8)

Five techniques: four from the file, plus the Terraform plan/confirm model from the brief, labelled separately.

| # | Technique | Source | PRD §8 beat it serves | Surface |
|---|---|---|---|---|
| 1 | Plan, then confirm: `+` lines, the card tagged `[PREVIEW]`, nothing signed until the confirm line | [TERRAFORM] via BRIEF §5.2, not the file | **0-12 s**: `wrap` shows the cage card, then the confirm | `keyhole wrap` terminal |
| 2 | Limits as a labelled row or block: the VOTE row, the EXPOSURE block and the README `## Limits` | [FILE L569-575] `Known Gaps` | **0-12 s** (the card), and **80-90 s**: "the key limits the method, not the vote" | card VOTE row, `wrap` EXPOSURE, README |
| 3 | One color, one meaning, and an inverse treatment reserved for one use | [FILE L300, L566] | **35-65 s**: each `PASS: refused by protocol (...)` stamp is Mint under Ink, and the variant name is the lone solid inverse block | refusal block, status-page ledger |
| 4 | Fill-step elevation, with no shadows or gradients | [FILE L279, L386-391, L526] | **0-12 s** and **65-80 s**: the solid PROTOCOL column against plain rows is the whole "cage" read | cage card, `inspect`, status-page plate |
| 5 | A mandatory label above every section, plus a tight-display / relaxed-body line-height contrast | [FILE L354-356, L567] | **35-65 s**: the beat headers and the video rail's `3/5` index and caption stay legible at phone width | beat headers, video rail, status-page H1 |

`docs/PRD.md` exists, so this pass was not skipped.

## 6. Self-check (Step 6)

- [x] `docs/DESIGN_REF.md` opens with the provenance frontmatter, then the trace header. No literal `<placeholder>` remains: brand, source_url, why_this_brand and root_copy_pending are all filled.
- [x] The Step 2.5 gate ran on the verbatim file. The counts are real and were counted from the text: 11 `##` headings, 22 hex codes, 575 lines. `## Colors` and `## Typography` were found (section 2).
- [x] `why_this_brand` traces to DESIGN_BRIEF §9 rank 1 and §2 tone. HACKATHON_BRIEF has no sponsor brand in the collection, so the sponsor overlay did not apply. The Design criterion is quoted: "Is the user experience and design of the project well thought out?", ESTIMATED 20%, behind emphasis #1 Tech Impl and #2 Impact (JUDGING WEIGHTS NOT PUBLISHED).
- [x] The herd-pick guardrail does not apply: hashicorp is not stripe, linear.app, vercel or notion.
- [x] `root_copy_pending: true`, because `package.json` does not exist yet. **scaffold-mvp MUST copy `docs/DESIGN_REF.md` to `./DESIGN.md` after scaffolding**, with the note block from the agent spec. This file is the Keyhole adaptation, not the raw upstream file.
- [x] Conflicts with DESIGN_BRIEF are recorded: 11 clashes in section 3 (C1-C11), 3 upstream inconsistencies, and 2 flags outside the file. The brief wins every clash.
- [x] Nothing in this file was invented to fill a gap in the upstream file. The things the file lacks are listed in section 1. The plan/confirm model is attributed to the brief and Terraform's CLI, with a note on what is recalled and unverified.

**What will lose us points:** this anchor adds almost no new concrete values for Keyhole's real surfaces. The upstream file documents a dark marketing site and says nothing about terminal output, plan/confirm, READMEs or status pages. So Design (ESTIMATED 20%, scored 3/5 by the critic) still rests entirely on the brief's cage card and on MH3 landing; if MH3 slips, Design falls back to a JSON dump regardless of this reference. JUDGING WEIGHTS NOT PUBLISHED, so the polish budget here is a guess. A second, smaller risk is the unresolved `yes` versus `[y/N]` confirm mismatch between the brief and LAYOUT_SPEC (section 3, flag 1): it could ship a lighter confirm than the Terraform model the brief cites.

## 7. Handoff

`frontend-design` has four context files: `docs/DESIGN_BRIEF.md` (source of truth), this file, `docs/LAYOUT_SPEC.md` (present), and `demo/fixtures/*.json` + `demo/transcript.md` (verbatim RPC responses, which replace `src/lib/*` for Keyhole [BRIEF §10]). Before using the plate on the status page, resolve the two flags in section 3.
