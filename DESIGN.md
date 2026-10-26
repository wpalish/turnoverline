# TurnoverLine design contract · 26 October 2026

Current direction: **Warm dispatch handoff ledger**. This replaces the former shared public-register visual tokens for this increment. The ten-product pre-release contract and actual module.js fields govern content; the SabaqLoop editorial design is not a template for this product.

## Screen job and composition

The default section is preparation. Real tasks are grouped by their source stay, ordered by checkout, and displayed between the saved checkout and the next non-cancelled arrival. Property instructions are expandable in that context. Each task shows the actual saved open/done mark, assignee and deadline. The stays view presents the same handoff context, including stays without tasks. Properties expose instructions and the count of stays outside the archive.

The next stay uses the same property, non-cancelled status and start >= checkout, including archived occupied history as module.js does. A missing next stay is described as not scheduled. Tasks are actual saved records, and a done mark does not establish property readiness or automatic check-in.

## Visual system

Pine operations header, warm mineral page, ivory task sheets and restrained clay actions. Trebuchet/Segoe type separates it from the native member library and technical agenda.

The normative semantic palette is the product-specific `:root` at the end of public/styles.css. Shared semantic roles are `--label`, `--label-secondary`, `--bg`, `--surface`, `--accent`, `--accent-hover`, `--accent-wash`, `--separator`, `--field-border`, `--focus`, `--error` and `--error-ground`. Spacing uses a 4px base and 8px multiples. Large titles tighten tracking, small supporting text keeps a relaxed line height, and numeric balances/times use tabular digits. Body text is 16px by browser default. Supporting labels never replace field labels. There are no custom font downloads, paid assets, gradients, ornamental charts, fake KPIs or integration badges.

The apple-design and frontend-ui-engineering skill guidance informs semantic roles, optical typography, clear interaction states and restrained surfaces. Existing product fields/code are the available reference evidence; no new approved visual comp or external reference catalogue was supplied. Layout and palette are implementation choices subject to browser review. System fonts require no bundled font license.

## Responsive and interaction rules

Handoff windows have two columns on desktop and a continuous reading order at mobile. Task status, work and open action stack at 390px. All datetime strings wrap safely. Navigation scrolls within its own strip. No horizontal timeline or decorative occupancy chart is required to do the task.

Buttons, inputs, selects and disclosure summaries have a minimum 44px interaction height. Every control uses visible keyboard focus. Search and archive operate on the same saved collections as before. Zero-data and no-match states preserve dependency links/create actions and clear-filter recovery. Pending actions disable their initiating control, show a waiting label and expose `aria-busy`. Errors remain focused and visible without discarding the edited form. The edit heading receives focus when opened. No modal, animation library or new dependency is introduced. Reduced motion removes active translation; contrast preference strengthens dividers and secondary ink. This increment is designed as a light workspace.

The calculated-data summary is a disclosure after the primary view, preserving the original server summary without duplicating it as a dashboard. Supporting collections may retain contained, labelled tables. All domain values are inserted through `textContent`, native options or existing safe form controls. Server authentication, roles, CSRF, revision checks, archival rules and backups stay in the existing command path.

## Implementation and evidence

public/product-view.js renders handoff groups, tasks, stays, property instructions and editor context. public/app.js defaults to preparation and preserves command behavior. public/styles.css owns the dispatch composition.

The bundled Node 24.19.0 suite passes 8/8; 1 regression test for the next-stay window: ignore other properties/cancelled/earlier stays, retain archived occupied history, handle no next stay. JS syntax and whitespace checks pass. This documents implementation and automated evidence. Responsive rendering, interaction quality, screen-reader behavior and contrast across actual rendered states remain pending browser QA. Historical screenshots in docs/ and .impeccable/ do not show this increment. See PRE_RELEASE.md.

The editor captures the workspace revision when opened; save and archive submit that captured revision. A validation or revision-conflict failure keeps typed fields and focuses the error notice. Initial network failures replace the loading state with a retry action.

## Task priority

Live open handoffs lead by earliest deadline, then checkout. Completed and archived-only groups follow under a labelled history disclosure; matching historical data remains accessible.
