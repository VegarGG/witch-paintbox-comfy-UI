# Dirty-Moss V2 基础单图模板

状态：**结构/对应关系测试通过；2026-11-17 用户确认本机基础单阶段与插件生图路径已跑通。** 冻结版本、实际成功 profile、模型摘要及中性长文本数值对照见[冻结记录](<../BASELINE-2026-11-17.md>)。内置 W4A8 默认与当前成功 int8 profile 不同，不能混作同一模型组合；也不代表所有 Mac、所有长度或约16GB内存预算通过。

## 文件不要混用

- [dirty-moss-v2.ui.json](./dirty-moss-v2.ui.json)：在 ComfyUI 界面中加载、查看和编辑的图。
- [dirty-moss-v2.api.json](./dirty-moss-v2.api.json)：给 `/prompt` 的 `prompt` 字段使用的 API 格式，不是界面图。
- [dirty-moss-v2.bindings.json](./dirty-moss-v2.bindings.json)：插件允许修改的有限输入及指定输出节点。

这是无子图、10 个原生节点的普通单图模板，不需自动安装自定义节点。UI 节点 ID 与 API 对象键相同。界面图按本机 ComfyUI 0.45.5 的真实 `/object_info` 输入/输出定义生成；对应关系测试核对每条连接及控件值，但未冒充界面实测。

## 需要的文件

文件名必须与实际下载文件一致。不要选下载中的 `.part`、重复命名的 `(1)` 文件或 HTML 错误页面。若浏览器改名，下载后先核对再改工作流中的加载器字段。

| 组件 | 加载器配置字段 | 已核对字节数 | 文件校验 |
| --- | --- | ---: | --- |
| 主模型 | `1.unet_name` | 5,413,715,446 | 原件与模型库副本一致 |
| 文本编码器（将自然语言转为图像条件） | `2.clip_name` | 7,343,591,088 | 原件与副本SHA-256一致 |
| VAE（将内部图像表示解码成图片） | `3.vae_name` | 249,521,340 | 原件与副本SHA-256一致 |

模型库布局：

```text
<ComfyUI-models>/
  diffusion_models/Dirty-MossV2-CONVROT8.safetensors
  text_encoders/qwen3.5_9b_w4a8_gptq.safetensors
  vae/flux2-vae_small.safetensors
```

实际模型根目录由用户自己的ComfyUI库配置决定，以上只表示相对布局，不是要求新建目录或重下载。文件原件与副本已核对长度和摘要，保留原件、不覆盖同名文件；不要将权重放进本仓库。先前只读GET确认三模型可见；随后用户在官方模板中关闭prompt enhancer，已实际生成1024×1024图片，任务显示约181.13秒，效果和速度符合其预期。这不是本实验独立图或酒馆链路的成功证据。

官方下载：

