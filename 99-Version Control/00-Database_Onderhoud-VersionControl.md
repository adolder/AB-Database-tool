# Database_Onderhoud - Version Control

## v0.21.1 - 2026-09-28
- Wat: `Database Onderhoud/params/flow-parameters.json` (runtime-status van de laatste verbinding) wordt niet meer in git bijgehouden en staat in `.gitignore`; `flow-parameters.json.example` is het gecommitte lege sjabloon. De wizard maakt het echte bestand zelf aan bij de eerste verbinding.
- Waarom: voorkomt dat een live verbinding (en elke wijziging daarvan) in de repository terechtkomt.
- Bestanden: `.gitignore`, `Database Onderhoud/params/flow-parameters.json.example` (nieuw).

## v0.21.0 - 2026-09-28
- Wat: De witte achtergrond van het ingebedde Acto-logo (`ACTO_LOGO` in `embedded-images.cjs`) is transparant gemaakt, zodat het logo de achtergrondkleur van de pagina overneemt. Alleen het met de rand verbonden witte vlak is aangepast (wit binnen het logo blijft behouden); randpixels zijn "ontmengd" van wit voor een gladde overgang.
- Waarom: het witte vlak rond het logo stak af tegen de paginakleur.
- Bestanden: `Database Onderhoud/scripts/embedded-images.cjs`.

