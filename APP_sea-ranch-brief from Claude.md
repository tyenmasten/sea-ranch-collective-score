# Sea Ranch Collective Score
## Project Brief — Version 1.0

---

## 1. Programme Overview

The Sea Ranch Collective Score is a browser-based field research tool developed for the Architectural Association Visiting School programme *The Sea Ranch as Prototype: Form. Culture. Context.*, running 19–28 July 2026 at The Sea Ranch, California.

The programme's intellectual core is language as architectural method: the argument that field note, notation, score, AI prompt, and design guideline are part of a continuous tradition of encoded spatial instruction. The methodology chain is:

**Observation → Notation → Score → Prompt → Proposition**

The tool operationalises this chain for a group of up to 15 students working collectively across a 10-day programme. It is the first iteration of a longitudinal research engagement intended to develop over multiple years toward a publication.

---

## 2. Tool Purpose

The tool supports three distinct activities:

**Field input** — students record georeferenced observations on site, placing notations on a live site map via GPS or manual location picker.

**Lexicon authorship** — each student builds a personal mark by composing from a set of base graphic primitives. This mark becomes their signature across the collective score.

**Collective output** — at an instructor-determined moment, the full collective score becomes visible to all participants simultaneously. The score is a georeferenced site map on which every student's lexicon mark is placed at its observed location.

The tool is browser-based, requires no installation, and is designed to work on desktop and mobile devices. It is unexpected in an architectural pedagogy context — that quality is intentional. Opening a browser tab during fieldwork feels closer to picking up an instrument than opening a CAD file.

---

## 3. Architecture

### Pages and Build Order

The tool is built as four standalone pages, integrated after individual development is complete.

**Page 1 — Lexicon Builder** *(build first)*
Students author their personal mark. The most conceptually significant page and the most interface-intensive.

**Page 2 — Location Input** *(build second)*
Students place notations on the site map via GPS or manual picker. Observations can be placed as dot placeholders before a lexicon is built, upgrading automatically once the lexicon is complete.

**Page 3 — Collective Score Viewer** *(build third)*
The assembled score — all student lexicon marks placed at their georeferenced observation locations across the site map. Instructor-controlled unlock.

**Page 4 — Lexicon Overview** *(build fourth)*
A grid of all student lexicon marks as rendered tiles. Selecting a tile surfaces the student's key data. Instructor-controlled unlock.

### Navigation Flow

Location Input → Collective Score Viewer → Lexicon Builder → Lexicon Overview

### Responsiveness

All pages are designed for both desktop and mobile. The Location Input page in particular must work well on a phone — this is the primary fieldwork interface. The Lexicon Builder is desktop-oriented but mobile-accessible.

---

## 4. Data Model

### Student Record
- Name
- Email (Microsoft 365 login)
- Role (student / instructor)

### Lexicon Entry
- Author (linked to student record)
- Lexicon name
- Primary shape (square / triangle / circle)
- Line modifier (angle, density, on/off)
- Pattern/fill (solid / hatched / dotted / none)
- Thickness
- Colour (hex value)
- Dimension (length, width, height)
- Status (draft / complete)

### Notation / Observation Record
- Author (linked to student record)
- Lexicon entry (linked, optional — dot placeholder if not yet built)
- Location (GPS coordinates)
- Form / Context / Culture (selection)
- Element (Landscape / People / Architecture)
- Typology (Single Family / Multi Unit / Public Facility)
- Size — imperial or metric (length, width, height)
- Description (long text)
- Information upload (image, video, drawing, scan)
- Timestamp
- Status (dot placeholder / lexicon mark)

### Programme State
- Collective score locked / unlocked (instructor toggle)
- Lexicon overview locked / unlocked (instructor toggle)

---

## 5. User Roles

### Student
- Login required via Microsoft 365
- Sees only their own dots, lexicon entry, and observations during the programme
- Cannot see other students' work until instructor unlocks
- Access to: Lexicon Builder, Location Input

### Instructor (Tyen Masten, Aiden Domican)
- Full access to all student data at all times
- Uploads and manages site reference layers (shapefiles, GeoJSON, SVG)
- Controls the unlock of Collective Score Viewer and Lexicon Overview
- Access to: all pages plus instructor controls

### Reveal State
- A single instructor-toggled flag in the database
- When unlocked, all student sessions update simultaneously
- Collective Score Viewer and Lexicon Overview become accessible to all students

---

## 6. Page Briefs

### Page 1 — Lexicon Builder

**Purpose:** Each student authors their personal graphic mark. The mark is composed from base primitives and renders live in the Drawing Viewer as parameters are adjusted.

**Layout (Desktop):** Two-column. Left column contains author, lexicon name, notation parameters, and dimension inputs. Right column contains metadata fields. Drawing Viewer occupies the centre.

**Layout (Mobile):** Single column. Drawing Viewer first, parameters below, metadata below that.

**Notation Parameters:**
- Primary shape — Square / Triangle / Circle (select one)
- Line modifier — on/off, with angle and density controls
- Pattern/fill — Solid / Hatched / Dotted / None
- Thickness — 2 / 1.5 / 1
- Colour — hex wheel + hex input field

**Dimension:**
- Length, Width, Height (imperial or metric)

**Drawing Viewer:**
- Live 2D canvas rendering mark in plan view
- Updates in real time as parameters change
- View toggle: Plan only (this iteration)
- 3D views (Plan / Front / Side / Axo) — deferred to next iteration

**Metadata Fields:**
- Meta Data — Form / Context / Culture (selection)
- Element — Landscape / People / Architecture (selection)
- Typology — Single Family / Multi Unit / Public Facility (selection)
- Size — imperial or metric toggle, length / width / height inputs
- Description — long text field
- Information Upload — image, video, drawing, scan

