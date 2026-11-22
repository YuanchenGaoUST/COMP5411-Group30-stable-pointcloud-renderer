# Preliminary progress study — 21 October 2026

These are implementation-progress measurements, not a completed final evaluation and not a native-GPU performance benchmark. Every frame and all seven method/stability variants are retained.

## Reproduce

Start the project server in a separate terminal:

```sh
python3 scripts/serve.py --port 5416
```

With Playwright and its Chromium available:

```sh
PROJECT_URL=http://127.0.0.1:5416/ node scripts/progress-pilot.mjs
```

The optional `PLAYWRIGHT_MODULE` and `CHROME_PATH` environment variables select an existing Playwright module and Chrome executable. The shared browser launcher deliberately uses SwiftShader. Source/data SHA-256 hashes, exact settings, and browser metadata are in `manifest.json`; each raw result additionally records the actual unmasked renderer, when available. Diagnostic wall times are not end-user FPS or hardware GPU timings.

## Fixed protocol

- Inputs: the colored synthetic offline-PCA fixture (8,192 points), and the uncolored CC0 Jetliner mesh-derived sample (15,000 points). Neither is a noisy raw scan.
- Budget: 20%, rounded to 1,638 and 3,000 submitted instances respectively.
- Camera: one complete 12-second orbit; 30 Hz selection and 361 image samples, including both endpoints; 320 × 240 pixels.
- Rendering: identical oriented surfels, radius multiplier 2.0, original/fallback color and lighting, EDL enabled; same-shader full-point reference.
- Methods: Uniform/off, Screen/off/on, Geometry/off/on, Full/off/on. Score weights are unchanged from the implementation.
- Stability: EMA time constant 0.12 s, relative hysteresis 12%, paired discretionary swap cap `floor(0.10 × B)` per update. Initialization, mandatory visibility removals, and empty-slot fills are accounted for separately.
- Fairness: all variants advance in lockstep and share one candidate pool, including their union-retained IDs. Counts and reference-derived temporal masks are checked for equality.

`fixture.json` and `jetliner.json` contain every per-frame measurement. Their `*-summary.json` files expose all method rows, count/quota checks, replacement counts, and temporal correspondence coverage.

## Metric interpretation

RGB MAE averages normalized RGB error over the complete image, including background. Foreground holes average the fraction of the full-point reference foreground missing from the budget image, frame by frame. Lower is better for both.

The temporal residual subtracts the reference image before nearest-neighbor reference-geometry reprojection. The validity mask uses only full-point reference foreground, in-bounds projection, and raw WebGL depth consistency (absolute tolerance 0.0001); budget holes are not excluded. The aggregate is weighted by valid correspondence pixels. The initial frame has no temporal predecessor. A low replacement count alone is not proof of low visual flicker.

The reference is a rendering of all input points using the same shader, not surface ground truth. In these subset renders, holes and silhouette mismatch coincide; they should not be interpreted as independent evidence.

## Current conclusion

On the fixture, all variants submit exactly 1,638 instances in every captured frame; all stable variants obey their 163-swap cap, with no budget or quota violations. All seven share identical temporal masks: 360 valid frame pairs and 7,470,031 valid correspondence pixels in total. This is 95.96% of reference foreground across the 360 pairs, or 27.02% of the complete image averaged over pairs.

The Full score does **not** outperform Screen in this pilot. Full/off has RGB MAE 0.052195, holes 62.65%, and temporal residual 0.020986; Screen/off has 0.032133, 39.54%, and 0.017158 respectively. The current geometry/contrast weighting and coverage trade-off need investigation; these observations do not identify a causal mechanism.

Enabling stability reduces Full's mean discretionary swaps from 14.59 to 12.04 per update (17.5%), but its temporal residual increases by 2.2%. Screen's swaps fall by 25.4% and temporal residual falls by only 0.85%, while RGB MAE increases by 4.27%. This demonstrates the distinction between controlled point-set turnover and image-level stability, and does not establish an overall quality improvement.

The switch jointly toggles EMA, hysteresis, and the quota; it does not isolate their contributions. Full/on's maximum observed swaps (98) and Screen/on's (93) remain below the 163-swap cap, so their turnover reductions cannot be attributed specifically to a binding quota. Geometry/on reaches the cap.

Jetliner has no source colors, so its contrast feature is zero. Its Geometry and Full scores are identical by construction and cannot evaluate the benefit of appearance saliency.

On Jetliner, all variants submit exactly 3,000 instances in every capture, all stable variants obey their 300-swap cap, and no count or quota violation occurs. All variants share 1,533,241 valid correspondence pixels over 360 frame pairs: 90.98% of reference foreground, or 5.55% of the complete image averaged over pairs. The low complete-image fraction partly reflects the object's image footprint and is not the fraction of foreground surviving the mask.

Jetliner Full/off has RGB MAE 0.007734, holes 13.09%, and temporal residual 0.056850; Screen/off has 0.007715, 13.92%, and 0.055583. Full/on reduces mean discretionary swaps from 25.63 to 21.88 per update (14.6%), but RGB MAE increases by 1.83% and temporal residual by 1.60%. Its holes decrease slightly to 13.01%. These are mixed trade-offs, not an overall superiority claim. Raw temporal residual values should not be used to rank the two different inputs, whose footprints and surface appearances differ.

Remaining evaluation includes colored raw scans, controlled noise, held-out inputs, multiple seeds, 5/10/20% budgets, zoom/boundary/cut paths, confidence/coverage ablations, and native-hardware profiling. No parameter was tuned to this pilot after observing its results.