- [编码器](https://huggingface.co/Comfy-Org/MOSS-Image/resolve/main/text_encoders/qwen3.5_9b_w4a8_gptq.safetensors?download=true)
- [小版 VAE](https://huggingface.co/Comfy-Org/MOSS-Image/resolve/main/vae/flux2-vae_small.safetensors?download=true)
- [官方文件及版本列表](https://huggingface.co/Comfy-Org/MOSS-Image/tree/main)

2026-11-17 官方文件 API 所列 SHA-256：

```text
qwen3.5_9b_w4a8_gptq.safetensors
4cc6a1543ad2061806da46f35f90cadb4801dcba246c44782cf42ec0feb6407c

flux2-vae_small.safetensors
d8d52ba036475f5fb07c8b435e176d3d97ebfa82f0d1a1c317f9cc1e25bd013b
```

以上摘要来自远端元数据，本轮另已对实际下载原件和模型库副本核对一致。若以后官方替换同名文件，应重新检查版本、长度和摘要，不静默接受变化。

早期用户报告官方模板成功；该历史观察不作为本轮 W4A8 兼容或性能证据。本轮独立图的实际对照使用 int8 配置。此前源码核对显示MPS路径可能使用反量化浮点计算，不要用三份文件总量推算峰值。现有原生CLIPLoader可选`device=cpu`；本模板仍为`default`，没有强制GPU/CPU、换编码器或添加扩写。

## 参数与绑定

| 输入 | 节点.字段 | 类型 |
| --- | --- | --- |
| 正面提示词 | 4.text | string |
| 负面提示词 | 5.text | string |
| 宽/高 | 6.width / 6.height | number |
| 种子 | 8.seed | number，安全整数 |
| 步数 | 8.steps | number |
| CFG | 8.cfg | number |
| Shift | 7.shift | number |
| 采样器/调度器 | 8.sampler_name / 8.scheduler | string |
| 输出 | 10，SaveImage | 指定节点 |

模型文件分别在 `1.unet_name`、`2.clip_name`、`3.vae_name` 中配置；编码器类型是 `moss_image`。它们属于用户批准模板本身，不允许文本模型修改。基础流程中没有独立云端文本模型或本地扩写节点。

默认 512×640、batch=1、种子0、25步、CFG2.5、Shift5、er_sde/simple。种子0是固定种子，不是“随机”的暗号。25步等是 V2 作者参数起点；链路检查可在实际界面中明确降低步数，但不能把低步数成功当成正式质量或性能验证。日常候选896×1152、作者参照1152×1440，均需真实资源测量，不自动升档。

节点7使用 `ModelSamplingAuraFlow` 的固定Shift补丁；本机 MOSS 模型配置默认也为 Shift5。真实加载后仍需核对该模型实际路径，不把默认值相同当作已出图证据。

## 支持边界与任务行为

这是MOSS基础原生图的有限合同，不是任意Comfy节点的通用编辑器：仅允许本模板使用的原生节点和PreviewImage，不接受TextGenerate、自定义节点或额外扩写。每个显示的数值/采样参数必须绑定到对应原生语义字段，并位于选定输出依赖链；正/负词不可换角色，不可改写加载器或batch字段。只允许一个指定输出节点；它的祖先必须恰好包含各一个加载器、latent、Shift、KSampler和解码节点，以及两个文本编码节点。第二采样阶段即使使用同样原生类也不受本轮支持，不能隐藏在下游绕过步数等控件。未选中的输出支路会在提交前裁掉，避免只忽略结果却意外执行。

一次操作最多POST一次`/prompt`；之后仅按原prompt_id轮询history/queue和取图。连接检查只GET，不等于加载/出图成功。未知提交结果保留任务记录并阻止同URL继续提交；明确恢复只查询原编号，不能重建并重发原工作流。

首版“停止”只停止本地排队/等待：未提交的本地排队项不发请求；已提交项可能继续在Comfy运行，不发送全局interrupt。用户核对服务端后可明确清除本地记录，但清除不取消服务端任务。最小任务日志只写页面会话sessionStorage，无正文/完整工作流/图像/凭据；不可用时退为内存记录，不承诺刷新恢复，更不承诺跨会话恢复。

## 目前验证与下一步

- 工作流13项、传输18项、分组队列1项共32项无网络用例；均有真实测试文件。严格验证UI实际控件序列/固定种子控件/连接类型，并用故意破坏图的变体证明断言能失败。审查发现的绑定越界、参数不生效和额外采样链问题均已补失败再修复回归。
- 全套构建/回归结果以[唯一续接入口](<../NEXT.md>)为准。工作流/协议验收可运行`NODE=<你的Node绝对路径> bash qa/T-01/run.sh`；该QA入口复用相同用例，不重复计算为第二批独立QA。fake DOM/VM验证不是实际浏览器或TT宿主测试。
- 本机安装、精确CORS、基础单阶段实际生成与插件正常收图已由用户验证。长中性任务的单次总耗时为132.65秒，不是纯采样基准；资源峰值、完整聊天副本/隔离竞态与UI控件导入矩阵仍未测。当前成功profile与内置W4A8默认不同，见[冻结记录](<../BASELINE-2026-11-17.md>)。
- 模型齐备后先独立导入UI图，用中性杯子场景验证，再进行获准的插件与聊天副本测试。首次测试关闭自动批量功能，不触发云端。
- 最终以 [NEXT.md](../NEXT.md) 为唯一续接入口。此说明只描述工作流，不维护第二份任务进度。
