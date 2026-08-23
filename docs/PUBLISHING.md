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
| `docs/`, `README.md`, `LICENSE` | Documentation |
| *not shipped* | `tests/`, `scripts/`, `tsconfig.json`, `AGENTS.md`, dev tooling |

The dual manifest (`package.json#omp.extensions` / `#pi.extensions`) points at
`./src/index.ts`; that is the entire "build output".

## Maintainer release checklist

One-time setup:

1. npm account with 2FA enabled; `npm login`, then confirm `npm whoami`.
2. Git baseline committed (`git init` if needed) — publishing with a dirty
   tree risks shipping uncommitted edits you can't reproduce later.

Every release:

1. Make your changes; verify locally:
   ```sh
   npm run typecheck && npm test && npm run smoke
   ```
2. Bump the version (creates the commit + tag when git is present):
   ```sh
   npm version patch   # or minor / major
   ```
3. Publish. The `prepublishOnly` script re-runs typecheck + full test suite +
   smoke suite as a gate; it aborts the publish on any failure:
   ```sh
   npm publish         # enter OTP when prompted
   ```
4. Inspect what would ship before the real publish with
   `npm publish --dry-run` (tarball contents are listed).

Post-publish verification (see below) before announcing.

### Versioning notes

- First publish of `0.x`: treat minor bumps as breaking-allowed (semver
  §4), major for the eventual stable line.
- Hosts cache installed copies (`~/.omp/agent/plugins/node_modules/`,
  Pi's settings-managed store). Consumers only see an update after rerunning
  their host's install command — bump versions deliberately.

## Post-publish verification

Run from any scratch directory outside the repo (proves registry resolution,
not local files):

```sh
npm view omp-startup version          # matches the just-published version

mkdir -p /tmp/startup-verify/.omp && cd /tmp/startup-verify
echo '{ "greeting": "Publish check" }' > .omp/dashboard.json
omp plugin install omp-startup        # installs to ~/.omp/agent/plugins
omp                                   # dashboard renders "Publish check"; /dashboard toggles
```

Repeat on the Pi side with `pi install npm:omp-startup` (+ `-l` variant inside
a project for project-local scope). Clean up afterwards:
`omp plugin uninstall omp-startup`, `pi remove omp-startup`.

## Deployment matrix (consumers)

| | omp | Pi |
|---|---|---|
| Install | `omp plugin install omp-startup` | `pi install npm:omp-startup` |
| Project-local | `<project>/.omp/plugins` via project anchor | `pi install -l npm:omp-startup` |
| Update | rerun install (add `--force`) | rerun install |
| Remove | `omp plugin uninstall omp-startup` | `pi remove omp-startup` |
| Inspect | `omp plugin list` | `pi list` |
| Files land in | `~/.omp/agent/plugins/node_modules/<pkg>` | settings.json `extensions` entry |
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
