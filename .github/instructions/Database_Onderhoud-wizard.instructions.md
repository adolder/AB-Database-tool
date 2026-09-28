---
description: "Standards for creating and updating the Database Onderhoud wizard UI and flow."
applyTo: "Database Onderhoud/scripts/wizard-serve.cjs"
---

# Database Onderhoud Wizard Instructions

## Scope
Use this instruction file whenever creating or updating wizard-related behavior, UI, or flow for Database Onderhoud.

## Location Rule
- Keep all wizard-related files inside Database Onderhoud/**.
- Wizard runtime script location: Database Onderhoud/scripts/wizard-serve.cjs.

## Flow Requirements
- Wizard must start in a browser automatically when the server starts.
- Browser launch preference: Chrome first; fallback to other available browser only if Chrome is unavailable.
- The wizard opens directly on the menu keuze page — no splash screen.
- The menu keuze page replaces the source project's selection page; its content/design is not copied from C:\ws_adolder\Database Onderhoud.

## Visual/Structure Requirements
- Use Harvest wizard as the layout and structure reference.
- Keep a shared CSS approach and card-based page structure.

## Menu Keuze Page Requirements
- Visual reference: %USERPROFILE%/Pictures/Designer.png.
- Background: light blue gradient with the decorative circle/curve accents from the reference image.
- Header: ActoBusiness logo + title "database onderhoud", tagline "Beheer. Opschonen. Optimaliseren." below it.
- Body: three cards in a row, each with a colored icon badge, a title, an underline accent, and a short description:
  - "Database anonimiseren" (blue)
  - "Specifieke inrichting aanpassen" (green)
  - "Gebruikersbeheer" (purple)
- All three cards must be clickable; their target pages/flows are still to be defined, so route each click to a placeholder until the real destination exists.
- Footer strip with the three trust labels from the reference image ("Veilig & Betrouwbaar", "Efficiënt & Consistent", "Schoon & Actueel") is optional visual polish, not a functional requirement.

## Language Requirements
- Default language is Dutch.
- Menu keuze page: show language switch button at upper-right.
- Language switch must support both directions: Dutch <-> English.
- Language preference should persist via localStorage.

## Language Button Requirements
- Match the style intent of taalkeuze.jpg in Pictures (rounded pill with flag + language code).
- Button shows target language (what clicking will switch to):
  - Current Dutch -> show UK flag + EN.
  - Current English -> show Dutch flag + NL.
- Keep the button compact/small.

## Change Policy
- Preserve existing behavior unless explicitly requested to change it.
- Apply minimal, targeted edits.
- Validate the script starts successfully after wizard changes.
