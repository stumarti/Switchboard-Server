# Development

## Running locally

```sh
npm install
DATA_DIR=/tmp/sb-dev DISABLE_MDNS=1 npm start
```

Open `http://localhost:45678`.

## Tests

```sh
npm test
```

Node's built-in test runner, over `test/*.test.js`. CI runs it on every push.

## Secrets & your first commit

`data/` holds real credentials once you start using this — Home Assistant tokens, WiFi passwords. `.gitignore` already excludes it (`data/*`, keeping only `.gitkeep`), so it's safe to `git add -A` without checking each time.

One gotcha in local dev: running `npm start` without setting `DATA_DIR` writes straight into this repo's own `data/` folder. Harmless now that it's gitignored, but set `DATA_DIR` to somewhere outside the repo anyway (e.g. `DATA_DIR=/tmp/sb-dev`) so test data doesn't pile up here.

## Cutting a release

```sh
git tag v1.0.0
git push origin v1.0.0
```

That's it — `.github/workflows/release.yml` builds the image and pushes `ghcr.io/stumarti/switchboard-server:latest` and `:1.0.0`, and creates a GitHub Release. `.github/workflows/ci.yml` runs a lighter build-check on every push so a broken build never gets that far.