**Output:**
- Lexicon entry saved to Microsoft 365 / OneDrive via Microsoft Graph API
- Mark rendered as SVG for use in score and overview

---

### Page 2 — Location Input

**Purpose:** Students place georeferenced observations on the site map during fieldwork. Works as a dot placeholder before lexicon is built; upgrades to lexicon mark automatically on completion.

**Layout:** Author field and input controls above the map. Map occupies the majority of the screen. Zoom and Pan controls below.

**Input Controls:**
- Author (linked to login)
- Add Notation — Lexicon Name (auto-populated from student's lexicon entry if complete)
- Add by — GPS (auto) or Picker (manual tap on map)

**Map:**
- Site map of The Sea Ranch loaded from hosted reference layer
- Student's own dots or marks visible only
- Green dot = GPS-placed observation
- Dot upgrades to lexicon mark when lexicon entry is complete
- Zoom and Pan controls

**Reference Layers (instructor-uploaded):**
- Shapefiles — terrain, site geometry, coastal zones
- GeoJSON — QGIS exports
- SVG — archival drawings or reference plans as required

**GPS Behaviour:**
- Browser geolocation API
- On permission grant, coordinates are captured and dot placed at current position
- Fallback to manual picker if GPS unavailable or denied

---

### Page 3 — Collective Score Viewer

**Purpose:** The assembled collective score — all student lexicon marks placed at their georeferenced observation locations. Instructor-controlled unlock.

**Layout:** Full site map with marks distributed across it. Zoom and Pan controls. Selected notation data panel below map.

**Map:**
- Same site map and reference layers as Location Input
- All student marks visible (post-unlock)
- Blue dot = selected notation
- Tap/click a mark to select and surface data below

**Selected Notation Panel:**
- Author
- Lexicon name
- Location (coordinates or site reference)
- Form / Context / Culture
- Element
- Typology
- Description

**SVG Export (instructor):**
- Layer selection — choose which layers to include
- Scale — set output dimensions for AxiDraw plotter
- Export SVG
- Note: pen separation and path optimisation handled in plotter software (Inkscape / AxiDraw plugin)

**Drawing Inputs / Layers:**
- Lexicon input (student marks)
- Shapefiles — terrain etc
- GeoJSON
- SVG upload (instructor only)

---

### Page 4 — Lexicon Overview

**Purpose:** A browsable visual catalogue of all student lexicon marks. Instructor-controlled unlock.

**Layout:** Grid of rendered mark tiles (approximately 8x8). Selected tile highlighted. Key data panel below grid.

**Grid:**
- Each tile shows a student's lexicon mark rendered in plan view
- Unselected tiles — light blue
- Selected tile — darker blue highlight
- Tap/click to select

**Selected Mark Data Panel:**
- Author
- Lexicon name
- Form / Context / Culture
- Element
- Typology
- Description

**Output:**
- Drawing outputs as SVG
- Layer selection
- Scale
- Export

---

## 7. Visual Identity

**Typography:**
- Cormorant (serif) — headings, mark labels, programme title
- IBM Plex Mono — interface labels, data fields, metadata, all UI text

**Colour Palette:**
- Paper — #f2efe8 (warm off-white ground)
- Ink — #1a1a18 (near-black)
- Rule — #c8c3b4 (borders, dividers)
- Accent — #5c4a2a (warm brown, active states, labels)
- Dim — #9a9488 (secondary text, inactive states)
- Mark — #2a3d2e (dark green, mark rendering)

**Principles:**
- Declarative, restrained, AA institutional register
- No decorative elements — every visual element is functional
- Generous white space
- Interface disappears — the mark and the map are the experience
- Consistent with the graphic score tradition the programme draws on

---

## 8. Integrations

**Authentication**
- Microsoft 365 via AA account
- Microsoft Graph API for login and identity
- Student credentials provisioned by instructor before programme

**Storage**
- Microsoft OneDrive / SharePoint via Microsoft Graph API
- Lexicon entries, observations, uploads stored per student
- Programme state (locked/unlocked) stored as a single flag
- Estimated storage: 4–6GB for 10-day programme, well within AA OneDrive allocation (1TB)

**Location**
- Browser Geolocation API (GPS on mobile, network approximation on desktop)
- Manual location picker as fallback

**File Formats**
- Shapefiles (.shp, .zip) — site geometry input
- GeoJSON — QGIS export input
- SVG — reference layer input and score output
- Image, video, drawing, scan — student observation uploads

**AxiDraw Output**
- SVG export from Collective Score Viewer
- Layer selection and scale set in tool
- Pen separation and path optimisation handled in plotter software

---

## 9. Deferred to Next Iteration

- 3D mark views (Front, Side, Axo) in Drawing Viewer
- p5.js migration of mark rendering layer
- QGIS live integration (currently via GeoJSON export)
- Persistent storage across sessions (currently session-based)
- AI-generated image prompts from collective score (currently in previous tool version)
- Multi-year archival layer — programme iterations overlaid on same site map

---

## 10. Open Questions

- What Sea Ranch shapefiles and GeoJSON data are available and from which sources?
- Will students have AA Microsoft 365 credentials or will guest access be required?
- At what point during the programme is the collective score revealed — end of programme, mid-point, or at instructor discretion per session?
- How many base mark tiles should the Lexicon Overview grid display — fixed at student count or padded to a fixed grid?

---

*Brief compiled from programme development conversations, June 2026.*
*Tyen Masten Studio / AA Visiting School 2026.*
