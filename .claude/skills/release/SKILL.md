---
name: release
description: Release procedure for the @csbc-dev/stripe npm package. Use this skill when the user asks to release, publish, ship, cut a version, bump the version, or prepare a release. The actual `npm publish` step is performed manually by the user — Claude must not run it.
---

# Release procedure for `@csbc-dev/stripe`

This skill walks the assistant through the steps required to prepare a release of the `@csbc-dev/stripe` package. The assistant prepares everything up to (but **not** including) the publish step. **`npm publish` is run manually by the user.**

---

## Important constraints

- **Never run `npm publish`.** The user performs publishing manually outside Claude. If the user asks Claude to publish, refuse and remind them this is a manual step.
- **Never run `npm version <bump>` without explicit user approval** — it creates a commit and a git tag and is hard to reverse cleanly.
- **Never push tags or commits to origin** without explicit user approval.
- **Do not skip git hooks** (no `--no-verify`, `--no-gpg-sign`, etc.) unless the user explicitly asks for it.
- All preparation must happen on a clean working tree. If the tree is dirty, ask the user how to proceed before continuing.

---

## Preflight checks

Before touching anything, run these in parallel and report the results to the user:

1. `git status` — confirm the working tree is clean and the branch is `main` (or the release branch the user names)
2. `git log --oneline -10` — show what is going into the release
3. Read [package.json](package.json) — note the current `version`
4. `npm test` — all unit / happy-dom tests in `__tests__/` must pass (vitest)
5. `npm run build` — `tsc` must succeed and produce `dist/`
6. **Verify no local-path dependencies in `package.json` `dependencies`** — see "Local-path dependency check" below.

`npm run test:integration` (Playwright, in `tests/integration/`) is **not** part of the standard preflight — it requires a browser stack and is slower. Run it only if the user explicitly asks, or if the release touches the Shell's confirmation / 3DS-redirect paths.

If any check fails, stop and report. Do not attempt fixes unless the user asks.

---

## Local-path dependency check (MANDATORY before publish)

`@csbc-dev/stripe` depends on `@wc-bindable/core` and `@wc-bindable/remote`. During development those may be pinned to a sibling monorepo via `file:` / `link:` / relative paths for convenience. **`npm publish` will refuse to publish a package whose `dependencies` contain a `file:` URI** — and even if a registry accepted it, downstream `npm install @csbc-dev/stripe` on any machine without that exact directory layout would fail.

Before running any publish-prep step, confirm with the user:

1. Both `@wc-bindable/core` and `@wc-bindable/remote` have been published to npm at the versions `@csbc-dev/stripe` is built and tested against, AND
2. `package.json` `dependencies` for both entries have been updated to a semver range (`^X.Y.Z`) pointing at those published versions.

Procedure:

- Use Read on [package.json](package.json) and check the `dependencies` block for any value starting with `file:` / `link:` / `portal:` / a relative path (`./` / `../`). If you find one, STOP and surface it as a blocker — do NOT continue with version bump, build verification, or commit.
- After the user updates the deps to registry-resolvable ranges, re-run `npm install` and `npm test` so `package-lock.json` (if present) and the test suite pick up the published artifacts instead of sibling-monorepo builds.
- Restore the `file:` references in a follow-up commit AFTER the publish, if the user wants the dev-convenience pointers back. The release commit itself must ship a published-artifact-resolvable manifest.

If the user asks "why can't we just publish anyway", remind them that `npm publish` runs its own check and rejects `file:` deps with `EUNSUPPORTEDPROTOCOL` / "Cannot publish a package with a file: dependency".

The peer dependencies (`stripe`, `@stripe/stripe-js`) are correctly declared as optional `peerDependencies` and do not need this treatment — they resolve from the consumer's tree.

---

## Version bump

Confirm the next version with the user before bumping. Follow semver:

