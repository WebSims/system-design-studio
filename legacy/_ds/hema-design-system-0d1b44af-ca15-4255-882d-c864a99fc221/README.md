# HEMA Design System

> *"Exceptional simplicity."* — HEMA brand essence

A design system for **HEMA**, the quintessential Dutch variety chain founded in 1926 in Amsterdam as *Hollandsche Eenheidsprijzen Maatschappij Amsterdam* ("Holland Unitary Pricing Company Amsterdam"). HEMA designs and manufactures nearly all of its own products and operates ~750 stores across 9 European countries. The brand is loved for its affordability, its in‑house product design, and its instantly recognisable red square logo.

The brand's defining traits, in HEMA's own words, are: **optimistic, unique, clear, reliable, accessible, and typically Dutch.** Every product should be *"functional AND special"* — never one without the other.

---

## Sources used

This design system was assembled from public brand references because no Figma file, codebase, or design tokens were supplied. The following sources informed colors, type, voice, and visuals:

- **HEMA corporate brand page** — https://www.hema.nl/i/department-store (brand essence, history, tone of voice)
- **Wikipedia: HEMA (store)** — https://en.wikipedia.org/wiki/HEMA_(store)
- **Koeweiden Postma rebrand case study** — https://europeandesign.org/koeweiden-postma/ (the 2007 rebrand introduced the 13‑colour logo system, real‑people photography, and the unified grid)
- **Behance brand guidelines extract** — https://www.behance.net/gallery/28141353/Hema (Dutch‑language fragment confirming one font in three weights, lowercase setting, 12+1 logo colours)
- **MyFonts — Hurme for HEMA** — https://www.myfonts.com/collections/for-hema-font-hurme (HEMA's custom 7‑weight typeface, *Hurme Geometric Sans No.3*, by Toni Hurme — proprietary, paid)
- **Dutch Design Daily — HEMA food packaging** — https://dutchdesigndaily.com/stories/sogood/ (hand‑drawn watercolours on white, "natural, honest, pure, fresh, quality, delicious")
- **HEMA on Brandfetch** — https://brandfetch.com/hema.nl (logo reference)

> ⚠️ **No codebase or Figma was attached.** Everything in this system is therefore a *best‑effort recreation* from public brand information. The UI kit screens (web shop, mobile app) are visual recreations of the HEMA store experience inspired by hema.nl — they are **not** lifted from real production code. If you want pixel parity, please attach the real codebase or Figma file and I'll iterate.

---

## What's in this folder

| File / folder | What it contains |
| --- | --- |
| `README.md` | This document. Brand context, content fundamentals, visual foundations, iconography. |
| `SKILL.md` | Agent‑Skill manifest. Lets this folder be used as a downloadable Claude Code skill. |
| `colors_and_type.css` | All design tokens. Color variables, type scale, semantic CSS for `h1`–`p`, spacing, radii, shadows. |
| `fonts/` | Web fonts. Hurme for HEMA (Regular, SemiBold, Bold) — see "Brand font" below. |
| `assets/` | Logos, icon notes, illustrations, generic imagery. |
| `preview/` | The small specimen cards that populate the Design System review tab. |
| `ui_kits/web/` | Web‑shop UI kit: home, category, product detail, cart, account. JSX components + `index.html`. |
| `ui_kits/app/` | Mobile app UI kit: home, scan & save, orders, account. JSX components + `index.html`. |

---

## Brand font ✓

This system uses **Hurme for HEMA** (Hurme Geometric Sans No.3, by Toni Hurme) — HEMA's custom typeface, supplied as three weights in `fonts/`:

| File | Weight |
| --- | --- |
| `HurmeHEMA-Regular.woff2` | 400 |
| `HurmeHEMA-SemiBold.woff2` | 600 |
| `HurmeHEMA-Bold.woff2` | 700 |

The CSS exposes the family as `"Hurme HEMA"` via `--font-sans` in `colors_and_type.css`. Use 400 for body, 600 for headings, 700 for display. There is no 800 — the `--fw-extrabold` token resolves to 700 for compatibility.

---

## Content fundamentals

