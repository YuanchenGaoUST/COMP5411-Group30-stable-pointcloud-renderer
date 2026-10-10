# 原始模型缓存

2026-10-10 从作者或官方仓库下载，用于离线生成点云。原始 OBJ / PLY / archives 放在此目录，但默认不纳入 Git；processed JSON 与 provenance 位于 `data/models/` 和 `data/catalog.json`。

| 文件 | 来源 | 授权 |
|---|---|---|
| jetliner.obj | NuclearOsmosis, OpenGameArt Jumbo Jet / Wide Body | CC0-1.0 |
| funky-aircraft.obj | Savino, OpenGameArt Funky aircraft / high_0.obj | CC0-1.0 |
| bunny.tar.gz / stanford-bunny.ply | Stanford University Computer Graphics Laboratory | Research use and free redistribution with acknowledgment; commercial use requires permission |
| dragon-reconstruction.tar.gz / stanford-dragon.ply | Stanford University Computer Graphics Laboratory | 同上；模型为 reconstructed geometry |
| teapot.zip / teapot.obj | Martin Newell, Kenzie Lamar adaptation, Morgan McGuire archive | CC0-1.0；许可 metadata 保存在 teapot-license-info.js |

Stanford 输入须注明来源，不应标为 CC0，也不应描述为 raw scanner measurements。这里是表面采样后重新计算特征的 derived point clouds。源 hash、下载 URL 和许可 URL 随 catalog 与 JSON metadata 保存。

```sh
python3 scripts/fetch_model_sources.py
python3 scripts/build_model_catalog.py --count 15000 --seed 20261010
```
