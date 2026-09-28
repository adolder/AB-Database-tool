# Database_Onderhoud - Version Control

## v0.54.0 - 2026-10-01
- Wat: Na een geslaagde aanmaak op "Gebruikers toevoegen omgeving" blijft de melding "Gebruiker aangemaakt (employee_id: …)." zichtbaar en wordt de knop Uitvoeren inactief gemaakt. De velden blijven ongewijzigd staan (geen automatische opschoning); pas na een klik op het opschoon-icoon worden ze geleegd (met standaardwaarden terug voor Geslacht, Intern/extern, Datum in dienst, Administratie en Afdeling) en wordt Uitvoeren weer actief voor de volgende gebruiker.
- Waarom: voorkomt een dubbele aanmaak-poging zolang het scherm nog de vorige, nog niet opgeschoonde gegevens toont.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.53.0 - 2026-10-01
- Bugfix: "Uitvoeren" op "Gebruikers toevoegen omgeving" gaf altijd "Aanmaken van de gebruiker is mislukt." (generieke `unknown_error`). Oorzaken:
  - `create_employee` miste het veld `surname_prefix` (Tussenvoegsel werd niet meegestuurd); dat ontbrekende/overtollige veld deed de hele taakaanroep stuklopen zonder bruikbare foutmelding in de response-body.
  - IAM/Indicium zet de echte foutdetails (bv. duplicate-key) in de base64-gecodeerde response-header `tsfmessages`, niet in de (vrijwel altijd lege) response-body; die werd nergens gelezen. Nieuwe helper `friendlyTsfErrorMessage` decodeert deze header en vertaalt bekende gevallen (zoals een dubbele gebruikersnaam/e-mailadres) naar een duidelijke Nederlandse melding.
  - Het 3-delige proces miste een stap: tussen `quick_add_employee_decision_build_http_input` en `quick_add_employee_http_connector` ontbrak de daadwerkelijke HTTP-aanroep naar `add_or_update_iam_user_url` (de echte sync naar IAM), geauthenticeerd met het eenmalige `username`/`strange_string` uit stap 2. Zonder die aanroep bleven `http_status_code`/`status_code` null en werd de koppeling nooit echt gelegd.
