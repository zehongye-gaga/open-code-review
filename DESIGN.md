# Review Observatory dashboard

The operator must see review activity, attention needs, token usage and timing before scrolling through audit records. Preserve all existing repository filters, period controls, drill-down dialogs, historical data and resource views. This is a read-only operational dashboard; visual changes must not dispatch reviews or change accounting.

## Selected direction

User selected direction A (dark monitoring dashboard) on 2026-10-30. Use a compact metric strip, prominent analytical trends, work queue, then audit and repository detail. Keep service health separate from review findings: a finding is not an infrastructure outage. All numbers come from existing APIs, and all existing scope/retention caveats remain visible.

## Visual system

- Canvas #0c141d; panels #121e2a; dividers #293847; primary text #e4edf5; secondary text #a1b1c2.
- Mint #78d0c2 for quantitative charts and normal state, blue #80b7e8 for navigation, amber for retry/warning, rose for execution failure and blocking findings (always accompanied by text).
- System Chinese sans-serif; tabular numbers and monospace commit IDs. 28px page title, 16px section headers, 13px tables, 12px supporting labels, 38px primary metrics.
- 22px section gaps, 22px panel padding, 10px panel radius, 6px controls. Flat surfaces without glow or decorative images.
- Adapted Linear DNA: dark layered surfaces, restrained thin dividers, compact numeric typography, one subdued interaction accent. Carbon informs metric scopes, zero-baseline charts, table alternatives and error states; neither brand is copied.
- Desktop analytics uses six metrics and a 2.3:1 trend/phase split. At 1200px metrics use three columns; at 800px charts stack; at 520px metrics use two columns and work cards one column. Wide tables scroll inside their containers.
- Short control feedback only; respect prefers-reduced-motion. Never animate periodic data refreshes.

## Behavior and verification

Normal status does not occupy a persistent notice banner. Loading, disconnection and stale source warnings remain visible. No fabricated comparison deltas, costs or totals. Trend bars start at zero and have descriptive labels plus a keyboard-accessible data table. Native selects and details preserve keyboard navigation; links provide direct section navigation. Validate loaded data, empty/error states, repository filtering, period changes, detail dialog and narrow layouts with the real page before delivery.
