# 实验入口与指标解释

`experiments/plan.json` 是计划，不是结果。`results/validation/browser-diagnostic.json` 是运行 smoke test 时真实生成的短诊断，采样密度和软件 GPU 环境必须随结果一起保留。

## 公平性

各方法使用同一 cloud、source IDs、budget、camera pose、viewport、radius multiplier、depth rules 和 EDL 开关。Experiment runner 在每个 selection timestep 同步推进七种 method/stability 变体，共用基础候选池和 union-retained IDs。可用候选充足时均填到 B；不足时记录真实数量。

Uniform 是空间覆盖 representatives + deterministic hashed fill 的原型基线；Screen 使用 projected footprint；Geometry 加入 confidence-weighted geometric/grazing terms；Full 再加入 color-contrast term。后续要评估基础 cover 是否影响对重要性评分的判断。

## 指标

- RGB MAE：budget image 与同 shader full-point reference 的逐像素 RGB 差，归一化到 [0,1]。
- Foreground hole rate：reference foreground 中预算图缺少覆盖的像素比例。
- Silhouette mismatch：两幅 foreground masks 的 XOR / union。
- Depth correspondence error：共同 foreground 上 raw WebGL depth 的差；coverage 单独报告。raw depth 不是世界单位距离。
- Temporal residual：预算图减参考图后的有符号残差，在已知 reference depth + camera matrices 下做重投影，再比较。有效 mask 只依赖两个 reference，不因预算图出现 holes 就排除像素。
- Temporal summary 按 valid correspondence count 加权；raw-depth consistency tolerance 1e-4 为初始设置，需要敏感性实验。camera cuts 单独排除。
- CPU candidate traversal 与 score/selection 时间分开记录。readPixels 会等待 GPU，不能把短图像实验的时间当成实时 FPS。
- Viewer RAF FPS 是当前交互循环的观察值。GPU timer 只有扩展可用且无 disjoint 才显示；不支持时显示“不可用”。

## 当前 UI 的短实验

默认 320×240、2 秒、61 帧图像、30 Hz selection，只验证当前参数下是否能运行完整评测链。Orbit 在这2秒走完整一圈，因此运动速度与正式12秒路径不同。正式实验必须使用12秒或更长的路径，并明确固定 capture Hz。

恢复时间、非均匀采样、完整硬件帧时间和真实扫描对照还没有跑完；不要用短诊断替代最终实验结论。
