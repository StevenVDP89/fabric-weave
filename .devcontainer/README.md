# Dev container (untested)

A Node 22 container with the Azure CLI and Python 3, for Codespaces or VS Code Dev Containers. `npm ci` runs in `app/`
when the container is created.

**This definition has not been tried yet.** Nobody has run the installer from a container. If you use it:

1. `az login --use-device-code` in the terminal. A device-code sign-in may be blocked by your tenant's Conditional
   Access policy, in which case use a local machine.
2. `node install.mjs --prepare-only` to write the git-ignored `app/rayfin/rayfin.yml`, then run the checks in
   [CONTRIBUTING.md](../CONTRIBUTING.md), or install with the command in the [README](../README.md#deploy-in-minutes).

Installing from a shared Codespace stores the deployment record (`app/rayfin/.deployments.json`,
`app/rayfin/.fabric-weave.json`) inside that Codespace only. Keep them if you want to upgrade or tear down later.
