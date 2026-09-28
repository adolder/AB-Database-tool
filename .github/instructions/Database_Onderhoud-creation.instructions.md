---
description: "Rules for creating and maintaining the standalone Database Onderhoud capability."
applyTo: "Database Onderhoud/**"
---

# Database Onderhoud Creation Rules

## Goal
Build and maintain Database Onderhoud as a standalone function.

## Mandatory Location Rule
- Runtime/data assets created for Database Onderhoud (wizard script, processen, params) must be placed in Database Onderhoud or one of its subfolders.
- The agent definition and its instructions live in .github/agents/ and .github/instructions/ respectively — do NOT duplicate them under Database Onderhoud/.
- Do not place Database Onderhoud runtime assets in .github, root-level unrelated folders, or any external path.
- If a needed subfolder does not exist, create it under Database Onderhoud and then place new files there.

## Required Folder Structure
- Database Onderhoud/params/
- Database Onderhoud/processen/
- Database Onderhoud/scripts/

## Agent Creation Process
1. Define or update instructions in .github/instructions/ first.
2. Create or update the agent file in .github/agents/.
3. Add or update process definitions in Database Onderhoud/processen/ when needed.
4. Verify all runtime/data assets for this capability are confined to Database Onderhoud/**, and all agent/instruction assets stay in .github/**.

## Wizard Baseline Requirement
- The Database Onderhoud agent must start with a wizard flow.
- The wizard opens directly on the menu keuze page (this repo's own page, not the source project's selection page) — no splash screen.
- Place wizard runtime code under Database Onderhoud/scripts/ (or a subfolder under Database Onderhoud).

## Wizard Instruction File (Mandatory)
- For any wizard creation or update, use .github/instructions/Database_Onderhoud-wizard.instructions.md as the primary instruction source.
- Treat that file as the canonical checklist for wizard flow, browser behavior, language behavior, and button styling rules.

## Guardrails
- Keep files focused on Database Onderhoud functionality only.
- Use clear names and concise descriptions so files remain maintainable.
- Prefer incremental updates over broad refactors.
