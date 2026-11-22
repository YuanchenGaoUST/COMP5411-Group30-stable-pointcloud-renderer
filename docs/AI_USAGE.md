# AI 与外部来源记录

## 2026-10-10 初始实现

本次项目骨架、Python preprocessing、JavaScript selection/metrics、GLSL renderer、页面、测试和文档由 Codex 协助生成并集成。团队成员需要阅读、解释与进一步验证这些模块；当前代码不能声明为全部由成员独立编写。

验证方式包括 numerical unit tests、Python preprocessing tests，以及 isolated-browser WebGL integration checks。具体实际结果保存在 results/validation。验证通过不意味着方法具有研究创新性或在真实扫描上优于已有方法。

## 外部技术与依赖

- WebGL2 / GLSL ES 3.00：浏览器标准图形 API。
- NumPy：数值运算与 eigen decomposition。
- SciPy：可选 cKDTree neighbor search；当前环境未安装，NumPy fallback 已测试。
- Playwright / Chromium：仅用于可选浏览器检查，不是 viewer 的运行依赖。
- Python http.server：只用于127.0.0.1开发预览。

## 参考

- Zwicker et al., Surface Splatting, SIGGRAPH 2001. 当前仅实现 simplified opaque disks，不复现 EWA。
- Schütz, Potree thesis, 2016. 当前不复用 Potree selector 代码。
- Schütz et al., Real-Time Continuous Level of Detail Rendering of Point Clouds, IEEE VR 2019. 当前不声称复现完整 CLOD。
- Boucheny and Ribes, Eye-Dome Lighting, Kitware, 2011. 当前 EDL-inspired post-pass 为自行实现的简化版本。
- WebGL2 instancing documentation: https://developer.mozilla.org/en-US/docs/Web/API/WebGL2RenderingContext/drawArraysInstanced

本次未下载真实扫描；synthetic data 为脚本生成。今后每次引入外部代码或数据，记录来源、license、复用范围和验证。

## 2026-10-10 在线模型输入扩充

Codex 协助检索作者/官方模型页并下载 OBJ/PLY 模型，生成了 sample_mesh.py、模型构建与下载入口、catalog loading UI 和 tests。模型本体来自列明的作者或 Stanford/McGuire archive，不是 AI 生成资产。

新增数据均为 mesh-derived points，按表面积均匀采样并重新计算 PCA normals/geometry。无原始颜色的五种模型均保留 s=0；显示颜色是统一 pearl-white fallback，不冒充作者纹理。

来源、逐模型许可、SHA256 和采样 seed 见 data/catalog.json、data/models/*.json 的 metadata 及 data/sources/README.md。Stanford 许可是研究使用/免费分发并署名，不能标记为 CC0。

## 2026-10-21 English interface and preliminary experiments

Codex translated the viewer controls, added English-interface regression tests, and authored automation for the preliminary image study. Selection and rendering algorithms were unchanged. All seven variants and complete image-sample sequences, including unfavorable findings, remain in results/progress-2026-10-21. The study used the actual WebGL2 implementation with Chrome's SwiftShader software backend; its timings are not native-GPU performance measurements.

## 2026-10-22 Interactive sunlight

Codex added azimuth, elevation, intensity and reset controls for the existing two-sided diffuse light, connected them to shader uniforms, and included fixed lighting settings in experiment exports. This is a visualization feature; it does not change point selection or claim physically accurate solar illumination. No external image or rendering library was added. Validation covers real WebGL shading changes, default-light compatibility, unchanged selected points/depth, and experiment settings/locking.

## 2026-10-22 Selectable presentation backgrounds

Codex used the built-in image_gen tool to generate Soft studio, Open sky and Blue lab background images. Full prompts and JPEG conversion details are recorded in [assets/backgrounds/generation.json](../assets/backgrounds/generation.json). These fixed 2D images are decorative assets, not reconstructed scenes, environment lighting, cast shadows or measured rendering results.

Codex implemented the background selector, cached image loading, final-canvas compositing and browser checks. Saved frames include the backdrop; diagnostic capture retains the original solid background and depth. The GPU timer excludes the presentation pass. Browser validation uses SwiftShader and does not establish native-GPU performance.

## 2026-10-22 Surface material presentation

Codex implemented artistic blue enamel, copper and jade shader presets with broad Blinn–Phong highlights and softer EDL. These are shader parameters, not recovered source textures or AI-painted model renders. Auto applies blue only to inputs explicitly marked as lacking source colors. Material styling changes captured foreground RGB; quantitative comparisons therefore force Original material and baseline EDL strength, and record requested presentation settings separately. Point-cloud data and selection remain unchanged. New screenshots use actual renderer output over the existing AI-generated decorative backgrounds.

## 2026-11-21 Interface simplification and usage guide

Codex simplified the existing HTML/CSS into a neutral light tool interface, added an inline English walkthrough, and grouped advanced settings and disclosures in native expandable sections. Source attribution and the AI-generated-background disclosure remain available; the less decorative interface does not change the project's AI-assistance record. No new generated images, dependencies, model data, or rendering algorithms were added.

Camera playback now has explicit Play/Pause labels and an accessible pressed state; Reset view stops playback before restoring the camera. Browser checks exercise these interactions, exported files, comparison results, and desktop/mobile layouts. Captured previews are actual WebGL output, with the existing decorative backdrop; SwiftShader checks are not native-GPU performance measurements.

## 2026-11-21 Typography and direct point-cloud inspection

Codex refined typography using locally installed Avenir Next with system-font fallbacks; no remote font request, new font file, or dependency was added. Display notes and its old dynamic DOM bindings were removed at the user's request. Background generation attribution and material measurement policies remain in this document, the README, and assets/backgrounds/generation.json.

Codex added a separate fixed-screen-size point-cloud view using instanced circular sprites centered on the existing selected point positions. This mode does not reconstruct surfaces or use normals, support radii, lighting, or EDL. Original and diagnostic colors are unlit; presentation materials act as flat tints. The 1–6 px control specifies CSS-pixel diameter. The previous surface path remains available and is used by comparisons; actual and requested rendering modes are exported separately. Preprocessing, source data, and point-selection algorithms are unchanged.

New screenshots are actual application captures, not generated images. Browser checks cover point attributes/IDs, exact surface restoration, dot-size behavior, absent shading dependencies, exported PNG/JSON, and layout. All software-browser timings remain diagnostic only.

