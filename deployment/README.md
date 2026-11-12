# deployment

Everything for installing Fabric Weave from a shared package. The full guide is
[docs/DEPLOYMENT-GUIDE.md](../docs/DEPLOYMENT-GUIDE.md).

| File | Purpose |
|---|---|
| `customer.config.example.json` | The settings. Copy it to `customer.config.json` (git-ignored) and fill it in |
| `Deploy.ps1` | Windows wrapper: checks the tools, signs in to the right tenant, runs `node install.mjs --config ...`, prints the app URL |
| `Build-Package.ps1` | Builds `dist\fabric-weave-<version>[-offline].zip` and its SHA256 from the committed files |
| `last-deployment-result.json` | Written by a successful install: workspace and app URLs, item ids, mode (no secrets; git-ignored) |
| `package-info.json` | Written into the ZIP by `Build-Package.ps1`: version, commit, offline cache platform (git-ignored) |

Quick start on Windows:

```powershell
Copy-Item deployment\customer.config.example.json deployment\customer.config.json
# edit deployment\customer.config.json
.\deployment\Deploy.ps1 -DryRun
.\deployment\Deploy.ps1
```

On macOS or Linux: `node install.mjs --config deployment/customer.config.json`.
