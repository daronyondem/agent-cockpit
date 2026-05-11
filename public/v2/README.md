# Retired V2 Browser-Babel Shell

This directory is not the runtime source for the V2 web app anymore.

Express serves `/v2/` from the Vite build output in `public/v2-built/`,
generated from `web/AgentCockpitWeb/`.

The old Browser-Babel implementation has been removed from this tree. Only tiny
placeholder files remain for paths referenced by historical ADR `affects`
frontmatter, so `npm run adr:lint` can keep validating those immutable records.
Make all product changes under `web/AgentCockpitWeb/`.
