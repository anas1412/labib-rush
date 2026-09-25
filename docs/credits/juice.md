# Credits — juice (audio + particle FX)

No third-party asset files. `public/audio/` stays empty: the download cost of this module is 0 MB.

## Audio (src/audio/)
Everything is synthesised at runtime with the Web Audio API: every SFX, the music loop and the city
ambience. Techniques, all public-domain textbook methods:
- Karplus–Strong plucked string (Karplus & Strong, 1983) with an all-pass fractional-delay tuner
  (Jaffe & Smith, 1983), for the qanun voice.
- Paul Kellet's "economy" pink-noise filter (public domain, music-dsp mailing list).
- Subtractive / FM synthesis, formant-filtered noise and oscillators (crowd, "uh-oh"),
  generated room impulse response for the reverb.

The music is an original composition written for this game (D Hijaz, 118 BPM; maqsum, saidi and
malfuf are traditional rhythm patterns, not copyrighted material).

## Particle FX (src/fx/)
Sprite atlas generated procedurally per pixel at startup. The 5-point star uses Inigo Quilez's
exact star distance function ("2D distance functions", https://iquilezles.org/articles/distfunctions2d/,
MIT licence), ported to TypeScript in `src/fx/atlas.ts`.
