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

---

# Anhang: Detail-Audits pro Subsystem

(Volltext der fünf Subsystem-Audits — Fees, Rebalancing, Magma, Learning/Ökonomie, Kapital/Orchestrierung — mit `file:line`-Referenzen und gerankten Fixes. Siehe Chat-Verlauf der Audit-Session; die Kernpunkte sind oben synthetisiert.)