- Waarom: het aanmaakproces moet daadwerkelijk werken, met herkenbare foutmeldingen bij een echte fout.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.52.0 - 2026-09-30
- Wat: Datum in dienst en Datum uit dienst op "Gebruikers toevoegen omgeving" zijn vervangen door een gesegmenteerde dd/mm/jjjj-invoer (drie losse vakjes voor dag/maand/jaar die er als één veld uitzien): de opmaak blijft altijd zichtbaar, met automatische focusverplaatsing na 2/2/4 cijfers en navigatie met de pijltjestoetsen/Backspace//, zoals gebruikers gewend zijn van een natuurlijk datumveld. Alle bestaande logica (validatie, standaardwaarden, reset, payload) blijft ongewijzigd werken doordat de container-`<div>` een `.value`-property (dd/mm/yyyy) en `.name` krijgt via `Object.defineProperty`.
- Waarom: de eerdere platte tekstinvoer met automatische `/`-invoeging voelde niet gebruiksvriendelijk en de opmaak verdween tijdens het typen.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.51.0 - 2026-09-30
- Wat: Alle tekst-/telefoon-/e-mailvelden op "Gebruikers toevoegen omgeving" (Achternaam, Tussenvoegsel, Voornaam, Telefoon, Mobiel, E-mailadres) en het formulier zelf hebben nu `autocomplete="off"`, zodat de browser geen eerder ingevoerde waarden meer als suggestie toont. Gebruikersnaam en Wachtwoord(bevestigen) hadden dit al.
- Waarom: eerder ingevoerde gegevens mogen niet worden herkend/voorgesteld bij het invullen van een nieuw formulier.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.50.0 - 2026-09-30
- Wat: Na een geslaagde `quick_add_employee_decision_build_http_input` roept `POST /api/gebruikersbeheer/toevoegen-omgeving/create-user` nu ook de derde en laatste stap aan: de IAM-taak `quick_add_employee_http_connector` (alle velden uit de output van stap 2, aangevuld met `http_connector_show_msg_create_iam_user_succeeded: 1` en `http_connector_stop: null`). Deze stap voert de daadwerkelijke koppeling met IAM uit via `add_or_update_iam_user_url`. Geeft de respons een `http_status_code` buiten de 200-reeks, dan meldt de pagina dat de gebruiker wel is aangemaakt maar de IAM-koppeling niet is gelukt. Hiermee is het 3-delige aanmaakproces (create_employee → quick_add_employee_decision_build_http_input → quick_add_employee_http_connector) compleet.
- Waarom: derde en laatste onderdeel van het proces om een gebruiker daadwerkelijk aan te maken en aan IAM te koppelen.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.49.0 - 2026-09-30
- Wat: Na een geslaagde `create_employee` roept `POST /api/gebruikersbeheer/toevoegen-omgeving/create-user` nu ook de tweede stap van het aanmaakproces aan: de IAM-taak `quick_add_employee_decision_build_http_input` (met `employee_id`/`login_name`/`iam_password` uit stap 1 en `system_company_id`), die de URLs en gegevens teruggeeft die nodig zijn om de gebruiker aan IAM te koppelen (`add_or_update_iam_user_url`, `find_iam_user_url`, `strange_string`, `username`). Mislukt deze stap, dan meldt de pagina dat de gebruiker wel is aangemaakt maar de IAM-koppeling niet is gelukt. Dit is stap 2 van het 3-delige aanmaakproces; stap 3 (de daadwerkelijke IAM-koppeling met deze URLs) volgt nog.
- Waarom: tweede onderdeel van het proces om een gebruiker daadwerkelijk aan te maken.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.48.0 - 2026-09-30
- Wat: Uitvoeren op "Gebruikers toevoegen omgeving" roept nu (na alle client-side validaties) het nieuwe endpoint `POST /api/gebruikersbeheer/toevoegen-omgeving/create-user` aan. Dat endpoint valideert de verplichte velden en de wachtwoordbevestiging opnieuw server-side, haalt `system_company_id` op uit `system_company` van de verbonden omgeving, bouwt de payload voor de IAM-taak `create_employee` (gender, surname, first_name, initials, login_name, iam_password(+confirmation), department_id, system_administration_id, user_group_id, employee_function_id/employee_role_id (optioneel), phone_number, phone_number_mobile, e_mail_address, employee_plannable, employment_internal_external, start_date_of_employment, person_company=0) en roept die taak aan via een nieuwe generieke `postJsonToUrl`-helper. Bij succes toont de pagina "Gebruiker aangemaakt (employee_id: …)."; bij een fout de IAM-foutmelding. Dit is stap 1 van het 3-delige aanmaakproces; de andere twee onderdelen volgen nog.
- Waarom: eerste onderdeel van het proces om een gebruiker daadwerkelijk aan te maken.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.47.0 - 2026-09-30
- Wat: Rechtsboven in het paneel "Gebruikers toevoegen" op "Gebruikers toevoegen omgeving" staat een opschoon-icoon (transparante achtergrond, cirkelvormige pijl). Het wist alle velden, behalve dat velden met een standaardwaarde (Geslacht, Intern/extern, Datum in dienst, Administratie, Afdeling) die standaardwaarde terugkrijgen in plaats van leeg te worden.
- Waarom: snel het formulier kunnen opschonen zonder de standaardinstellingen kwijt te raken.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.46.1 - 2026-09-30
- Wat: Annuleren op het formulier "Gebruikers toevoegen omgeving" ging terug naar de Gebruikersbeheer-dashboardpagina in plaats van de hele wizard af te sluiten.
- Waarom: Annuleren op een invoerformulier moet de huidige actie afbreken, niet de wizard sluiten.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.46.0 - 2026-09-30
- Wat: De knop Annuleren is verwijderd van "Gebruikers toevoegen omgeving" (alleen Uitvoeren blijft over).
- Waarom: op verzoek van de gebruiker.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.45.0 - 2026-09-30
- Wat: Keuzelijsten Functie en Rol op "Gebruikers toevoegen omgeving" worden na verbinden gevuld uit resp. `employee_function` (`employee_function_description_display`) en `employee_role` (`employee_role_description_display`) van de verbonden omgeving, gesorteerd op naam. De bijbehorende `employee_function_id`/`employee_role_id` worden als onzichtbare waarde van de keuze vastgehouden voor het aanmaken van de gebruiker. Nieuwe endpoints: `GET /api/gebruikersbeheer/toevoegen-omgeving/employee-functions` en `GET /api/gebruikersbeheer/toevoegen-omgeving/employee-roles`.
- Waarom: functie en rol moeten uit de omgeving gekozen worden; de id's zijn nodig bij de verwerking.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.44.0 - 2026-09-30
- Wat: Bij het klikken op Uitvoeren op "Gebruikers toevoegen omgeving" (dit gebeurde al bij elke submit) toont de melding nu ook welke verplichte velden nog leeg zijn, bv. "Vul de verplichte velden in: Wachtwoord, E-mailadres." (leeg gebleven velden krijgen ook een rode rand).
- Waarom: duidelijker maken welke velden nog ontbreken.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.43.0 - 2026-09-30
- Wat: Datum in dienst op "Gebruikers toevoegen omgeving" wordt standaard gevuld met de 1e dag van de maand volgend op de huidige datum (was: morgen).
- Waarom: logische standaard indiensttreddatum.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.42.0 - 2026-09-30
- Wat: Op "Gebruikers toevoegen omgeving" zijn nu ook Wachtwoord, Wachtwoord bevestigen, Gebruikersgroep en Datum in dienst verplichte velden (naast de al verplichte Achternaam, Voornaam, Gebruikersnaam, Afdeling, Administratie en E-mailadres). Geslacht en Intern/extern waren al impliciet verplicht doordat er altijd een keuze vooraf geselecteerd staat.
- Waarom: deze gegevens zijn nodig om een gebruiker aan te kunnen maken.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.41.1 - 2026-09-30
- Bugfix: op "Gebruikers toevoegen omgeving" bleef de omgevingenlijst nooit verschijnen ("Bezig met ophalen van omgevingen..." permanent) sinds de e-mailcontrole (v0.40.0) was toegevoegd. Oorzaak: een overtollige `})` in de e-mailcontrole-code gaf een JavaScript-syntaxfout die het hele ingesloten script blokkeerde, inclusief het ophalen van de omgevingenlijst. De v0.41.0-fix (retry bij mislukte aanroep) loste dit niet op omdat het script nooit tot uitvoering kwam.
- Waarom: echte oorzaak van het vastlopen verhelpen.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.41.0 - 2026-09-30
- Bugfix: op branchselectie-pagina's (o.a. "Gebruikers toevoegen omgeving") kon de tekst "Bezig met ophalen van omgevingen..." permanent blijven staan als de eerste aanroep van `/api/gebruikersbeheer/branches` mislukte (bv. vlak na het starten van de wizard); de polling gaf het dan stil op. `pollBranches` blijft nu ook na een mislukte aanroep opnieuw proberen.
- Waarom: de pagina moest zichzelf herstellen zonder handmatige page-refresh.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.40.0 - 2026-09-30
- Wat: Na de syntax- en domeincontrole van E-mailadres op "Gebruikers toevoegen omgeving" wordt ook gecontroleerd of het e-mailadres al voorkomt in de tabel `employee` (`relationship_email_address`, hoofdletterongevoelig) van de verbonden omgeving. Bestaat het al, dan verschijnt "E-mailadres bestaat al in deze omgeving." en blokkeert Uitvoeren. Nieuw endpoint: `GET /api/gebruikersbeheer/toevoegen-omgeving/check-email-exists?email=…`. De check op bestaande gebruikersnaam is hergebruikt via een generieke `employeeFieldValueExists`-helper.
- Waarom: e-mailadres moet uniek zijn.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.39.0 - 2026-09-30
- Wat: E-mailadres op "Gebruikers toevoegen omgeving" krijgt na het verlaten van het veld een volledige controle: niet leeg, precies één @-teken, minimaal 1 teken v\u00f3\u00f3r en na de @, geen spaties, deel v\u00f3\u00f3r de @ (max. 64 tekens) bevat alleen letters/cijfers/`.`/`_`/`-`/`+`/`%` en mag niet met een punt beginnen/eindigen of `..` bevatten, domein bevat minimaal \u00e9\u00e9n punt en geen `..`, mag niet met een koppelteken beginnen/eindigen, de extensie achter de laatste punt bestaat uit 2-24 letters, totale lengte max. 254 tekens. Daarna wordt het domein gecontroleerd op een bestaand DNS/MX-record. Onder het veld verschijnt de foutmelding of "Domein controleren..."; Uitvoeren blokkeert zolang het adres niet geldig is. Nieuw endpoint: `GET /api/gebruikersbeheer/toevoegen-omgeving/check-email-domain?domain=…`.
- Waarom: e-mailadres moet daadwerkelijk geldig en bereikbaar zijn.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.38.0 - 2026-09-30
- Wat: Datum uit dienst op "Gebruikers toevoegen omgeving" moet nu minimaal 1 dag na Datum in dienst liggen; tijdens het typen verschijnt bij overtreding een melding en rode rand, en de datumkiezer staat geen eerdere datum meer toe. Uitvoeren blokkeert ook bij een ongeldige combinatie.
- Waarom: uit dienst mag niet gelijk aan of voor in dienst liggen.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.37.1 - 2026-09-30
- Wat: Op "Gebruikers toevoegen omgeving" is er meer verticale ruimte tussen de rij Persoonsgegevens/Dienstverband en de rij Gebruikersgegevens/Werknemergegevens.
- Waarom: die twee rijen stonden te dicht op elkaar.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.37.0 - 2026-09-30
- Wat: Op "Gebruikers toevoegen omgeving" staan Persoonsgegevens en Dienstverband nu naast elkaar (twee kolommen), en Gebruikersgegevens en Werknemergegevens ook naast elkaar.
- Waarom: betere benutting van de beschikbare breedte.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.36.0 - 2026-09-30
- Wat: De lookup (vergrootglas) bij Gebruikersgroep op "Gebruikers toevoegen omgeving" is actief: een pop-up "Gebruikersgroepen" toont de gegevens uit `company_brand_user_groups` van de verbonden omgeving (Gebruikersgroep, Omschrijving, Product, Klantspecifiek), doorzoekbaar en gesorteerd op omschrijving, met de knoppen Selecteren en Sluiten (dubbelklik selecteert, Escape sluit). Het veld toont de omschrijving; het `user_group_id` wordt onzichtbaar vastgehouden (`userGroupId`) voor het aanmaken van de gebruiker. Nieuw endpoint: `GET /api/gebruikersbeheer/toevoegen-omgeving/user-groups`.
- Bugfix: de Afdeling-pop-up opende ook bij klikken op het veld of het label; deze opent nu alleen nog via het vergrootglas.
- Waarom: gebruikersgroep moet uit de omgeving gekozen worden; pop-up mag alleen bewust geopend worden.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.35.0 - 2026-09-30
- Wat: De keuze Geslacht op "Gebruikers toevoegen omgeving" levert nu de waarde voor het veld `gender`: man = 0, vrouw = 1 (formulierveld `gender`, voorheen `geslacht` met M/V).
- Waarom: deze waarden zijn nodig bij het aanmaken van de gebruiker.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.34.0 - 2026-09-30
- Wat: Administratie op "Gebruikers toevoegen omgeving" wordt standaard gevuld met de administratie uit `system_administration` waarvoor `is_initial_administration` = true (inclusief bijbehorend `system_administration_id`).
- Waarom: logische standaardadministratie bij het aanmaken van een gebruiker.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.33.0 - 2026-09-30
- Wat: Keuzelijst Administratie op "Gebruikers toevoegen omgeving" wordt na verbinden gevuld met de administraties (`system_administration_name`) uit de tabel `system_administration` van de verbonden omgeving, gesorteerd op naam. Het `system_administration_id` wordt als onzichtbare waarde van de keuze vastgehouden voor het aanmaken van de gebruiker. Nieuw endpoint: `GET /api/gebruikersbeheer/toevoegen-omgeving/administrations`.
- Waarom: administratie moet uit de omgeving gekozen worden; het id is nodig bij de verwerking.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.32.0 - 2026-09-30
- Wat: Op "Gebruikers toevoegen omgeving" wordt na het verbinden de afdelingenlijst direct opgehaald en wordt Afdeling standaard gevuld met "Administratie" (als die afdeling in de omgeving bestaat en werknemers toestaat). Het bijbehorende `department_id` wordt, net als bij een keuze via de lookup, onzichtbaar vastgehouden in het formulier (`afdelingId`) voor het aanmaken van de gebruiker. De lookup gebruikt dezelfde, eenmalig opgehaalde lijst.
- Waarom: snellere invoer met een logische standaardafdeling; department_id is nodig bij de verwerking.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.31.0 - 2026-09-30
- Wat: De lookup (vergrootglas) bij Afdeling op "Gebruikers toevoegen omgeving" is actief. Klikken op het vergrootglas of het veld opent een pop-up "Afdelingen" met de afdelingen uit de tabel `department` van de verbonden omgeving (alleen afdelingen waar werknemers zijn toegestaan, gesorteerd op naam). Links een doorzoekbare lijst met de kolommen Administratie, Afdeling, Afdelingscode en Kostenplaats; rechts de beperkte details "Toegestaan bij afdeling" (Projecten, Contracten, Opdrachten, Werknemers, Crediteuren, Debiteuren) van de geselecteerde regel. Selecteren (of dubbelklik) vult het veld Afdeling en onthoudt het `department_id`; Sluiten/Escape sluit zonder wijziging. Afdeling is alleen nog via de lookup te vullen. Nieuw endpoint: `GET /api/gebruikersbeheer/toevoegen-omgeving/departments`.
- Waarom: afdeling moet gekozen worden uit de bestaande afdelingen van de omgeving, zoals in de applicatie.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.30.0 - 2026-09-30
- Wat: Op "Gebruikers toevoegen omgeving" wordt na het verlaten van het veld Gebruikersnaam gecontroleerd of de naam al als `login_name` voorkomt in de tabel `employee` van de verbonden omgeving (hoofdletterongevoelig). Onder het veld verschijnt "Gebruikersnaam bestaat al in deze omgeving." (rood) of "Gebruikersnaam is beschikbaar." (groen). Uitvoeren is geblokkeerd zolang de naam bestaat, nog wordt gecontroleerd of de controle is mislukt. Nieuw endpoint: `GET /api/gebruikersbeheer/toevoegen-omgeving/check-login?login=…` (OData-filter op `employee`, met terugval op de volledige lijst).
- Waarom: gebruikersnamen moeten uniek zijn.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.29.0 - 2026-09-30
- Wat: Voorletter(s) op "Gebruikers toevoegen omgeving" bevat nu de beginletter van elke voornaam, elk gevolgd door een punt (bv. "Andre Johannes" → "A.J.", "Jan-Willem" → "J.W.").
- Waarom: bij meerdere voornamen moeten alle voorletters worden overgenomen.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.28.1 - 2026-09-30
- Wat: Bij Voornaam en Achternaam op "Gebruikers toevoegen omgeving" worden alle letters behalve de eerste letter van elk woord automatisch klein gemaakt (bv. "ANDRE" → "Andre").
- Waarom: alleen de beginletters mogen hoofdletters zijn.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.28.0 - 2026-09-30
- Wat: Op "Gebruikers toevoegen omgeving" krijgt Achternaam automatisch een hoofdletter aan het begin (ook na spatie/koppelteken, bv. Jansen-Pietersen); Tussenvoegsel wordt altijd in kleine letters gezet.
- Waarom: consistente schrijfwijze van namen.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.27.0 - 2026-09-30
- Wat: Wachtwoord en Wachtwoord bevestigen op "Gebruikers toevoegen omgeving" hebben een oog-icoon in het invoerveld om het wachtwoord te tonen/verbergen. Het icoon is alleen actief als het veld invulbaar is; bij afschermen wordt het wachtwoord weer verborgen.
- Waarom: gebruiker kan het ingevoerde wachtwoord controleren.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.26.0 - 2026-09-30
- Wat: Op "Gebruikers toevoegen omgeving":
  - Voorletter(s) is afgeschermd voor invoer en wordt automatisch gevuld met de eerste letter van Voornaam in hoofdletter plus punt (Andre → A.). Voornaam krijgt automatisch een hoofdletter aan het begin van elk woord.
  - Wachtwoord is pas invulbaar als Gebruikersnaam gevuld is; Wachtwoord bevestigen pas als Wachtwoord gevuld is. Wordt een veld leeggemaakt, dan worden de afhankelijke velden geleegd en weer afgeschermd.
  - Direct tijdens het typen wordt gecontroleerd of Wachtwoord bevestigen gelijk is aan Wachtwoord (rode rand + melding); Uitvoeren blokkeert bij verschil.