- **patch** — bug fixes only, no API changes
- **minor** — backwards-compatible feature additions
- **major** — breaking changes. **For this package, all of the following count as breaking:**
  - any change to the wcBindable surface ([src/core/wcBindable.ts](src/core/wcBindable.ts) — properties / inputs / commands)
  - any change to exported types in [src/types.ts](src/types.ts) (`IStripeProvider`, `IntentBuilder`, `WcsStripeCoreValues`, the `StripeStatus` union, …)
  - any change to the `<stripe-checkout>` attribute contract (`mode`, `amount-value`, `amount-currency`, `customer-id`, `publishable-key`, `return-url`)
  - any change to the sanitized error contract (`StripeError` shape, the wire-side allowlist of `type` tokens)
  - any change to the remote wire protocol used by `@wc-bindable/remote`
  - any change to the 3DS resume authorization model (`registerResumeAuthorizer`, the `clientSecret` constant-time compare contract)

Once the user approves the bump level, update `version` in [package.json](package.json). Prefer editing the field directly rather than running `npm version`, so the user keeps control over commit/tag creation.

If the change touches the protocol, security invariants, or the state machine, also confirm whether [SPEC.md](SPEC.md) needs an updated note — particularly §9 (security responsibilities) and the state-machine section.

---

## Build verification

After the version bump:

1. `npm run build` — fresh `tsc` build from a clean state.
2. Sanity-check `dist/` contains the expected entry points:
   - `dist/index.js` + `dist/index.d.ts` — matches `package.json` `main` / `types` and the `.` export (browser barrel).
   - `dist/server.js` + `dist/server.d.ts` — matches the `./server` export (Node-only entry that pulls in `node:crypto` via `StripeCore`).
3. **Verify the browser barrel stays Node-evaluable.** [__tests__/nodeRootImport.test.ts](__tests__/nodeRootImport.test.ts) asserts that `import("@csbc-dev/stripe")` does not throw `ReferenceError: HTMLElement is not defined` under plain Node. This is the regression test for the [src/core/wcBindable.ts](src/core/wcBindable.ts) split — if it fails, the browser graph has started transitively pulling `StripeCore.ts` (and therefore `node:crypto`) again. Do not paper over with a try/catch; surface as a blocker.
4. `npm pack --dry-run` — confirm the tarball contents match `package.json` `files` (`dist`, `LICENSE`, `README.md`, `SPEC.md`). Watch for accidentally-included files (e.g. `src/`, `__tests__/`, `tests/`, `test-results/`, `playwright.config.ts`).

---

## Documentation and changelog

- Update any version reference in `README.md` or `SPEC.md` if the docs cite a specific version.
- If the repository has a changelog, add an entry. If it does not, ask the user whether to start one — do not create `CHANGELOG.md` unsolicited.
- For releases that change the security surface (sanitizer allowlist, resume authorization, webhook dedup window, idempotency behavior), call out the change explicitly in the release commit body — apps relying on SPEC.md §9 need to re-read the relevant section.

---

## Commit and tag (with user approval)

When the user approves the prepared changes, propose a single commit:

```
chore(release): v<new-version>
```

Then propose creating an annotated tag `v<new-version>`. Run `git commit` and `git tag` only after the user approves. Do **not** push.

---

## Hand-off for manual publish

After the commit and tag are created locally, hand off to the user with a checklist they will run manually:

```
# user runs these manually — Claude does not execute them
git push origin main
git push origin v<new-version>
npm publish --access public
```

(Use `--access public` because `@csbc-dev/stripe` is a scoped package; the user can omit this if their npm config already defaults to public for the scope.)

Remind the user to verify the published version on the npm registry after publishing, and to spot-check that the published tarball exposes both entry points (the bare `@csbc-dev/stripe` and `@csbc-dev/stripe/server`).

---

## If something goes wrong after publish

If the user reports a problem after running `npm publish`:

- **Never** suggest `npm unpublish` of a stable version — npm restricts unpublish for packages that have been live more than 72 hours, and even within the window it can break downstream installs.
- Recommend `npm deprecate @csbc-dev/stripe@<bad-version> "<message>"` and then preparing a new patch release through this same skill.
- If the bad version was tagged `latest`, `npm dist-tag` can re-point `latest` at the previous good version — but again, this is run manually by the user.
- For security-sensitive regressions (e.g. an error sanitizer leak, a webhook signature bypass, a `clientSecret` exposure on observable state), advise the user to deprecate immediately with a message that links to the fix's tracking issue, and to ship the patch release as the top priority before any other work.
