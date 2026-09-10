# Issue 175: Official Website Homepage Design

## Purpose

Create the first public homepage for StatsPlayground at `statsplayground.org`.
The homepage introduces the product, demonstrates what it can do, and provides
clear routes to documentation, GitHub, and downloads. It must deploy as a
static site through GitHub Pages and establish a foundation for the future
official documentation site.

Issue: https://github.com/ashton2914/StatsPlayground/issues/175

## Product Positioning

StatsPlayground is an open-source, local-first desktop workspace for exploring
data, creating visualizations, running statistical analyses, and carrying work
from a question to a report.

The homepage is English-first. Its information architecture and URLs must leave
room for future localized content, including a Chinese site, without requiring
a platform migration.

The primary visitor action is to explore product capabilities. Downloading,
reading documentation, and opening GitHub remain visible secondary actions.

## Architecture

The website is an independent Astro static-site package under `website/` in the
existing repository. It owns its dependencies, source, public assets, scripts,
and build output. The root Vite and Tauri application retain their existing
commands and behavior.

Astro is the foundation because it provides static output, strong first-load
performance, SEO-friendly markup, and a direct path to a future Starlight
documentation surface. The first phase does not enable or populate Starlight,
but the website structure must not block it.

The public site has these boundaries:

- `website/` owns the official website and future documentation frontend.
- `src/` and `src-tauri/` continue to own the desktop product.
- The website may consume exported screenshots and public release links, but it
  must not import or execute Tauri application modules in the browser.
- The website build must not alter the root application's build semantics.

## GitHub Pages Deployment

A dedicated GitHub Actions workflow builds the Astro package and deploys its
static output with the official GitHub Pages artifact and deployment actions.
The workflow runs when website sources or the workflow itself change and may
also be started manually.

The deployment targets the custom domain `statsplayground.org`. The website
publishes a `CNAME` file containing that domain. Site URLs use the root domain
and do not hard-code the GitHub repository subpath.

Domain-provider DNS records and the GitHub repository's Pages custom-domain
setting are one-time external configuration. They are not automated by the
repository.

## Homepage Information Architecture

### 1. Navigation

The global navigation contains:

- StatsPlayground brand and existing application icon
- Product
- Docs
- GitHub
- Download

Product scrolls to the product demonstration on the homepage. Docs points to a
real, published view of the repository's existing `docs/` content in phase one.
It may move to the website's internal `/docs/` route when the documentation
surface is built. GitHub opens the project repository. Download opens the
latest GitHub Release or the repository Releases page.

### 2. Immersive Hero

The first viewport is a dark, full-width data canvas. It contains:

- Headline: `Your data has more to say.`
- Supporting copy that identifies StatsPlayground as an open-source,
  local-first desktop statistics workspace
- Primary action: `Explore the product`
- Secondary action: `Watch overview`
- A restrained field of statistical marks and one highlighted relationship
- A real StatsPlayground application view entering from the lower edge

The visual marks support the product story rather than serving as decoration.
The application view is a first-viewport signal so visitors immediately
understand that StatsPlayground is a usable desktop product.

The overview action scrolls to the product demonstration in phase one. It may
point to a product video later without changing the page structure.

### 3. Product Demonstration

A real application capture shows a representative workflow moving through
three stages:

1. Bring in or prepare a table.
2. Explore relationships and distributions visually.
3. Preserve the analysis in a report or reusable workflow.

The presentation must use behavior and capabilities that exist in the current
product. It must not display fictional controls, analyses, performance claims,
or unsupported platforms.

### 4. Core Values

Three concise value statements explain the product:

- Local-first ownership: analysis remains on the user's machine unless the user
  explicitly connects or exports it.
- Visual statistical thinking: tables, graphs, analyses, and reports coexist in
  one project workspace.
- Open and extensible: the project is open source and designed to grow through
  reusable analytical workflows.

These are unframed content bands, not a grid of decorative cards.

### 5. Representative Capabilities

The homepage presents a curated, factual subset of the current product rather
than an exhaustive feature matrix. The initial set should cover:

- Table import, transformation, and column properties
- Graph Builder and interactive visual exploration
- Distribution and Fit Y by X analysis
- Fit Model and hypothesis testing
- Reports and reusable workflows

Each capability uses a real product image or crop and a short outcome-oriented
description.

