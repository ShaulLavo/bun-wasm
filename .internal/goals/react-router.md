# React Router goals

Status: Approved. Implementation complete. All six Chrome and Firefox cells pass every phase.

The goals runner used a mounted preview URL. React Router's server rendered `/`, but its browser router saw `/__preview/5173/`. Hydration replaced the page with a route error. The favicon error was incidental and is not suppressed.

React Router acceptance now selects the existing root-origin preview adapter. Each cell allocates a free loopback guest port. The template's production launcher honors `PORT`, and readiness and cleanup observe that port. Other framework preview policies are unchanged.

Desktop Firefox also inherited WebKit's 32 KiB QuickJS stack budget. It now retains QuickJS's guarded 152 KiB default. Its JSC budget and the WebKit, mobile Firefox and unknown-host budgets are unchanged. Fifty cold-context recursion controls and both stack-overflow fixtures pass at 152 KiB or the 190 KiB safety margin.

Focused regression tests were committed before each fix. Before the Firefox policy fix, the actual goals runner passed five cells and reproduced the QuickJS dev failure in Firefox. The final campaign passes all six cells with same-document hot reload. Independent review identified an overly broad mobile Firefox match and missing NodeNext import extensions. Both are corrected with regression coverage. Merge remains gated on CI.

Evidence and rerunnable preparation and diagnostic scripts are in `/work/reports/goals/react-router/worker/`. Generated goals tables are never edited by hand.
