# 99-Version Control

Dit is het changelog-proces voor deze repository (AB-Database-tool).

## Doel
Elke functionele wijziging (nieuwe/gewijzigde/verwijderde logica, gedrag of features — inclusief bugfixes met impact) wordt vastgelegd in een logbestand, zodat de geschiedenis van een onderdeel in één bestand terug te lezen is.

## Structuur
- Per capability/onderdeel ("subject") is er één logbestand, genummerd vanaf `00-`.
- Wijzigingen die niet aan een specifiek subject hangen gaan in `99-General-VersionControl.md`.
- `Log-Entry-Template.md` bevat het vaste format voor een nieuwe entry.

## Huidige subject-logs
- `00-Database_Onderhoud-VersionControl.md` — de Database Onderhoud agent, instructions, wizard en processen.

## Regels
- Nieuwste entry bovenaan het bestand (direct onder de titel), niet onderaan toevoegen.
- Elke entry krijgt een versienummer volgens `vMAJOR.MINOR.PATCH`.
- Alleen functionele wijzigingen loggen. Puur tekstuele/cosmetische wijzigingen (labels, titels, wording, kleuren) zijn geen nieuwe entry/versie.
- Een hersteld regressiebugje (functionaliteit die kort stuk was en teruggezet is naar het oorspronkelijk bedoelde gedrag) is een bugfix, geen aparte log-entry voor de kapotte tussentoestand.
