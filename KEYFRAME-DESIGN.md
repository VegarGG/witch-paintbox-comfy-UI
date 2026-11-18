# 剧情关键帧与角色卡画风：来源和取舍

## 三个参考项目

| 项目 | 借鉴 | 不照搬 |
|---|---|---|
| ST-BaiBai-Image | [关键帧规则](https://github.com/baibai-git/ST-BaiBai-Image/blob/d6c55192325264408d0881b20f4154e01d46a03f/src/autoTag/prompt.ts#L322-L335)把人物、动作和叙事瞬间压成画面；[结果协议](https://github.com/baibai-git/ST-BaiBai-Image/blob/d6c55192325264408d0881b20f4154e01d46a03f/src/autoTag/protocol.ts#L172-L227)分开正文与元数据。 | [角色锚定说明](https://github.com/baibai-git/ST-BaiBai-Image/blob/d6c55192325264408d0881b20f4154e01d46a03f/src/autoTag/charAnchors.ts#L13-L35)指出通用路径的机械展开曾造成重复身体、字数和污染问题。这里不自动扩写正文、不按名字找锚定、不跟随 swipe 自动出图。 |
| st-chatu8 | [角色外形和服装分开](https://github.com/damoshen123/st-chatu8/blob/a4c417f98e9697be44935486a0504713532994b3/html/settings/character.html#L134-L248)。[正文上下文与候选插画落点](https://github.com/damoshen123/st-chatu8/blob/a4c417f98e9697be44935486a0504713532994b3/index.js#L16734-L17091)说明依据原文的重要性。 | 当时版本没有跨后端的通用同卡画风绑定或严格 1–2 张限制；[风格/角色参考](https://github.com/damoshen123/st-chatu8/blob/a4c417f98e9697be44935486a0504713532994b3/html/settings/novelai.html#L407-L512)是 NovelAI 专用，不能直接移到本 Comfy 工作流。只研究机制，未复制实现或提示词。 |
| 上游 Witch Paintbox | 复用已存在的[角色锚定结构](https://github.com/Elainadesne/witch-paintbox/blob/fa376ab7a0adb5da3e7ef3beac3024b2974fe7c4/src/anchor-store.ts#L4-L25)及[手动选段](https://github.com/Elainadesne/witch-paintbox/blob/fa376ab7a0adb5da3e7ef3beac3024b2974fe7c4/src/illustration-selection.ts#L126-L160)的交互思路。 | 不跑通用占位符替换，也不调用原“指定插图”回写流程。锚定只拼入可编辑正负词，封面不会作为图片参考发送。 |

## 本分支的范围

- **一帧优先**。手选或手写一个瞬间；另外可显式请求酒馆主文本 API 建议，或读取主回复已经带来的[可选附段](<TAURITAVERN-KEYFRAME-PRESET.md>)。不发送聊天历史、人物配方、世界书或变量。可选「最多两张」才提供第二份草稿；建议不会凭空补足两张，主 API 的两帧不能使用相同引文或描述，最终取景仍由使用者核对。
- **可重复使用的文本配方，不是人脸锁定**。按稳定的原生 avatar 文件键保存模型组合、手选角色锚定与画风正负词。同卡跨聊天复用；不同卡即使显示名相同也不共用；群聊只按本轮手选，不绑定到一张卡。当前剧情、动作、服装和最终提示词不自动写入卡配方。默认服装需要这帧勾选；配方角色没出镜时可以只关本帧的锚定，不影响其他帧和卡配方。配方只保存在当前客户端本机，不跟角色卡同步。
- **生成前能看到实际词**。先将场景、固定外貌、可选服装与画风拼成两段文本，允许编辑；改场景/配方后要重新预览，重新组词会覆盖此帧的旧预览。单张图可能仍有姿态、脸、光线及质感差异，图中也没有图像参考、LoRA 或额外阶段。
- **不改变历史归属**。图片历史以当前原始回复、稳定 `historyId`、swipe 等为准。改候选、换预设和帧号均不改变历史键。每次显式点击只提交单张，已保存帧在当前这一轮草稿中不会再次提交；「最多两张」不是禁止另开一轮编辑，也不是历史配额。整段原样选项保留既有直出方式。
