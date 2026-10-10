# 实现进度与下一阶段

日期：2026-10-10（Asia/Hong_Kong）

## 已接入原型

- [x] 本地项目结构、无 CDN 的 WebGL2 viewer。
- [x] ASCII PLY / XYZ / canonical JSON 读取、输入校验、persistent source IDs。
- [x] NumPy PCA normals、curvature proxy、confidence、spacing radius 和颜色对比度。
- [x] 合成多深度场景及 8,192 点离线 PCA fixture。
- [x] Octree、视锥遍历、有界且方法无关的候选池。
- [x] Hard count cap、time-based EMA、relative hysteresis、paired swaps quota。
- [x] Opaque oriented-disk shaders、point sprite fallback、EDL 开关。
- [x] 四条固定相机路径、全点参考与小规模图像/时间残差评测。
- [x] 自动化 core / preprocessing tests。

以上是功能接入状态；浏览器实际检查记录见 results/validation，不等于 proposal 所有实验已经完成。

## 下一个可展示里程碑

1. Stanford Bunny/Dragon 和两种飞机、茶壶已接入为 mesh-derived point clouds；接下来仍需一个有明确许可的彩色真实扫描。
2. Binary PLY 输入支持与数据子集预处理；按实际规模决定 SciPy/Open3D 工具。
3. 明确各 LOD 层级的 representative 与 footprint，加入薄结构与轮廓的半径上限。
4. 在原生 GPU 浏览器下记录 CPU selection、GPU time、buffer memory 和帧时间 p50/p95。
5. 跑预算 5% / 10% / 20%，固定开发权重后跑 held-out camera sequences。
6. 重算受控噪声/非均匀采样特征，评测 confidence fallback。
7. 定义 recovery-time 阈值，评估稳定性的响应滞后。

## Optional

- 预算内 overlapping cross-fades。
- CLOD-inspired gradual-transition 对照；明确其是 adaptation。
- GPU hierarchy traversal、动态点云、训练 MSV-PCT 继续留在核心范围外。

proposal 中 Oct 25 / Nov 22 / Nov 27 的时间点作为此前提供的计划保留，具体提交日期应以课程当前作业说明为准。
