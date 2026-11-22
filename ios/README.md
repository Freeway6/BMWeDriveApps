# i4 Laden: die Ladekurve auf iPhone und Apple Watch

Die App zeigt die Ladung, die die Ladekurve auf der Headunit gerade aufzeichnet:
- Ladestand, Leistung und Zelltemperatur;
- die Zeit bis zum Ziel und bis 100 %;
- Energie und Kosten;
- die Kurve gegen die Referenz und die erwartete Kurve.

Dazu gibt es eine **Live-Aktivität** auf dem Sperrbildschirm und in der Dynamic Island. Ab iOS 18 und watchOS 11
erscheint sie auch im Smart Stack der Apple Watch. Die **Watch-App** hat eigene Komplikationen für das Zifferblatt.

> **Stand: nicht kompiliert.** Der Code ist ohne Mac entstanden. Geprüft ist das Format der Daten: die
> Entschlüsselung mit denselben Schritten wie CryptoKit, gegen die echte Ausgabe des Headunit-Codes. Beim ersten
> Bauen kann Xcode noch Fehler melden; dann die Meldung schicken.

## Was du brauchst

- einen Mac mit Xcode 16 oder neuer, dazu [XcodeGen](https://github.com/yonaskolb/XcodeGen): `brew install xcodegen`;
- ein iPhone mit iOS 18 und eine Apple Watch mit watchOS 11 (oder neuer);
- einen Apple-Account. Ein kostenloser genügt (in Xcode „Personal Team“), siehe unten;
- das Relay (`relay/README.md`) und die Ladekurve ab Version 0.3.0 im Auto.

## Bauen und installieren

1. Signatur eintragen: `ios/Config.local.xcconfig.example` nach `ios/Config.local.xcconfig` kopieren.
   - `I4_TEAM`: deine Team-ID (Xcode → Settings → Accounts → dein Account → Team).
   - `I4_BUNDLE_PREFIX`: ein eigener Präfix wie `de.vorname.nachname`.

   Die Datei bleibt lokal (`.gitignore`). Ohne sie wählt man das Team in Xcode unter „Signing & Capabilities“.
2. Projekt erzeugen und öffnen:
   ```sh
   cd ios
   xcodegen
   open I4Laden.xcodeproj
   ```
3. iPhone per Kabel anschließen (beim ersten Mal: Einstellungen → Datenschutz & Sicherheit → **Entwicklermodus**
   einschalten). Schema **I4Laden**, das iPhone als Ziel, **Run**. Beim ersten Start fragt iOS, ob es dem
   Entwickler vertraut: Einstellungen → Allgemein → VPN & Geräteverwaltung.
4. Apple Watch: Schema **I4LadenWatch**, die Uhr als Ziel, **Run** (auch dort Entwicklermodus einschalten).
5. Komplikation: das Zifferblatt lange drücken → Bearbeiten → „i4 Laden“ wählen.

Nach Änderungen an `project.yml` oder neuen Dateien `xcodegen` erneut ausführen.

## Koppeln

1. Im Auto: Ladekurve öffnen, Einstellungen → **Live auf iPhone und Apple Watch** einschalten.
2. Zur Seite **iPhone** blättern: Dort steht ein QR-Code.
3. Mit der **Kamera-App** scannen und „In i4 Laden öffnen“ tippen. Die Uhr bekommt die Kopplung vom iPhone.

Der QR-Code enthält den Schlüssel. Wer ihn fotografiert, kann mitlesen. Auf der Seite „iPhone“ macht
**Neu koppeln** (zweimal drücken) einen neuen Schlüssel; dann den neuen Code scannen.

## Wie live ist es?

- **Die Headunit sendet nur, solange sie wach ist und Internet hat.**
  - Internet bekommt sie über das Uplink des MGU Stores: einen LTE-Stick, einen Handy-Hotspot oder WLAN.
  - Mit abgeschlossenem Auto schläft die Headunit nach kurzer Zeit, auch beim Laden.
  - Dann rechnet die App mit der **Prognose** weiter. Diese schickt die Headunit mit jedem Stand mit: der Rest der
    Ladung nach der gelernten Ladekurve.
  - App, Live-Aktivität und Komplikation zeigen das mit „Prognose“ und „≈“ an.
- **iPhone-App offen:** Abfrage alle 5 Sekunden.
- **Live-Aktivität:** Starten darf sie iOS nur, solange die App offen ist. Also einmal öffnen, wenn die Ladung
  läuft. Danach aktualisiert die App sie, solange sie offen ist, und gelegentlich im Hintergrund (iOS entscheidet,
  wann). Dazwischen laufen der Countdown und der Balken bis zum Ziel von selbst weiter.
- **Apple Watch:** Die App fragt alle 10 Sekunden, solange sie offen ist. Die Komplikation folgt der Prognose und
  wird im Hintergrund etwa alle 15 Minuten aufgefrischt.

### Kostenloser oder bezahlter Apple-Account

Mit dem **kostenlosen** Account läuft alles oben Beschriebene. Zwei Einschränkungen hat er:
- Die Apps laufen **7 Tage**; danach einmal neu aus Xcode starten.
- Es gibt **keine Push-Mitteilungen**.

Mit dem **bezahlten** Developer Program (99 € im Jahr) wären Push-Updates für die Live-Aktivität möglich. Das
Relay würde dann jeden neuen Stand an Apple schicken, und Sperrbildschirm und Uhr wären auch bei geschlossener App
live. Das ist nicht eingebaut; es lässt sich ergänzen (das Relay müsste dafür Stand und Ziel unverschlüsselt an
Apple geben).

## Aufbau

| Ordner | Ziel | Inhalt |
|---|---|---|
| `Shared/` | alle | Kopplung und Schlüssel (CryptoKit), Relay-Abfrage, Datenmodelle, Prognose, Formate, Diagramme |
| `App/` | iPhone | App, Kopplung, Live-Ansicht, Live-Aktivität steuern, Hintergrund, Übergabe an die Uhr |
| `Phone/` | iPhone, Widgets | die Daten der Live-Aktivität |
| `Widgets/` | Widget-Erweiterung | die Live-Aktivität (Sperrbildschirm, Dynamic Island, Smart Stack der Uhr) |
| `Watch/` | Watch-App | Ansichten, Abfrage, Übernahme der Kopplung vom iPhone |
| `WatchShared/` | Watch-App, Komplikationen | der letzte Stand für das Zifferblatt (App Group) |
| `WatchWidgets/` | Komplikationen | rund, rechteckig, Ecke, eine Zeile |

Das Datenformat ist in `lib/ev_livedoc.js` beschrieben, die Verschlüsselung in `lib/ev_live.js` und
`relay/README.md`.