- Waarom: consistente invoer en voorkomen van foutieve wachtwoorden.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.25.2 - 2026-09-30
- Wat: Bij Geslacht op "Gebruikers toevoegen omgeving" is de derde keuze (overig) verwijderd; alleen man en vrouw blijven over.
- Waarom: op verzoek van de gebruiker.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.25.1 - 2026-09-30
- Wat: Op "Gebruikers toevoegen omgeving" scrolt alleen het veldengedeelte van het formulier; paginatitel, paneelkop en de knoppen Uitvoeren/Annuleren blijven in beeld.
- Waarom: het lange formulier liet de hele pagina scrollen.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.25.0 - 2026-09-30
- Wat: Op "Gebruikers toevoegen omgeving" verschijnt na verbinden het invoerformulier met dezelfde velden als het Werknemer-scherm in de applicatie: Persoonsgegevens (geslacht, achternaam, tussenvoegsel, voornaam, voorletters), Gebruikersgegevens (gebruikersnaam, wachtwoord + bevestiging, afdeling, administratie, gebruikersgroep), Werknemergegevens (functie, rol, telefoon, mobiel, e-mailadres, planbaar) en Dienstverband (intern/extern, datum in/uit dienst). Uitvoeren valideert verplichte velden, e-mailadres, wachtwoordbevestiging en datumvolgorde; opslaan in de omgeving is nog niet ingericht. Annuleren gebruikt het gedeelde afsluitcontract. Keuzelijsten (administratie, functie, rol) en zoekknoppen (afdeling, gebruikersgroep) worden nog niet gevuld.
- Waarom: vastleggen welke gegevens nodig zijn om een gebruiker toe te voegen.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.24.0 - 2026-09-30
- Wat: De verbindingsbadge rechtsboven toont na verbinden naast de omgeving ook het applicatie-ID, bv. "Verbonden met EVO_NSYNC (…)". Het connect-endpoint geeft hiervoor `applicationId` mee. Geldt voor alle pagina's met branchselectie (Controleren gebruikers omgeving/IAM, Gebruikers toevoegen omgeving).
- Waarom: gebruiker kan controleren of echt met de juiste omgeving is verbonden.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.23.0 - 2026-09-30
- Wat: Nieuwe pagina "Gebruikers toevoegen omgeving" (`/gebruikersbeheer/toevoegen-omgeving`). Net als bij "Controleren gebruikers omgeving" begint de pagina met de branchselectie (Beschikbare branches) en de knop Verbinden; na een geslaagde verbinding verschijnt een paneel "Gebruikers toevoegen" waarvan de volgende stap nog wordt ingericht. De gedeelde paginafunctie kreeg hiervoor een `connectOnly`-optie. Het sidebar-item "Omgeving" onder Gebruikers toevoegen is nu wit (ingericht).
- Waarom: start van het inrichten van het proces Gebruikers toevoegen omgeving.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

## v0.22.0 - 2026-09-30
- Wat: In de Gebruikersbeheer-sidebar worden nav-onderdelen zonder geïmplementeerd proces (Gebruikers toevoegen, Gebruikers deactiveren, Gebruiker schonen IAM) rood weergegeven; onderdelen die al zijn ingericht (Dashboard, Controleren gebruikers, Configuratie IAM gegevens, Afsluiten) blijven wit. Zodra een onderdeel een eigen pagina/route krijgt, wordt het automatisch weer wit (via de nieuwe `built`-vlag per nav-item).
- Waarom: visueel duidelijk maken welke onderdelen nog niet verder zijn ingericht.
- Bestanden: `Database Onderhoud/scripts/wizard-serve.cjs`.

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

