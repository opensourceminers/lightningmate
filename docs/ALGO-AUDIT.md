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

---

# Anhang: Detail-Audits pro Subsystem

(Volltext der fünf Subsystem-Audits — Fees, Rebalancing, Magma, Learning/Ökonomie, Kapital/Orchestrierung — mit `file:line`-Referenzen und gerankten Fixes. Siehe Chat-Verlauf der Audit-Session; die Kernpunkte sind oben synthetisiert.)
