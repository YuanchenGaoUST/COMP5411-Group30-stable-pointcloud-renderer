# 本次项目创建记录

2026-10-10，Group 30。

## 完成的工作

1. 建立课程目录下的独立项目子目录，保留原有讲义与课程资料。
2. 实现可操作的 WebGL2 viewer，使用真实 GLSL surfel shaders。
3. 实现点云预处理与固定预算、时间稳定的选择器。
4. 提供可重复的相机、同候选集消融与图像/时间残差指标。
5. 加入实验计划、AI/source-use 记录、启动方式和下一阶段列表。

## 实际验证

- 30 项 JavaScript core / numerical / camera tests 通过。
- 11 项 Python preprocessing tests 通过。
- 隔离 Chrome 的浏览器检查通过，console errors 为空。
- 默认输入 N=14,400、B=2,880，实际提交 2,880 个 surfel。
- 七种 method/stability 的短序列使用同候选池，绘制数量一致，未出现预算或主动替换配额超限。
- 8,192 点的 fixture.json 特征经过离线 PCA / spacing / color-contrast 计算，非仅设计代理。

浏览器验证使用 SwiftShader 软件 GPU，其 timing 不代表本机原生 GPU 性能。详细记录和截图见 `results/validation/`。

## 实现边界

这是首个可运行原型。多层 LOD footprint、真实扫描、binary PLY、正式硬件 profiling、recovery time 和完整实验矩阵仍待完成。这里的 octree 提供 bounded point-wise candidate discovery，不应声称已经完成 Potree/CLOD 等大规模 viewer 的所有能力。

## 在线模型输入扩充

2026-10-10 增加宽体客机、风格化飞机、Stanford Bunny/Dragon、Utah Teapot五种输入，每个15,000点。来源、许可、mesh与processed JSON hashes以及采样seed均已归档。采样后重新计算PCA特征，无颜色模型的saliency=0。

对应的独立测试为33项JavaScript、26项Python，共59项通过；新增模型的浏览器检查记录位于results/validation/catalog。sample_mesh.py已支持ASCII/binary PLY mesh输入，原始点云入口的binary PLY支持仍待补充。

## 2026-10-22 English interface and presentation controls

- Converted viewer controls, messages, and catalog labels to English, and added two English-interface regression tests. All 35 JavaScript and 26 Python tests pass.
- Added interactive azimuth, elevation, intensity, and reset controls for the existing world-space, two-sided diffuse light. Default lighting is preserved. Lighting changes do not change the point budget or selection, and comparison runs lock and export their lighting settings.
- Added Soft studio, Open sky, and Blue lab backgrounds alongside Solid / diagnostic. These AI-generated images are fixed 2D display decorations, with full prompts in assets/backgrounds/generation.json. They do not add environment lighting, mesh geometry, shadows, or parallax.
- Composited image backgrounds only in the final presentation pass. Save frame includes the decoration; diagnostic capture retains the original solid RGB background and depth. Experiment exports distinguish rendering.background from rendering.captureBackground.
- Kept the existing GPU timer scoped to surfel rendering and EDL. It excludes background presentation and is not a total decorated-view frame-time measurement.
- Added optional sunlight and background browser integration scripts. Their software-rendered checks cover interaction, diagnostic isolation, metadata, and responsive layout; they are not GPU performance benchmarks.
- The general, sunlight, and background browser checks all pass with no browser errors. Switching the three image backgrounds preserves offscreen RGB/depth and selected point IDs exactly; paired studio/sky experiments return identical quality metrics. Compact reports are under results/validation/backgrounds-2026-10-22 and results/validation/viewer-design-2026-10-22.

## 2026-10-22 Artistic surface materials

- Added Auto / Original / Blue enamel / Warm copper / Jade satin choices above the canvas. Auto selects blue only for inputs explicitly marked as lacking source colors.
- Applied broad, view-dependent sun highlights and gentler EDL to styled materials. Original and diagnostic rendering remain compatible with the baseline. No point-cloud attributes, point IDs or geometry are modified.
- Material styling changes foreground RGB; comparison runs force Original and EDL strength 14 and export both actual and requested presentation settings.
- All 35 JavaScript tests and the material, sunlight and general browser checks pass. The new material check confirms unchanged depth, uploaded point attributes and point IDs, visible highlights, identical controlled experiment metrics, PNG export and mobile layout. Evidence: results/validation/materials-2026-10-22/material-smoke.json. Software timings are not native-GPU performance results.
