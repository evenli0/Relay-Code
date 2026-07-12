---
name: three-view-review
description: 从安全性、性能、可维护性三个角度并行审查代码
---

从安全性、性能、可维护性三个角度并行审查指定文件，最后汇总一份综合报告。

## 阶段 1 | parallel
目标：派发三个子Agent 从不同角度审查
- dispatch | role=安全审计员 | preload=目标文件
- dispatch | role=性能工程师 | preload=目标文件
- dispatch | role=可维护性专家 | preload=目标文件

## 阶段 2 | serial | 依赖阶段 1
目标：汇总三份审查报告
- write 审查报告.md
