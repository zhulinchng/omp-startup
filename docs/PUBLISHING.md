# Publishing & Deployment

Two audiences: **maintainers** releasing the package to npm, and **consumers**
deploying it onto a machine. Consumer-facing behavior lives in
[USAGE.md](USAGE.md); this page is the release checklist plus the deployment
matrix in one place.

## Package shape

There is no build step and there are no runtime dependencies. What npm ships
is what the hosts execute:

| Tarball entry | Role |
|---|---|
| `src/*.ts` | The extension sources both hosts import directly |
| `types.d.ts` | Ambient host-API declarations (typecheck only) |
| `scripts/uninstall-reset.js` | npm `postuninstall` hook: restores an owned `startup.quiet` on removal |
| *not shipped* | `tests/`, other `scripts/`, `tsconfig.json`, `AGENTS.md`, dev tooling |

The dual manifest (`package.json#omp.extensions` / `#pi.extensions`) points at
`./src/index.ts`; that is the entire "build output".

## Maintainer release checklist

One-time setup:

1. npm account with 2FA enabled; `npm login`, then confirm `npm whoami`.
2. Git baseline committed (`git init` if needed) — publishing with a dirty
   tree risks shipping uncommitted edits you can't reproduce later.

Every release ships **two packages from one source**: the unscoped
`omp-startup` on npmjs and the scoped `@zhulinchng/omp-startup` on GitHub
Packages. One version bump covers both — never let them drift.

1. Make your changes; verify locally:
   ```sh
   npm run typecheck && npm test && npm run smoke
   ```
2. Bump the shared version once (creates the commit + tag when git is
   present); both packages publish under this same number:
   ```sh
   npm version patch   # or minor / major
   ```
3. Publish the **unscoped** package to npmjs. The `prepublishOnly` script
   re-runs typecheck + full test suite + smoke as a gate; it aborts the
   publish on any failure:
   ```sh
   npm publish         # browser-auth flow: press ENTER at the prompt, then
                       # approve in the opened npmjs.com tab (2FA)
   ```
4. Publish the **scoped** package to GitHub Packages. Cutting the release
   triggers it automatically (Actions tab → "Publish to GitHub Packages" →
   Run workflow works too); its Gates job re-runs the full suite first:
   ```sh
   git push origin main --follow-tags
   gh release create vX.Y.Z --title "vX.Y.Z" \
     --notes "**npm:** [omp-startup@X.Y.Z](https://www.npmjs.com/package/omp-startup/v/X.Y.Z)"
   ```
5. Verify both registries report the same new version:
   ```sh
   npm view omp-startup version
   npm view @zhulinchng/omp-startup version --registry https://npm.pkg.github.com
   ```
6. Inspect what would ship before a real publish with
   `npm publish --dry-run` (tarball contents are listed).

Publishing with the `pi-package` keyword (set in `package.json`) lists the
package in the Pi gallery at <https://pi.dev/packages> automatically; the
entry renders the README verbatim, so keep its counts current before
publishing.

### GitHub Packages mirror
Every GitHub Release also publishes a scoped mirror `@zhulinchng/omp-startup`
to the GitHub npm registry via `.github/workflows/publish-gpr.yml` (release →
automatic; Actions tab → manual `workflow_dispatch`). The workflow runs in
two jobs: a **Gates** job (typecheck + full test suite + smoke on Node 24)
must succeed before the publish job starts, and `prepublishOnly` re-runs the
gates inside the publish step as defense. The workflow repoints only the
package name — version and contents are otherwise identical to npmjs.
Versions are immutable on that registry too: rerunning for an
already-published version fails at the Publish step; bump first. Installing
from it requires an npm token with `read:packages`, even though the package
is public.

A separate CI workflow (`.github/workflows/ci.yml`) runs the same gates on
every push to `main` and every PR, on a Node 24 + 26 matrix — releases should
never be the first place code meets a fresh Node version.

Post-publish verification (see below) before announcing.

### Versioning notes

- First publish of `0.x`: treat minor bumps as breaking-allowed (semver
  §4), major for the eventual stable line.
- Hosts cache installed copies (`~/.omp/plugins/node_modules/`,
  Pi's settings-managed store). Consumers only see an update after rerunning
  their host's install command — bump versions deliberately.

## Post-publish verification

Run from any scratch directory outside the repo (proves registry resolution,
not local files):

```sh
npm view omp-startup version          # matches the just-published version

mkdir -p /tmp/startup-verify/.omp && cd /tmp/startup-verify
echo '{ "greeting": "Publish check" }' > .omp/dashboard.json
omp plugin install omp-startup        # needs bun on $PATH; installs to ~/.omp/plugins
omp                                   # dashboard renders "Publish check"; /dashboard toggles
```

Repeat on the Pi side with `pi install npm:omp-startup` (+ `-l` variant inside
a project for project-local scope). Clean up afterwards:
`omp plugin uninstall omp-startup`, `pi remove omp-startup`.

## Deployment matrix (consumers)

| | omp | Pi |
|---|---|---|
| Install | `omp plugin install omp-startup` (needs `bun` on `$PATH`) | `pi install npm:omp-startup` |
| Project-local | `<project>/.omp/plugins` via project anchor | `pi install -l npm:omp-startup` |
| Update | rerun install (add `--force`) | rerun install |
| Remove | `omp plugin uninstall omp-startup` | `pi remove omp-startup` |
| Inspect | `omp plugin list` | `pi list` |
| Files land in | `~/.omp/plugins/node_modules/<pkg>`, registered via that dir's `package.json#dependencies` ∪ `omp-plugins.lock.json` | `~/.pi/agent/settings.json` `packages` array → unpacked to `~/.pi/agent/npm/node_modules/` |
| Source checkout | symlink into `~/.omp/agent/extensions/` | symlink into `~/.pi/agent/extensions/` |

Config file layers (`<cwd>/.omp/dashboard.json` → `.pi/` fallback →
`~/.config/dashboard/config.json`) are independent of how the plugin was
installed. See [USAGE.md](USAGE.md) for the full reference.

## Troubleshooting publishes

| Symptom | Fix |
|---|---|
| `E409` / name conflict on publish | `npm view omp-startup` — someone took the name; next version of an owned package is fine, first publish is not |
| `ENEEDAUTH` / 403 | `npm login` again; check you're not pointed at a private registry mirror |
| OTP prompt never appears in CI | use `npm publish --otp <code>` or an automation token (`--//registry.npmjs.org/:_authToken`) |
| `prepublishOnly` fails remotely but passes locally | Node version mismatch — releases require Node ≥ 23 (native TS type stripping) |
