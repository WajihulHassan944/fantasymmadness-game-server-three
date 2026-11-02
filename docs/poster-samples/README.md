# Premium poster samples (staging evidence)

These were rendered by `growth-acceptance/render-poster-samples.js` at backend commit `72f86e6`. Every image is full size: **1080×1350 for feeds** and **1080×1920 for vertical posts**.

**These are not real people or real fights.** The figures are synthetic mannequins labelled TEST A / TEST B. They stand in for approved, original fighter photos. The names, events and dates are sample data.

For every poster in this folder:
- The QR code was decoded from the final JPEG with jsQR, and it matches the poster's fight link.
- All quality checks passed: nothing is drawn over a fighter, the QR code sits inside its plate, images keep their proportions, and the small text meets the contrast threshold.

| Genre | Look | Feed | Vertical |
|---|---|---|---|
| MMA / UFC | Octagon cage mesh, arena lights, red floor glow | `mma-photos-portrait.jpg` | `mma-photos-story.jpg` |
| Boxing | Championship gold, ring ropes, warm spotlight | `boxing-photos-portrait.jpg` | `boxing-photos-story.jpg` |
| Bare-knuckle | Gritty texture, embers, fire glow, steel type | `bare-knuckle-photos-portrait.jpg` | `bare-knuckle-photos-story.jpg` |
| Kickboxing | Diagonal light beams and speed lines, electric blue and red, face-off layout | `kickboxing-photos-portrait.jpg` | `kickboxing-photos-story.jpg` |
| Pro wrestling | Stage spotlights, pyro, confetti, purple and gold | `pro-wrestling-photos-portrait.jpg` | `pro-wrestling-photos-story.jpg` |
| No approved photos | Premium text-only fallback (the poster is held as NEEDS ARTWORK) | `mma-text-fallback-portrait.jpg` | `mma-text-fallback-story.jpg` |
| Framed photos | Shown for photos that cannot be cut out cleanly (busy backgrounds) | `boxing-framed-photos-portrait.jpg` | `boxing-framed-photos-story.jpg` |

In each pair, fighter A was supplied as a transparent cut-out. Fighter B was supplied on a plain studio background, and the engine removed only that background; the fighter's own pixels are unchanged, which a test proves.
