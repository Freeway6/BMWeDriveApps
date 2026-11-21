# kit/

The MGU App Kit of [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps)
(MIT, `LICENSE`), taken unchanged at the commit in `UPSTREAM_COMMIT`: only what building, running and previewing
these apps needs.

- `runtime/` – what an app runs on (screens, drawing, settings, UDS over the head unit's diagnostic link, fonts)
- `platform/` – the app permissions every package carries
- `tools/build.py` (+ `pack_data.py`, `localize.py`, `locale-revisions.json`, `oapgen/`) – builds an app;
  `tools/build.py` in the repository root calls it after copying `lib/` into the app
- `tools/preview.js`, `tools/hu-stub.js` – run a built app on a PC with demo data (`tools/preview.sh`)
- `tools/extract_sdk.js`, `check_signals.py`, `sigdoc.py`, `make_icon.js` – SDK and signal helpers

To update: copy the same files from a newer idrive7-apps checkout, write its commit into `UPSTREAM_COMMIT`, then
run `node test/run.js` and `tools/preview.sh`. Its full documentation (writing apps, signals, the emulator) is in
the idrive7-apps README.