HEMA's writing voice is the verbal counterpart of its products: **plain, warm, unfussy, and small‑letter.** It sounds like a friendly Dutch neighbour who happens to have very good taste.

**Casing.** *Lowercase everywhere by default.* Headlines, product names, navigation labels, and prices are set in lowercase to give what HEMA's own brand book calls "een ronder en vriendelijker tekstbeeld" — a rounder, friendlier word‑image. Beginning capitals are reserved for proper nouns, sizes ("L", "XL"), and the start of a running sentence inside paragraphs. **Sentences inside body copy do follow normal capitalisation** — it's labels, buttons, and headlines that stay lowercase. Example: `tompoes` (not Tompoes), `kerstboom kopen` (not Kerstboom Kopen), `nu in de winkel` (not Now In The Store).

**Address.** Second‑person familiar — *"je"* / "you", never *"u"* / formal. Direct and warm. The brand talks **with** you, not at you. Imperatives are friendly invitations, never commanding: `even rustig kijken`, `kom langs`, `bestel makkelijk online`.

**Numbers & prices.** HEMA prices in **round figures** (€3, not €2.99) — this is a brand promise dating from the original 10/25/50‑cent pricing model. Currency symbol before the number with a small gap: `€ 3`. Decimals only when truly needed (`€ 1,50`) and always with a Dutch comma.

**Tone words HEMA uses about itself:** *eerlijk* (honest), *fris* (fresh), *helder* (clear), *gewoon* (just/ordinary in a positive sense), *bijzonder* (special), *handig* (handy), *lekker* (tasty/nice). Avoid: corporate jargon, hype, exclamation marks in series, ALL CAPS, "premium", "luxury", "exclusive".

**Emoji.** *Not used* in HEMA's own communication. The brand expresses warmth through illustration, colour, and copy — not emoji. Don't add them.

**Sample copy — what good looks like:**
> *handig voor onderweg*
> *bestel nu, morgen in huis*
> *altijd voor een prijsje*
> *al bijna 100 jaar handig in huis*
> *even iets lekkers voor erbij*

**Sample copy — what to avoid:**
> ~~Discover Our Premium New Collection!~~ ❌ — title case, hype, exclamation
> ~~Click here to learn more 👉~~ ❌ — generic web copy, emoji
> ~~Shop now and save BIG!~~ ❌ — all‑caps, urgency, not the HEMA voice

---

## Visual foundations

**Brand essence.** *Exceptional simplicity.* Every visual decision should feel obvious in hindsight — like a HEMA product. The brand was a trendsetter in 1992 for shooting everything **against a clean white background**, and the white ground is still the system's most important visual asset.

**Colour.** The system is anchored on two colours: **HEMA red `#ed2923`** and **white `#ffffff`**. The logo itself is **always set on HEMA red** — keep the primary mark instantly recognisable. Beyond the mark, a 13‑swatch label palette descended from the 2007 Koeweiden Postma rebrand is available for packaging, category accents, and editorial work. Reds dominate; blues and greens carry a calm, considered weight; pinks and yellows do the playful, food, and seasonal work. Neutrals are warm‑grey, not blue‑grey. **Never** use bluish‑purple gradients, neon, or chrome — they are anti‑HEMA.

**Type.** One typeface in three weights — **Regular 400, SemiBold 600, Bold 700** — set predominantly lowercase. The hierarchy is built by *size and weight*, not by colour or all‑caps. Display sizes are large and confident; body sits at a comfortable 16–17px with generous line‑height (1.45–1.6). Letter‑spacing is *neutral to slightly tight* on display, never wide.

**Spacing & rhythm.** A 4 px base unit with a generous 8/12/16/24/32/48/64 px scale. Whitespace is the most expensive visual asset HEMA has — pages breathe. Product cards float on the white ground with **no card border and only a very soft shadow on hover**.

**Backgrounds.** *White is the default.* Full‑bleed photography appears in hero modules and category headers — always real people, real product, no stock cliché. Watercolour illustration on white is the second motif, mainly on food packaging and seasonal campaigns. **No** patterns, no textures, no gradients used as decoration. The red square logo is the only "block" of saturated colour the brand uses with consistency.