## v0.20.0 - 2026-09-28
- Wat: Alle afbeeldingen van de wizard zijn nu als base64 ingebed in de nieuwe module `Database Onderhoud/scripts/embedded-images.cjs` (Designer.png en Acto Logo.png); de wizard leest niets meer uit de Pictures-map. Het zelfgebouwde CSS-logo op de Gebruikersbeheer-pagina's is vervangen door het echte Acto-logo.
- Waarom: de Pictures-map wordt regelmatig opgeschoond; het logo kwam niet overeen met het officiële Acto-logo.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`, `Database Onderhoud/scripts/embedded-images.cjs` (nieuw).

## v0.19.0 - 2026-09-28
- Wat: Op "Controleren gebruikers omgeving" toont de badge rechtsboven na een geslaagde verbinding nu "Verbonden met <omgeving>" (zonder punt) in plaats van "Actieve omgeving: <omgeving>"; de aparte succesmelding linksonder is vervallen. Foutmeldingen blijven linksonder staan.
- Waarom: één duidelijke verbindingsstatus op een vaste plek.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.18.0 - 2026-09-28
- Wat: "Intelligent Application Manager (IAM)" is nu afgeschermd (niet selecteerbaar) in de branchlijst van "Controleren gebruikers omgeving". Afgeschermde branches tonen niet langer de tekst "(afgeschermd)"; ze zijn alleen niet selecteerbaar. Het verbind-endpoint weigert afgeschermde omgevingen nu ook server-side (403).
- Waarom: IAM mag hier (voorlopig) niet gekozen worden; de extra label-tekst was overbodig; afscherming mocht niet alleen in de UI afgedwongen worden.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.17.0 - 2026-09-28
- Wat: De afbeelding op de menu keuze pagina vult nu het volledige venster (cover-schaling: `max(100vw,150vh)` / `max(100vh,66.67vw)`, gecentreerd, overloop bijgesneden) in plaats van passend binnen het venster met donkerblauwe randen. De beeldverhouding blijft behouden, zodat de klikzones uitgelijnd blijven op de kaarten.
- Waarom: de afbeelding moest het hele scherm omvatten.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.16.1 - 2026-09-28
- Wat: Bugfix — het opruimen van een oud wizard-browservenster bij het starten (geïntroduceerd in v0.7.0) werkte niet: het profielpad werd met verdubbelde backslashes aan PowerShell doorgegeven, waardoor geen enkel proces matchte en elke run een extra venster opende. Het pad wordt nu via een omgevingsvariabele doorgegeven en er wordt kort gewacht tot de oude processen gestopt zijn, zodat er steeds maar één wizardvenster openstaat.
- Waarom: meerdere openstaande wizardvensters konden tot werken in een verouderde sessie leiden.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.16.0 - 2026-09-28
- Wat: Op "Controleren gebruikers omgeving" worden de beschikbare branches nu in vaste volgorde getoond: Intelligent Application Manager (IAM), 8013 MAIN, 8609 EVO_ALPHA, 8984 EVO_GENOPS, 9110 EVO_NSYNC, 9038 EVO_BB, 8065 EVO_BOD; daarna de overige branches oplopend op nummer. EVO_ALPHA is niet langer afgeschermd. Het IAM-item heet nu "Intelligent Application Manager (IAM)" (zonder prefix "IAM - ").
- Waarom: gewenste volgorde en selecteerbaarheid van branches.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.15.0 - 2026-09-28
- Wat: De "Actieve omgeving"-badge wordt niet meer getoond op de Gebruikersbeheer-dashboardpagina. Op de pagina "Controleren gebruikers omgeving" blijft de badge verborgen totdat er op die pagina succesvol verbinding met een omgeving is gemaakt; daarna verschijnt hij met de gekozen omgeving.
- Waarom: de badge toonde op het dashboard en vóór een omgevingskeuze een verouderde omgeving (bv. IAM) uit een eerdere sessie.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.14.0 - 2026-09-22
- Wat: Achtergrond van de menu keuze pagina (het vlak rondom de afbeelding, zichtbaar bij een venster-aspectratio die afwijkt van 3:2) van lichtblauw naar donkerblauw (`#1c3f7a`) gezet.
- Waarom: lichtblauw paste niet goed bij de afbeelding.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.13.0 - 2026-09-22
- Wat: (1) Google Translate-melding standaard onderdrukt op alle wizardpagina's (`notranslate`/`translate="no"` op `<html>`/`<body>` + `<meta name="google" content="notranslate">`). (2) De menu-afbeelding schaalt nu naar de volledige beschikbare vensterruimte (`min(100vw,150vh)` / `min(100vh,66.67vw)`) in plaats van vast op max. 1536px breed, zonder bijsnijden zodat de klikzones correct blijven uitgelijnd.
- Waarom: Google Translate-popup moest standaard uit staan; de menu-afbeelding vulde de pagina niet als het venster groter was dan 1536px.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.12.0 - 2026-09-22
- Wat: De wizard-browser opent nu gemaximaliseerd (`--start-maximized` toegevoegd aan de Chrome-launchopties).
- Waarom: het venster opende voorheen in een standaard (niet-gemaximaliseerde) grootte.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.11.0 - 2026-09-22
- Wat: Kleurgebruik van de Gebruikersbeheer-pagina afgestemd op de menu keuze pagina: lichtblauwe gradient-achtergrond, witte panelen met dezelfde schaduw/radius als de kaarten, en de primaire knop in het donkerblauwe verloop (#1c3f7a → #2f5fa8) uit `Designer.png`.
- Waarom: de pagina oogde qua kleuren te los van de menu keuze pagina.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.10.0 - 2026-09-22
- Wat: Nieuwe "Gebruikersbeheer"-pagina (`/gebruikersbeheer`) toegevoegd, bereikbaar via de gelijknamige kaart op de menu keuze pagina. Toont een "Actieve omgeving"-paneel (uit `Database Onderhoud/params/flow-parameters.json`), en een inklapbaar paneel "Gebruikers controleren, toevoegen of opschonen" met checkboxes Gebruikers Controle DB / Gebruikers Toevoegen / Gebruikers Deactiveren; bij het aanvinken van Toevoegen verschijnt een "Bron selectie" (Vanuit de applicatie [nog niet geïmplementeerd] / Vanuit IAM). Nieuwe procesdefinities aangemaakt: `Database Onderhoud/processen/controle-gebruikers-db.process.json`, `toevoegen-gebruikers.process.json`, `deactiveren-gebruikers.process.json` + catalogus `processen.json`, en `Database Onderhoud/params/flow-parameters.json` met placeholderwaarden.
- Waarom: eerste concrete deelpagina van de wizard, opgezet volgens de aangeleverde referentieschermafbeelding.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`, `Database Onderhoud/params/flow-parameters.json`, `Database Onderhoud/processen/processen.json`, `Database Onderhoud/processen/controle-gebruikers-db.process.json`, `Database Onderhoud/processen/toevoegen-gebruikers.process.json`, `Database Onderhoud/processen/deactiveren-gebruikers.process.json`.

## v0.9.0 - 2026-09-22
- Wat: Klikzones van de drie kaarten op de menu keuze pagina gecorrigeerd op basis van pixelmetingen in `Designer.png` (witte kaartvlakken gescand i.p.v. geschat): links 12,2% / 38,0% / 64,1%, boven 48,8%, breedte ~23,9-24,2%, hoogte 40,6%.
- Waarom: de eerder geschatte klikzones kwamen niet overeen met de daadwerkelijke kaartposities in de afbeelding.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.8.0 - 2026-09-22
- Wat: Menu keuze pagina toont voortaan `Pictures/Designer.png` zelf (1:1, geen eigen interpretatie/CSS-nabouw) als volledige paginavisual. De drie kaarten ("Database anonimiseren", "Specifieke inrichting aanpassen", "Gebruikersbeheer") zijn klikbaar via onzichtbare overlay-knoppen die proportioneel over de kaarten in de afbeelding liggen en naar de placeholderpagina linken.
- Waarom: eerdere handmatige CSS/SVG-nabouwsels kwamen niet exact overeen met de referentieafbeelding; de gebruiker vroeg om exact dezelfde weergave.
- Let op: doordat de pagina nu een statische afbeelding is, kan de eerder gevraagde taalwissel (NL/EN) de tekst in de afbeelding zelf niet meer vertalen; die functionaliteit is voorlopig losgelaten totdat hierover een keuze is gemaakt.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.7.0 - 2026-09-22
- Wat: Bij het starten van de wizard wordt nu eerst een eventueel nog actief proces op poort 3232 gestopt, en wordt een achtergebleven wizard-browservenster van een vorige run (herkend aan het vaste Chrome-profielpad) gesloten voordat het nieuwe venster opent.
- Waarom: bij een herstart bleven anders oude serverprocessen/browservensters open staan.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.6.0 - 2026-09-22
- Wat: Menu keuze pagina visueel herbouwd om `Designer.png` te volgen: inline SVG pinwheel-logo (i.p.v. de onbruikbare zwarte-achtergrond "Logo - Dark.png"), decoratieve database/shield- en mensen/trash-iconen links/rechts van de header, diagonale lichtblauwe driehoek + donkerblauwe golf als achtergrondaccenten, en SVG-iconen (i.p.v. emoji) in de drie kaarten en de footer-trustbalk (met "|"-scheidingstekens).
- Waarom: de eerder gegenereerde pagina kwam nog niet overeen met de aangeleverde referentieafbeelding.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.5.0 - 2026-09-22
- Wat: Wizard-server gebouwd en gedraaid (`Database Onderhoud/scripts/wizard-serve.cjs`): opent direct op de menu keuze pagina (geen splashscreen), met NL/EN taalwissel, drie klikbare kaarten (Database anonimiseren / Specifieke inrichting aanpassen / Gebruikersbeheer) die naar een placeholderpagina linken, en een `/api/cancel`-endpoint. `url.parse()` vervangen door de WHATWG `URL`-API.
- Waarom: eerste werkende versie van de wizard opzetten conform de bijgewerkte instructions (geen splash, wel menu keuze pagina).
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.4.0 - 2026-09-22
- Wat: Duplicaat `Database Onderhoud/agents/` en `Database Onderhoud/instructions/` (aangemaakt door een eerdere agentrun) verwijderd. Agent en instructions horen uitsluitend in `.github/agents/` en `.github/instructions/` te staan; `Database Onderhoud/**` is voortaan alleen voor runtime/data-assets (scripts, processen, params). Agent- en instructionbestanden aangepast zodat ze niet meer naar het oude `Database Onderhoud/instructions/...`-pad verwijzen.
- Waarom: de vorige agentrun creëerde een ongewenste dubbele kopie van agent/instructions binnen de repo.
- Bestanden: `.github/agents/Database_Onderhoud.agent.md`, `.github/instructions/Database_Onderhoud-creation.instructions.md`.

## v0.3.0 - 2026-09-22
- Wat: Ontwerp van de menu keuze pagina vastgelegd in de wizard-instructions: header met ActoBusiness-logo/titel/tagline en drie klikbare kaarten ("Database anonimiseren", "Specifieke inrichting aanpassen", "Gebruikersbeheer"), conform `Designer.png`. Klik-doelen zijn nog placeholders.
- Waarom: concreet ontwerp aangeleverd voor de eerder aangekondigde menu keuze pagina.
- Bestanden: `.github/instructions/Database_Onderhoud-wizard.instructions.md`.

## v0.2.0 - 2026-09-22
- Wat: De wizard-flow na de splash pagina omgezet van de (uit de bronmap overgenomen) "selection page" naar een nog op te stellen, eigen "menu keuze" pagina. Bijgewerkt in agent en beide instructions.
- Waarom: de wizardpagina's worden niet 1-op-1 overgenomen uit `C:\ws_adolder\Database Onderhoud`, maar opnieuw opgezet.
- Bestanden: `.github/agents/Database_Onderhoud.agent.md`, `.github/instructions/Database_Onderhoud-creation.instructions.md`, `.github/instructions/Database_Onderhoud-wizard.instructions.md`.

## v0.1.0 - 2026-09-22
- Wat: Database_Onderhoud agent en bijbehorende instructions toegevoegd (`.github/agents/Database_Onderhoud.agent.md`, `.github/instructions/Database_Onderhoud-creation.instructions.md`, `.github/instructions/Database_Onderhoud-wizard.instructions.md`). De agent is opnieuw opgezet (niet 1-op-1 gekopieerd); de instructions zijn overgenomen uit `C:\ws_adolder\Database Onderhoud\instructions`.
- Waarom: start van de reconstructie van de Database Onderhoud-tool in deze repo, op de `dev_adolder`-branch.
- Bestanden: `.github/agents/Database_Onderhoud.agent.md`, `.github/instructions/Database_Onderhoud-creation.instructions.md`, `.github/instructions/Database_Onderhoud-wizard.instructions.md`.

