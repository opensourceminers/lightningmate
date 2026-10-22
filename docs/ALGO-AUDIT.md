# LightningMate — Tiefen-Audit der Profit-Algorithmen (2026-06-28)

Ziel der App: den Node so profitabel wie möglich machen (Routing-Revenue + Magma-Lease-Income − Rebalance-/On-Chain-/Kapitalkosten). Dieser Audit prüft, ob die Algorithmen das tatsächlich *maximieren*.

## Gesamturteil

Das System ist ein gut abgesicherter **Liquiditäts-Balancing- + Heuristik-Apparat** — *profit-bewusst*, aber **nicht profit-maximierend**. Es optimiert implizit „halte Kanäle ~halbvoll" und „route nie unter Kosten", nicht „maximiere Fee × Volumen". Fünf strukturelle Lücken und eine Reihe konkreter Bugs erklären, wo Gewinn liegen bleibt — inkl. des beobachteten „seit dem Rework keine Routings".

## Fünf strukturelle Lücken (wo das Geld liegt)

1. **Keine Nachfragekurven-/Revenue-Peak-Optimierung.** Fees werden entlang einer Balance-Kurve geschoben; Magma nutzt einen skalaren Hill-Climber. Nirgends wird der Preis gesucht, der `Fee × Volumen(Fee)` maximiert. (Fees A, Magma 2.1)
2. **Der Lern-/Mess-Loop ist zu grob & konfundiert, um zu optimieren.** Elastizität = ±20% Vorzeichen-Faktor aus n≈1–5 verrauschten Samples, ohne Marktdrift-Kontrolle, plus eigener Autopilot-Aktionen als Störgröße. Das ist das Fundament für alles andere — und es ist kaputt. (Learning 2.1)
3. **Kein einheitlicher Kapital-Allokator.** Kapital wird nach Reihenfolge + Poll-Takt verteilt, nicht nach gerankter Grenz-ROI über Routing/Leasing/Rebalance/Halten. Magma gewinnt strukturell (10× schnellerer Loop) das Kapital-Rennen; die Close-Vorschläge werden nie ausgeführt. (Capital A, B, D)
4. **Der billigste Rebalance-Hebel fehlt:** PeerSwap-über-Liquid ist nicht implementiert. Jeder Refill wird als teures circular-LN bepreist → viele profitable Refills als „zu teuer" abgelehnt. (Rebalance 2.5)
5. **Keine konkurrenz-bewusste Bepreisung.** Fees werden gegen den *eigenen* Median gebenchmarkt, nie gegen die konkurrierenden Parallel-Routen, die den Forward tatsächlich gewinnen. (Fees C)

## Konkrete Bugs (Quick Wins, niedriges Risiko)

- **Fees:** Elastizitäts-Faktor umgeht den `combinedMod`-Clamp (kann ±20% über die beabsichtigte Grenze hinaus wirken). Zweite, widersprüchliche Fee-Kurve in `fees.ts`. Profit-Floor greift nur für je-rebalancete Kanäle. Top-Earner-Cutoff zu locker bei Ties; eine tote velocity-Branch.
- **Learning:** After-Fenster-Truncation (`gap`=5d vs `feeWin`=7d) verfälscht gerade die *neuesten* Änderungen negativ. `sign(0)` wird als Stimme mitgezählt. Rebalance-ROI über-kreditiert (brutto statt inkrementelle Revenue).
- **P&L:** die ausgezahlte 1%-Servicegebühr wird **nicht** abgezogen, **und** Magma-Lease-Einnahmen fehlen ganz → „Profit" ist falsch gemessen.
- **Magma:** „exhausted"-Erkennung (`total < max`) ist für Mehrkanal-Offers falsch (verifizieren ggü. Amboss-Feldsemantik). Widerspruch: deaktivierte Offers werden „in Ruhe gelassen" *und* zugleich auto-enabled. `availableSats` = `total_size` (nicht Restkapazität) → verzerrte Perzentile.
- **Rebalance:** zwei widersprüchliche „lohnt sich"-Gates (legacy `econRatio` 0.8 vs v1 `profitShare` 0.5). Recommender ist blind für Rebalance-Cooldowns/Fehler (kein Backoff).

## Priorisierte Roadmap

### Phase 0 — Quick Wins & Bugfixes (Tage, geringes Risiko)
Stoppt das Fehlsteuern + macht „Profit" überhaupt korrekt messbar.
- Elastizität: Sample-Size- + Signifikanz-Gate, Clamp-Bug fixen, `sign(0)` raus, After-Fenster-Truncation fixen.
- P&L: 1%-Gebühr abziehen + Magma-Lease-Revenue aufnehmen.
- Magma „exhausted"/Relist-Logik + Disabled-Offer-Widerspruch fixen.
- Doppelte Fee-Kurve & doppeltes Rebalance-Gate vereinheitlichen.
- Leasing-Benchmark = **marginale** (nicht durchschnittliche) Routing-Yield.

