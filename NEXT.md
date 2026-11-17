# ComfyUI / Dirty-Moss 测试版续接

此文件是唯一续接入口；历史旧测试记录不能当作本轮实测。本文仅保留可公开、跨机器使用的项目状态，不包含开发机绝对路径、聊天内容、私有日志或任务编号。

## 交付路径与权限

- 用户 fork：[VegarGG/witch-paintbox-comfy-UI](https://github.com/VegarGG/witch-paintbox-comfy-UI)。默认分支 `main`，开发分支 `crew/comfy-dirty-moss`，开发基线 `fa376ab7a0adb5da3e7ef3beac3024b2974fe7c4`。
- 用户已明确要求：准备测试版提交并推送到该 fork，向该 fork 的 `main` 提 PR；**由用户审核并合并后，在 TauriTavern 通过 Git URL 安装**。不向上游发 PR，不自动合并，不手工复制到在线扩展目录。
- 本 PR 包含源码、真实编译产物、有限 UI/API 工作流、绑定、离线测试和说明。模型、聊天、生成图、真实日志、开发依赖及本机控制文件不提交。
- 尚未在 TauriTavern 安装或实测本插件链路；没有代理提交的真实绘图请求或聊天写入。提交/推送/提 PR 的许可，不包含安装、合并、在线配置变更、付费调用、真实生成、原聊天写入、启动新服务或下载额外模型。
- 使用、Git URL 安装与回滚见[实验说明](<README-zh.md>)；全部未测项和空资源表见[验收边界](<qa/gaps.md>)。后续只在用户审核和明确授权的边界内推进。

## 已实现的最小合同

### Comfy 协议与有限图

- [类型](<src/comfy-types.ts>)、[图校验/绑定](<src/comfy-workflow.ts>)和[传输](<src/comfyui.ts>)独立实现；[UI图](<workflows/dirty-moss-v2.ui.json>)、[API图](<workflows/dirty-moss-v2.api.json>)、[绑定](<workflows/dirty-moss-v2.bindings.json>)对应。
- 单阶段原生MOSS合同：各一个UNET/CLIP/VAE加载器、latent、Shift、KSampler、解码、选定输出，以及两个文本编码。不接受TextGenerate、自定义节点、额外采样链或loader/batch参数绑定；未选输出支路提交前裁剪。
- 每个明确操作最多一次POST；GET有界轮询原prompt_id，指定节点取图，复用既有图片字节/尺寸验证。无云端回退、不自动重试、不回显正文或服务端原始错误。
- [队列](<src/image-queue.ts>)保留其他提供方并发，Comfy单活跃组不饿死其他槽位；整体超时包含本地排队。取消只停本地等待，不发全局interrupt、不宣称GPU停止。
- sessionStorage仅存最小编号，无正文/图/凭据；未知提交阻止同URL重投，20条未确认记录满额后拒绝新提交。不驱逐旧未知记录，恢复仅查询原编号；存储不可用时内存降级，不承诺跨会话恢复。

### 设置、归档与旧后端

- [设置](<src/image-settings.ts>)增加隔离Comfy profile，旧二/四提供方配置补安全默认，不因迁移切activeProvider、不改旧密钥；[模型设置](<src/model-settings.ts>)补空Comfy预设，不继承GPT扩写。
- [提供方](<src/image-provider.ts>)Comfy分支保留正负词，不调用文本模型、anchors、世界书或vibe。其余四个后端保留独立连接/参数与既有行为。
- [设置面板](<src/comfy-config.ts>)支持GET检查、模型枚举、有限参数和明确批准的模板替换；[主设置](<src/image-config.ts>)跨导航保留异步保存忙态，不隐藏未完成写入。
- [归档](<src/config-archive.ts>)/[合并](<src/config-merge.ts>)兼容旧完整/世界书局部文件；旧文件没提供Comfy时不覆盖现有地址，新版明确默认地址仍可导入。API与图参数分节合并，拒绝伪造来源提供方字段。
- [历史](<src/image-history.ts>)/[图库](<src/image-gallery.ts>)保存原图、实际像素与有限参数，丢弃连接/完整workflow/receipt，显示正负词。

### 独立正文直出

- [纯核心](<src/direct-image.ts>)排除隐藏/选项/摘要/注释/代码/图片语法，保留StoryText及原字符；完整正文不尾截，6000字符超限须手工选改。冻结原文/稳定来源、SHA-256与任务ID；无稳定身份不按可变楼层下标猜归属，无效Unicode源拒绝。
- [原生只读捕获](<src/chat-host.ts>)支持旧AI楼层，绑定chat/message/swipes与角色/群聊对象、原文及事件epoch；检查跨await的身份/idle，提供同步最后一跳。核心事件缺失或embedded/Sifang未验证时拒绝，不放松旧写回授权。
- [控制器](<src/direct-image-runner.ts>)固定使用保存的Comfy profile与用户确认候选，预览/历史不POST，令牌拒绝旧结果/双提交；异步指纹后与紧邻生成/保存前同步核对实时来源。
- [直出UI](<src/direct-image-view.ts>)和[菜单](<src/launcher-menu.ts>)保留旧人工操作，增加“正文直出 / ComfyUI”；完整预览、本次负词、明确单张、原图库下载/删除/重开，不往聊天插标记。token与URL清理防迟到显示；保存已经开始后不谎称回滚，记录只归不可变旧键，pending期间保持busy。

## 验证与已知边界

- 已完成基线离线验收171项：原35 + 工作流13/协议18/队列1 + 设置及旧后端16/设置UI12/正文核心17/host23/runner20/UI10 + 交付6；无失败或跳过。
- 本次发布另增加Git URL审核合并安装、公开文档无私有路径两项门槛，交付组由6增至8；先跑6通过2失败，再修正文档并真实重建运行默认包测试：**173通过、0失败、0跳过**。所有QA包装复用同一批断言，不双计独立QA。
- 严格TypeScript5.8.3构建，101个编译输出与内存emit逐字节一致。没有新运行时依赖，包test不递归依赖npm。
- 多次限域只读复核曾发现并修复绑定越界、静默参数、日志容量/排队超时、旧归档覆盖、额外采样链和SHA期间静默改源缺口。最后一个缺口补真实失败回归，增加同步守卫后由另一代理独立重跑43项通过。
- 这些是源码与mock/fakeDOM证据，不是完整独立QA/安全/文档认证。真实宿主动态模块、事件名称和异步emitter清理语义、CORS、存储、下载、共存、移动端与性能仍需合并安装后验证。
- 两个存储不共享事务：保存开始后取消/换源可能仍提交旧键记录，不是跨存储原子回滚。无事件且在两个检查之间完全复原的宿主变更，不能仅靠只读快照发现。

开发者复现（使用现有Node、包管理器及项目TypeScript依赖）：

```sh
pnpm test
# 或 npm test；也可直接运行：
bash qa/run-all.sh
# 各任务入口默认也会先构建：
bash qa/T-01/run.sh
bash qa/T-02/run.sh
bash qa/T-03/run.sh
```

普通Git URL安装使用者无需执行构建；构建产物随PR提交。

## 模型清单与摘要

外部模型库的加载器配置值：

```text
diffusion_models/Dirty-MossV2-CONVROT8.safetensors
  bytes: 5413715446
  sha256: 3eaf54ae46e720fd1b47e5cca3f4c5739af40ed957dbeddf8b98262a0673c4a8
text_encoders/qwen3.5_9b_w4a8_gptq.safetensors
  bytes: 7343591088
  sha256: 4cc6a1543ad2061806da46f35f90cadb4801dcba246c44782cf42ec0feb6407c
vae/flux2-vae_small.safetensors
  bytes: 249521340
  sha256: d8d52ba036475f5fb07c8b435e176d3d97ebfa82f0d1a1c317f9cc1e25bd013b
```

原件与模型库副本已核对一致，排他复制、不覆盖且保留原件；权重不入库。官方配套下载见[模型说明](<workflows/README.md#需要的文件>)。不能以文件总量推算峰值内存或据此下载其他变体。

## 用户实际验证与下一步

用户先自行开启官方MOSS模板的prompt enhancer，观察到CPU TextGenerate逐token生成并取消。该过程只是诊断参考，不要求替换本实验图。编码与额外文本生成是不同阶段，MTP不直接加速基础编码；不因此切GGUF、加gpu-only或重跑取消任务。

随后用户明确报告关闭prompt enhancer后可以出图，效果与速度符合预期；截图可见1024×1024输出、25步/CFG2.5/er_sde/simple，任务显示约181.13秒。这是**用户手动官方模板/模型组合通过**，不是本PR独立API图、酒馆端到端、纯采样耗时或峰值内存证据；本实验资源表仍留空。

**下一步：用户审核本PR并决定合并；合并到main后，通过用户fork的Git URL在TauriTavern安装，再按实验说明先GET、一次直出、历史重开验证。** 不要求用户先手工部署或绕过审核装开发分支，不由代理自行合并、安装、真实生成或修改聊天。若失败先保留最小错误和编号，不自动清日志或重投。
