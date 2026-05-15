# Release Documents

This directory contains source-controlled developer detail documents for
production releases.

The release-prep agent creates `v<version>.md` before the GitHub Actions release
workflow runs. The workflow renders the GitHub Release body from that document,
publishing only the end-user **Shipped For Users** section plus a link back to
the full document.

Required sections:

- `## Shipped For Users`
- `## Developer Details`
- `## Verification`
- `## Source Links`

See [../release-workflow.md](../release-workflow.md) for the full procedure.
