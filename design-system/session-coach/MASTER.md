# Session Coach UI system

Applied UI UX Pro Max guidance, September 2026. Runtime: native DOM TypeScript and CSS, bundled with esbuild. No framework migration or remote font requests.

## Direction

Calm, flat productivity workspace. Teal focus, white panels, strong readable type, restrained line icons. The skill's first query matched Flat Design and a teal palette; its second matched dashboard density. Generated marketing-page patterns did not fit this working application and were rejected. Navigation and progressive disclosure follow the skill's verified heading hierarchy and quick-reference guidance.

## Tokens and layout

- Primary action: #0f766e with white text; dark hero #153e36.
- Background #f6f8f7; surface #ffffff; primary text #172b28; secondary text #586b65.
- Inter when locally available, then Segoe UI and Arial. No network font dependency.
- 4/8px spacing rhythm, 12–16px panel radii, 44px primary targets.
- Consistent outline SVG icons. Color always accompanied by text.
- Responsive layouts at 540, 800, and 1150px; verify 375, 768, 1024, and 1440px, landscape, and increased text size.

## Information architecture

Overview: a clear next action, observed metrics, top ideas, a short explanation of the review loop.
Opportunities: explain the concept, filter by category, review one idea at a time.
Idea dialog: what happened, why it may help, what to try, examples, caution, copy a review prompt or dismiss.
History: recognizable idea names, dates, and reversible decisions.
Sources: source availability, privacy boundaries, technical details behind disclosure.

## Interaction rules

Hash routes support direct links and browser Back. Modal uses native dialog focus containment and Escape. Labels are explicit; copy confirms with a status message. Polling does not replace active review content or focused controls. Reduced motion is supported. Token counts show coverage; there are no invented savings, trends, or quality scores.
