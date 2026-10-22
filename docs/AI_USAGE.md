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

## 2026-10-22 English interface and presentation controls

Codex translated the viewer's controls, status/error messages, and catalog labels into English, and added English-interface regression tests. It also exposed the existing two-sided diffuse light through azimuth, elevation, intensity, and reset controls, connected these controls to shader uniforms, and included fixed lighting settings in experiment exports. These changes do not modify the point-selection algorithm or claim physically accurate solar illumination.

Codex used the built-in image_gen tool to generate the Soft studio, Open sky, and Blue lab backgrounds. They are fixed 2D decorative images, not point-cloud renders, environment lighting, reconstructed geometry, cast shadows, or experimental evidence. The images were converted to JPEG without content edits. Full prompts, intended use, and postprocessing details are preserved in [assets/backgrounds/generation.json](../assets/backgrounds/generation.json).

The renderer composites these images only onto the final canvas. Saved presentation frames include the decoration, but diagnostic RGB/depth capture retains the original solid background. Exported experiment metadata identifies both the display choice and the diagnostic background. The existing GPU timer excludes the additional presentation pass, so it must not be described as total decorated-view rendering time. Browser checks use SwiftShader and do not establish native-GPU performance.

No external rendering library was added. Team members remain responsible for reviewing the AI-assisted code, explaining the rendering and selection algorithms, and verifying any submitted claims.

## 2026-10-22 Surface material presentation

Codex implemented artistic blue enamel, copper and jade shader presets with broad Blinn–Phong highlights and softer EDL. The presets are hand-specified shader parameters, not AI-painted output images, recovered source textures or measured physical materials. Auto styling is limited to inputs explicitly marked as lacking source colors. Original rendering and diagnostic colors remain available.

Material styling changes foreground RGB. Quantitative comparisons force Original material and the baseline EDL strength, recording both actual experiment settings and requested presentation settings. Point-cloud data and selection are unchanged. New screenshots are actual renderer output; their existing decorative background remains explicitly AI-generated. The team must review and explain this AI-assisted implementation before submission.
