# Third-party parts

- **`kit/`** – the MGU App Kit from [idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps)
  (runtime, build and preview tools), MIT licence, Copyright (c) 2026 cauliflowermossgrape and contributors:
  `kit/LICENSE`. Taken unchanged at the commit in `kit/UPSTREAM_COMMIT`; see `kit/README.md`.
- **`lib/ev_link.js`** follows the link queue of idrive7-apps' eDrive app (`apps/edrive/linkqueue.js`, MIT).
- **Font atlases** in `kit/runtime/fonts/`: baked from the Ubuntu font family (Ubuntu Font Licence 1.0),
  Barlow and Noto Sans SC (SIL Open Font License 1.1, `OFL-*.txt` beside them). The German atlases in
  `i18n/fonts/de/` are the same Ubuntu atlases with the German letters added (`tools/bake_german.py`, after
  idrive7-apps' `bake_spanish.py`, MIT).
- **Battery identifiers and scalings** in `lib/ev_hv.js` (which DID holds which value, and how it is scaled):
  from the OBDb signal sets of the [iX3](https://github.com/OBDb/BMW-iX3), [iX](https://github.com/OBDb/BMW-iX)
  and [i4](https://github.com/OBDb/BMW-i4) (CC BY-SA 4.0) and from idrive7-apps' eDrive app (MIT).
- **Root certificates** in `lib/ev_roots.js` (ISRG, Google Trust Services, GlobalSign, DigiCert, SSL.com, Sectigo
  USERTrust): public CA certificates as Mozilla's CA store carries them (Debian `ca-certificates`), for the head
  unit's HTTPS to the live relay when Node 8's own list (2019) lacks a root.
- **The DC charging curve** in `lib/ev_model.js` is a typical published curve for the i4's 83.9 kWh battery,
  an estimate, not BMW data.

No BMW SDK or firmware files are in this repository. The head unit builds the apps against the oap-sdk of a
stock app already on it.
