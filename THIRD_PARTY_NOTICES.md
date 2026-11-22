# Third-party parts

- **`kit/`** – the MGU App Kit from [idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps)
  (runtime, build and preview tools), MIT licence, Copyright (c) 2026 cauliflowermossgrape and contributors:
  `kit/LICENSE`. Taken unchanged at the commit in `kit/UPSTREAM_COMMIT`; see `kit/README.md`.
- **Engine unit identifiers and scalings** in `lib/lib_dme.js` (which DID holds which value, its byte layout and
  scaling): from idrive7-apps' Live Data app (`apps/live_data/builtin/DME8FF_R.json`, MIT, made from the public
  SGBD reference) and its M Vitals app (`config.dme`, MIT). The OBD-II fallbacks are the standard PIDs of SAE J1979.
- **`lib/lib_flow.js`** follows the fuel flow of Live Data (`apps/live_data/signals.js`, MIT): the car's injection
  counter, its factor learned from the engine unit's own fuel flow.
- **`lib/lib_signals.js`** reads the car's signals with the scalings of idrive7-apps' `kit/car.js` and Live Data,
  and the driving mode numbers as its ambient_config app reads them (MIT).
- **`lib/lib_link.js`** follows the link queue of idrive7-apps' eDrive app (`apps/edrive/linkqueue.js`, MIT).
- **Font atlases** in `kit/runtime/fonts/`: baked from the Ubuntu font family (Ubuntu Font Licence 1.0),
  Barlow and Noto Sans SC (SIL Open Font License 1.1, `OFL-*.txt` beside them). The German atlases in
  `i18n/fonts/de/` are the same Ubuntu atlases with the German letters added (`tools/bake_german.py`, after
  idrive7-apps' `bake_spanish.py`, MIT).
- **The limits** the apps judge by (misfires, oil use, oil pressure drop, boost deviation, knock retard, rail
  pressure, mixture) are rules of thumb for a petrol engine, not BMW data. The car data in `lib/lib_phys.js` and
  `lib/lib_demo.js` (mass, drag, gear ratios, the demo engine) are published figures and estimates.

No BMW SDK or firmware files are in this repository. The head unit builds the apps against the oap-sdk of a
stock app already on it.
