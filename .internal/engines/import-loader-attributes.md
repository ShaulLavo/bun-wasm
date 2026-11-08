# Text import correction

Status: Approved, implementation in progress. Engines owns review and landing.

Runtime file preparation lowers static text requests to process-owned tokens. Resolved text files receive separate module names and generated string-only ESM exports. Ordinary HTMLBundle, CommonJS resolution and the Engine interface stay unchanged.

This change owns shared runtime loading, the transpiler and CLI adapter, browser import loading hooks, the narrow Bun direct re-export metadata patch, and feature-owned controls. It does not own preview routing, engine C++, shared memory, framework templates, or dependency versions.

Generated Function/eval/vm and require-of-ESM paths are outside this file-import acceptance claim. The implementation checkpoint and runnable commands live in the Engines report, not in public documentation.