**Imagery.** Warm, daylight, real‑people, slight Lomography‑era saturation bump — never dim, never desaturated, never moody black‑and‑white. Watercolour illustration is hand‑painted, loose, on pure white.

**Animation.** Restrained. Standard easing (`ease-out` for entrances, `ease-in` for exits) at 150–220 ms. Buttons fade their background on hover; cards lift gently (translateY −2 px + shadow). No bounces, no springs, no parallax. Page transitions are crossfades. The brand is calm.

**Hover state.** *Darken by ~8%*. The red CTA goes to `#cf2118` on hover. Secondary buttons darken their stroke. Links underline.

**Press / active state.** Background darkens further (~12–14%) **and** the element scales to `0.98`. No ripple, no shadow inset.

**Focus state.** A 2 px outline in HEMA red, offset 2 px from the element — accessible and on‑brand.

**Borders.** Hairline 1 px in `#e6e2dc` (warm grey), used sparingly: form fields, table dividers, the footer top edge. Never used to box product cards.

**Radii.** Slightly soft, never pillowy. `4 px` for inputs, `8 px` for buttons and cards, `12 px` for modal sheets, `16 px` for hero modules. The logo's red square uses ~`18 px` at the icon size we ship.

**Shadows.** Two only. `shadow-hover` (used on cards and dropdowns) = `0 4px 16px rgba(20,16,12,0.06), 0 1px 2px rgba(20,16,12,0.04)`. `shadow-sticky` (header / floating bars) = `0 1px 0 rgba(20,16,12,0.06)`. No deep drop shadows. No inner shadows.

**Transparency / blur.** Used **only** on the sticky header when it overlays content — a 92% white wash with a 12px backdrop blur. Nowhere else. The brand's surfaces are flat and confident.

**Layout rules.** Max content width 1280 px on web. Generous left/right gutters at every breakpoint. Sticky header is 64 px tall on desktop, 56 px on mobile. The promo bar above the header is 32 px and red. The footer is white with a thin top border.

**Cards.** White fill, no border, soft shadow on hover, 8 px radius. Product image flush to the top corners of the card, copy below. Price is bold, in HEMA red on promotional cards, otherwise black.

**Buttons.** Solid red (primary), solid black (secondary on white), or outline black (tertiary). All lowercase. Pill or 8 px radius depending on context — the website tends pill, the app tends 8 px.

---

## Iconography

HEMA's product imagery does the heavy lifting; **icons play a quiet supporting role.** In the web shop, icons are used sparingly for navigation (account, wishlist, cart), service indicators (delivery, return, store pickup), and form affordances (search, filter, close).

**Style.** Outline, rounded join, rounded cap, 2 px stroke at 24 px nominal size. Black `#1a1a1a` on white, white on red. No filled icon system, no duotone, no isometric, no 3D. The vibe is sibling to the wordmark — geometric, friendly, low‑detail.

**SVG vs PNG.** Inline SVG everywhere on web. The mobile app uses the same SVGs.

**Emoji.** *Not used.* See content fundamentals above.

**Unicode glyphs.** Occasionally as bullets (`•`) or arrows (`→`) inside running copy. Never as substitutes for icons in UI chrome.

**Substitution flag.** HEMA's own icon library is not publicly distributed. This system uses **Lucide** (https://lucide.dev — MIT licensed, CDN‑available) as a stand‑in. Stroke weight (2 px), rounded line caps, and proportions all match the HEMA look closely. The Lucide set is loaded from CDN in UI kit prototypes. **If you can share the real HEMA icon set, swap it in.**

---

## Index

After reading this README, the most useful entry points are:

- **`colors_and_type.css`** — drop into any prototype; every token used in the UI kits comes from here.
- **`preview/`** — small specimens for colour, type, spacing, components, brand. Browse the Design System tab to scan them.
- **`ui_kits/web/index.html`** — interactive web‑shop recreation.
- **`ui_kits/app/index.html`** — interactive mobile‑app recreation.
- **`assets/logo.svg`** — the red‑square wordmark in vector form. Plus colour variants in `assets/logo-variants/`.
- **`SKILL.md`** — manifest so this folder can be packaged and used as a Claude Code skill.
