## What and why

<!-- What does this change, and what problem does it solve? -->

## How I checked it

- [ ] `npm run typecheck`, `npm run lint` and `npm test` in `app/`
- [ ] `npm test -w @rayfin-app/engine` and `npm test -w @rayfin-app/functions` if I touched them
- [ ] `node --test "tools/test/*.test.mjs"` if I touched the installer or the tools
- [ ] Tried it against a tenant (say which part)

## Safety

- [ ] Nothing writes to a customer model without a snapshot and a way back
- [ ] No secrets, tenant ids or hosting URLs in the diff
- [ ] Docs and `CHANGELOG.md` updated