### 6. Open-Source Closing Section

The final section provides a direct path to:

- Explore the source on GitHub
- Read the documentation
- Download the latest release

The footer contains Product, Documentation, Community, Releases, license, and
repository links. It does not include a blog, account system, mailing list, or
telemetry controls in phase one.

## Visual System

The hero uses near-black green (`#121715`) as its base, mint as the primary
accent, and coral for one statistical relationship. Content below the hero
moves to a cool light neutral surface so the site does not become a one-note
dark interface and future documentation remains comfortable to read.

Typography uses self-hosted font files or a reliable local fallback stack. The
production site must not require a runtime Google Fonts request. Display type
is expressive but restrained; compact sections use appropriately smaller type.
Letter spacing remains zero.

Cards are reserved for genuinely repeated capability items if a framed item is
needed. Sections themselves remain unframed full-width bands. The page does not
use decorative gradient orbs, nested cards, stock photography, or an abstract
hero that hides the product.

The first version reuses the existing StatsPlayground icon and does not redesign
the logo.

## Motion

Motion communicates the relationship between data and product:

1. The headline and supporting copy enter with a short stagger.
2. Statistical points appear in a controlled sequence.
3. The highlighted relationship resolves after the points.
4. Scrolling reveals the real application view and transitions into the product
   demonstration.

Motion must use transform and opacity where practical, remain subtle, and never
block navigation. Under `prefers-reduced-motion: reduce`, the final state is
rendered immediately with no essential information lost.

## Responsive Behavior

The desktop hero is immersive and full width. Mobile layouts reduce the number
of visible data marks, preserve stable heading dimensions, and keep primary
actions readable without overlap. The application capture uses a deliberate
crop that still identifies the product rather than shrinking an entire desktop
window into illegibility.

Navigation, buttons, fixed-format visual elements, and media have stable
responsive constraints. No text may overlap another element or overflow its
container at supported desktop and mobile widths.

## Accessibility And SEO

The homepage must provide:

- Semantic landmarks and heading order
- Keyboard-operable navigation and actions
- Visible focus states
- Sufficient contrast in dark and light sections
- Alternative text for product images
- Reduced-motion behavior
- A unique page title and description
- Canonical URL and basic Open Graph metadata
- A useful static 404 page

Decorative data marks are hidden from assistive technology. Product images have
factual descriptions rather than repeating adjacent marketing copy.

## Content And Asset Rules

All product claims must be supported by the current repository and application.
Real product captures are preferred over fabricated interface mockups. Images
must be optimized for the web and stored with the website rather than loaded
from temporary development URLs.

The homepage may use the GitHub repository and Releases URLs as live external
links. It must not depend on a runtime API call to render essential content.

## Testing And Verification

Automated verification covers:

- Astro production build
- Stable root-domain link generation
- Presence and targets of primary navigation and calls to action
- CNAME and GitHub Pages workflow contracts
- Internal-link integrity
- Reduced-motion and semantic accessibility basics

Browser acceptance covers desktop and mobile viewports:

- The hero and product media are nonblank and correctly framed.
- Navigation and calls to action work.
- Product, documentation, GitHub, and download destinations are correct.
- No horizontal overflow, clipped labels, or incoherent overlap occurs.
- Motion runs in the default mode and resolves immediately in reduced-motion
  mode.
- The first viewport identifies both the product category and the actual desktop
  application.

The root desktop application build and the website build both run after website
integration to prove the package boundary.

## Phase-One Scope

Phase one includes the complete homepage, responsive and accessible behavior,
real product imagery, a static 404 page, SEO metadata, the custom-domain file,
and GitHub Pages deployment automation.

Phase one excludes the complete documentation corpus, an internal documentation
shell, documentation search, blog, changelog UI, CMS, analytics, user accounts,
community profiles, and a new brand identity. The package structure reserves a
future internal documentation surface without exposing an empty route.

## Manual Acceptance

Acceptance is performed from the Issue 175 worktree against the local Astro
site. The reviewer checks the desktop and mobile homepage, navigation,
first-viewport product signal, product demonstration, light/dark transition,
reduced-motion mode, external destinations, and static 404 page.

Commit, push, pull request creation, deployment activation, and worktree cleanup
remain separate authorization gates under the repository Issue workflow.
