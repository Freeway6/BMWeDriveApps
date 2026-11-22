# i4 Live Relay

Ein Briefkasten im Internet zwischen der Headunit und dem iPhone. Die Ladekurve legt beim Laden alle paar
Sekunden den Stand der Ladung hinein (und die Kurve), die iPhone- und die Watch-App holen ihn ab.

- **Ende-zu-Ende verschlüsselt:** Die Headunit verschlüsselt alles mit AES-256-GCM. Den Schlüssel erzeugt sie
  selbst und zeigt ihn nur im QR-Code auf ihrer Seite „iPhone“. Das Relay speichert Chiffretext, Größe und
  Zeitpunkt, keine Werte. Lesen und Schreiben brauchen Tokens, die aus dem Schlüssel abgeleitet sind.
- **Kostenlos:** ein Cloudflare Worker mit einem Durable Object (SQLite) je gekoppeltem Auto. Das läuft im
  kostenlosen Workers-Plan; eine Ladung braucht ein paar hundert Anfragen, der Plan erlaubt 100.000 am Tag.
- **Räumt selbst auf:** Ein Kanal, in den 30 Tage niemand geschrieben hat, löscht sich.

## Einrichten (einmal, etwa 5 Minuten)

Voraussetzung: ein kostenloses Konto bei [Cloudflare](https://dash.cloudflare.com/sign-up) und Node.js auf dem Mac.

```sh
cd relay
npx wrangler login      # öffnet den Browser, bei Cloudflare anmelden und zustimmen
npx wrangler deploy     # lädt den Worker hoch
```

Am Ende nennt `wrangler` die Adresse, etwa `https://i4-live.<dein-name>.workers.dev`. Beim ersten Mal fragt
Cloudflare nach einem Namen für die `workers.dev`-Subdomain. Prüfen:

```sh
curl https://i4-live.<dein-name>.workers.dev/v1/health
```

Die Antwort sollte `{"ok":true}` sein. Ist es der erste Worker im Konto, legt Cloudflare dabei die
`workers.dev`-Subdomain neu an; deren Zertifikat ist erst nach einigen Minuten fertig, bis dahin scheitert der
Aufruf mit einem TLS-Fehler (`handshake failure`). Dann diese Adresse in `apps/i4ev_charge/app.json` unter
`config.live.relay` eintragen und den Commit pushen; der Store bietet die Ladekurve dann als Update an (README im
Hauptordner, Abschnitt „Live auf iPhone und Apple Watch“).

## Ohne Auto ausprobieren

`tools/live_demo.js` sendet eine simulierte Ladung genau so, wie die Headunit es tut, mit demselben Code:

```sh
node tools/live_demo.js https://i4-live.<dein-name>.workers.dev --fast 10
```

Den QR-Code im Terminal mit der iPhone-Kamera scannen. Mit `--sleep-at 50 --sleep-for 8` schweigt die
„Headunit“ ab 50 % für 8 Minuten der Ladung: so sieht man die Prognose in der App.

## Das Protokoll

| Anfrage | Wer | Was |
|---|---|---|
| `PUT /v1/c/<kanal>/state` und `/curve` | Headunit | `{ seq, blob }`; `Authorization: Bearer <Schreib-Token>`. Der erste Schreibzugriff legt den Kanal an (`X-I4-Read`: SHA-256 des Lese-Tokens) |
| `GET /v1/c/<kanal>?have=<seq>` | iPhone, Watch | `{ now, state, curve }`; `Authorization: Bearer <Lese-Token>`. Die Kurve kommt nur, wenn sie neuer ist als `have` |
| `DELETE /v1/c/<kanal>` | Headunit | beim neuen Koppeln: der alte Kanal wird gelöscht |
| `GET /v1/health` | | `{ ok: true }` |

`blob` ist Base64 von Nonce (12 Byte), Chiffretext und Tag (16 Byte). Die Zusatzdaten (AAD) lauten
`i4live|<kanal>|<state oder curve>|v1`. Die Schlüssel sind HMAC-SHA256 des Kopplungsschlüssels mit
`i4live enc v1`, `i4live read v1` und `i4live write v1`. Was in den Dokumenten steht, beschreibt
`lib/ev_livedoc.js`.

## Entwicklung

```sh
node relay/test/run.mjs          # Tests ohne Cloudflare
node relay/test/local.mjs 8787   # das Relay lokal (im Speicher), z. B. für tools/live_demo.js http://127.0.0.1:8787
```

`src/worker.js` verteilt die Anfragen auf die Kanäle, `src/channel.js` enthält die Logik eines Kanals.