### Phase 1 — Messung vertrauenswürdig machen (Fundament)
- Outcomes de-konfundieren via node-weiter/Kohorten-Baseline (Difference-in-Differences).
- Ehrliche Fill-Rate/Lease-Yield-Metriken (nach Block-Länge annualisieren, Pending ausschließen).
- Reichere Kostenbasis (Kapital-Amortisation, Idle-Gap, Input-Count-bewusste On-Chain-Kosten).

### Phase 2 — Heuristiken zu Optimierern machen (baut auf Phase 1)
- Pro-Kanal Nachfragekurve / Bandit-Fee-Exploration → Preis auf Revenue-Peak.
- Magma Nachfragekurven-Pricing (skalaren Ratchet ersetzen), pro Größen-Band.

### Phase 3 — Strukturelle Profit-Hebel
- Einheitlicher Grenz-ROI-Kapital-Allokator (Routing/Leasing/Rebalance/Halten ranken; Redeploy-Loop schließen; Budget fair teilen).
- PeerSwap-über-Liquid als billigster Rebalance-Rail.
- Konkurrenz-bewusste Bepreisung aus dem Netzwerk-Graph.

### Bezug zum „keine Routings seit dem Rework"
Konsistent mit: Fee-Engine hob Fees auf nachfrage-starken Kanälen an (velocity ×1.25, „draining → raise"-Reflex), tauschte Volumen gegen Marge — und der verrauschte/langsame Elastizitäts-Loop korrigiert das wochenlang nicht, ohne Konkurrenz-Awareness merkt er nicht, dass er sich rausgepreist hat. Phase 0+1 adressieren genau das.

### Stand 2026-10 (Fix-Paket P2)
- Elastizität: eigenes Fee-Change-Log (1 Jahr) statt Run-History; gemessen bis zur nächsten Änderung (msat, DiD gegen den Rest des Nodes); Lernen nur mit ≥ 4 gleichgerichteten, signifikanten Samples (je ≥ 10 Forwards davor/danach), zum Node-Signal geschrumpft; erweitert nur den Raise-Schritt, hebt die Grenze nie auf.
- Konkurrenz-bewusste Bepreisung: Marktreferenz aus dem Graphen (kapazitätsgewichteter Median der Fees anderer Nodes in denselben Peer) — senkt das Balanced-Niveau bei billigerem Markt nur auf Kanälen, die zu ihrem Preis keinen Fluss gewinnen (kein Forward im 14-Tage-Fenster, Explore, unter dem Node-Benchmark; nie Top-Earner, stetiger Abfluss, ablaufende Kanäle), erster Sprung für idle Kanäle, Wiederbeschaffungskosten für ablaufende Kanäle (nicht bei gemessener Elastizität < 1).
- Fees bewegen sich in begrenzten Schritten (Anheben ≤ 2 Schritte, mit gelernter Elastizität ≤ 3; jedes Senken ≤ Ratchet-Schritte); in einem Update nur: Sprung idler Kanäle auf Flow-Anker oder Marktpreis, Pins, Neukanal-Boden, Lease-Versprechen, Fees außerhalb min/max (unter min: erst auf min, dann in Schritten). Die Anti-Churn-Schwelle misst den Abstand zum Ziel, nicht den Schritt — und gilt nicht für die eigenen Schritte der No-Flow-Regel (Ratchet, Sprünge) und Korrekturen in den min/max-Bereich. Der erste Grund ist die Regel, die den Schritt gesetzt hat.
- Anheben nur auf ein Abfluss-Signal: ein Kanal, der nicht unter seiner Ziel-Ratio liegt und nicht abfließt, wird von der Balance-Kurve nicht angehoben — ein Preis, der Fluss gewinnt, bleibt (vorher: 50 → 70 Richtung Balanced-Niveau 80, rausgepreist, nach zwei ruhigen Wochen wieder gesenkt; in einer 120-Tage-Simulation mit preisabhängiger Nachfrage 80–90 % der Zeit rausgepreist).
- Graph-Cache: ein älterer Graph (bis 12 h) wird sofort geliefert, während im Hintergrund neu gelesen wird — ein langsames Lesen nimmt keinem Report mehr die Marktreferenz (vorher fehlte sie jedem zweiten Lauf). Ein Lesen, das nie antwortet, wird nach 10 Minuten aufgegeben (vorher blieb es für immer „unterwegs“ und hielt den Kanal-Schritt samt Autopilot-Lock fest).
- Begründungen: der erste Grund ist die Regel, die den Schritt gesetzt hat (auch „draining: …“ für einen ablaufenden Kanal auf/über seiner Ziel-Ratio, „replacement: …“ beim Senken auf die Wiederbeschaffungskosten); keine Zeile widerspricht dem Schritt — setzt ein Pin, ein Ausschluss oder ein Lease-Versprechen den Schritt, behalten die Regeln der Engine nur ihre Fakten. Eine Fee an einem Boden (Neukanal, Protect-/Profit-Floor-Rampe) landet beim Runden genau darauf (vorher 80 → 75 im 25-ppm-Raster).
- Fehlende Marktreferenz senkt keinen ablaufenden Kanal mehr: jeder Kanal behält seine zuletzt gesehene Referenz bis zu 7 Tage (ein Peer nach einem Ausfall hat seine eingehenden Kanäle im Graphen noch deaktiviert und fällt unter 3 Kanäle), und ganz ohne Referenz wird ein ablaufender Kanal gehalten statt von der Balance-Kurve gesenkt (vorher: ein Lauf ohne Referenz 340 → 310, und Lücken alle paar Tage liefen ihn dauerhaft auf ~100 herunter).

### Stand 2026-10 (Fix-Paket P3)
- Rebalance-Gate und Zahlung stimmen überein: der max_fee jeder Zahlung ist die Grenze des Gates bei dieser Größe — min(Betrag × max ppm, Payback-Grenze, erwartete Einnahmen − Mindestgewinn), auch bei den halbierten Versuchen —, und nie mehr als vom Tagesbudget übrig ist (vorher: nur Betrag × max ppm; ein 750k-Refill mit 200 sat Einnahmen durfte 240 sat zahlen).
- Das Gate bewertet die verschobenen Sats mit der Fee, die die Fee-Engine NACH dem Refill nimmt (die Engine selbst wird gefragt), und die Engine hält diesen Preis, solange die Refill-Sats im Kanal sind (FIFO über LNDs „sent“-Zähler, höchstens 30 Tage, Freigabe bei wenig Fluss: eine Woche nach dem Refill < 3 Forwards in 14 Tagen bei ≥ 40 % lokal). Vorher wertete das Gate zum Fee des leergelaufenen Kanals, und die Engine senkte sie gleich danach (+167 sat erwartet, ~+35 realisiert).
- Profit-Floor nur noch für Sats, die noch im Kanal sind (ausgelaufene Refills zählen nicht mehr), mit Datum und Rest in der Begründung.
- Quellen: nie jünger als 14 Tage, privat, über Magma/LSPS1 verkauft (in der Laufzeit), mit Netto-Abfluss, Top-Earner oder bester Earner des Nodes; höchstens der Überschuss über den eigenen Anteil + 5 %; geplante Abzüge verringern den Überschuss für das nächste Ziel; bis zu drei Quellen pro Ziel; Backoff pro Quelle→Ziel-Paar; MPP (3 Pfade) ab 500k.
- Tagesbudget aus dem Rebalance-Log abgeleitet (manuelle Läufe und laufende Zahlungen zum Höchstfee inklusive), übersteht Neustarts, beginnt um 00:00 UTC; manuelle Läufe sind gedeckelt bzw. werden bei leerem Budget abgelehnt. Jeder Zahlungsversuch steht auf der Platte, bevor er gesendet wird (Write-ahead): ein Neustart oder Absturz mitten in der Zahlung (das Herunterfahren wartet 37 s, eine Zahlung bis 150 s) verliert nichts — der neue Prozess zählt sie zum Höchstfee, lässt ihre beiden Kanäle in Ruhe und bucht sie (Fee, Hold, Sent-Zähler, am Sendetag), sobald LND weiß, wie sie endete. Ein manueller Refill zahlt nie neben der Rebalance-Stufe des Autopiloten und nie in oder aus einem Kanal, dessen frühere Zahlung noch landen kann (409; der Tab zeigt diese Zahlung statt eines Run-Buttons), hält aber den Rest eines Laufs (Fees, Lease-Versprechen, Kanalöffnungen, Magma) nicht mehr auf. Aus einer empfohlenen Zeile gestartet, trägt er das Gate mit und sein Preis wird wie bei einem Autopilot-Refill gehalten (vorher: kein Hold, die Engine konnte die Fee gleich danach senken). Nach dem Shutdown-Signal startet kein weiterer Versuch eines Refills (keine kleinere Größe, keine andere Quelle); das gilt als übersprungen, nicht als Fehlschlag. MPP für Refills ab 500k greift jetzt wirklich (die Feature-Bits der Rechnung gehen mit). Der Planer füllt die Slots mit den besten Zügen, die ins Budget passen. Vom Budget zurückgestellte Züge sind keine Fehlschläge (Entscheidungsnotiz statt Run-History). Stundenfenster in UTC.
- Einstellungen: „Amount“, „Target ≤ local“, „Source ≥ local“ (wirkungslos) entfernt; Mindestgewinn, Payback-Tage und Max-Betrag pro Refill sind einstellbar; der Legacy-Kandidaten-Endpunkt ist weg. Pro abgelehntem Kanal steht, was ein Refill bräuchte. „Max routing“ verspricht kein „loose rebalancing“ mehr.

### Stand 2026-10 (Fix-Paket P6)
- Rebalance-ROI nicht mehr über-kreditiert: jeder Refill bekommt nur die Fees der Forwards, die seine eigenen Sats aus dem Kanal getragen haben — FIFO wie beim Profit-Floor (ältester Refill zuerst, höchstens sein Betrag, kein Forward zählt doppelt); was laut LNDs „sent“-Zähler per Zahlung statt Forward abfloss, verbraucht Refills ohne Ertrag. Gewertet wird ein Refill, sobald seine Sats draußen sind oder nach 14 Tagen. Obergrenze, keine Differenz-in-Differenzen-Baseline (die lokale Balance vor dem Refill wird nicht aufgezeichnet); die Methode steht im Analytics-Tab. Der Profit-Floor ist unverändert.
- P&L vollständig: Close-Kosten aus den Close-Transaktionen und Sweeps selbst (lokal aus dem Raw-Hex geparst; der Funder zahlt Legacy-Close und Commitment, beim RBF-Close der Closer; Unbekanntes wird als „Kosten unbekannt“ gezählt, nie als 0); Rebalancing aus LNDs Zahlungen an den eigenen Node (auch bos/RTL/ThunderHub), das eigene Log ergänzt, was LND nicht mehr listet; kein Kosten-Ledger kappt mehr (Rebalances älter als 400 Tage werden pro Tag summiert, Verkäufe, bezahlte Servicegebühren und Käufe bleiben); Magma-Käufe (Rechnung + Routing-Fee) sind Kosten.
- Nach dem Review von P6: btcwallet führt ein selbst veröffentlichtes Commitment (es zahlt an keine Wallet-Adresse) für immer als unbestätigt — seine Fee fiel still weg. Als bestätigt gilt jetzt, was die Wallet bestätigt, die Close-Transaktion eines geschlossenen Kanals, was LND als Sweep eines Kanal-Outputs nennt, und alles, was eine bestätigte Transaktion ausgibt; ein per RBF ersetzter Sweep bleibt draußen. Weil btcwallet solche Transaktionen beim nächsten LND-Neustart verwirft, behält LightningMate eine eigene Kopie jeder Close-Transaktion samt Sweeps (close-txs.json; bei jedem P&L-/Score-Aufruf und stündlich, auch auf einem Read-only-Node). Die Funding-Fee eines Kanals, der noch öffnet oder schon schließt, bleibt Open-Kosten. Die Tagessummen des Rebalance-Logs zählen auch, wenn LND lesbar ist — für die Tage vor der ältesten Zahlung, die LND noch listet (nach `deletepayments`). Hinweistexte: ein abgeschnittener Forward-Abruf fehlt bei den NEUESTEN Forwards (LND liefert älteste zuerst) — 24h/7d und der Trend sagen das, statt „keine Forwards in 7 Tagen“; „Closes 800 · Sweeps früherer Closes“ statt „keine Closes“; die Kanal-Profitabilität sagt, dass Net = Fees − Rebalancing ist und „Brought in“ daneben steht.
- Nach dem zweiten Review von P6: Der Health-Score zählt Lease-Einnahmen (Magma und LSPS1, nach der bezahlten Servicegebühr, über die Lease verteilt wie gekauftes Inbound) wie die P&L — vorher zählten die Open-Kosten verkaufter Kanäle, ihre Einnahmen nicht, und ein Verkäufer im Plus las eine negative Rendite. Der Earnings-Hinweis nennt die größte Kostenart („weniger rebalancen“ nur, wenn Rebalancing sie ist; Opens/Closes: über ein Jahr verteilt, zahlen sich übers Routing zurück; gekauftes Inbound: beim Namen). Anchor-Kanäle: Der Funder zahlt beide 330-sat-Anchors (BOLT 3); die nicht von uns zurückgeholten zählen jetzt zu den Close-Kosten (bis 660 sat je Force-Close fehlten), und hat der Peer finanziert, ist der Anchor in unserem CPFP nicht unser Geld. Die Kopie der Close-Transaktionen speichert nach einem fehlgeschlagenen Schreiben beim nächsten Blick erneut (vorher erst, wenn sich etwas änderte — ein Neustart verlor sie).

---

# Anhang: Detail-Audits pro Subsystem

(Volltext der fünf Subsystem-Audits — Fees, Rebalancing, Magma, Learning/Ökonomie, Kapital/Orchestrierung — mit `file:line`-Referenzen und gerankten Fixes. Siehe Chat-Verlauf der Audit-Session; die Kernpunkte sind oben synthetisiert.)
