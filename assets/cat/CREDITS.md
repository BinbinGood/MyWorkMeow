# 月薪喵素材来源与版权说明

GIF 素材来自抖音博主 @月薪喵 的原创“月薪喵”表情系列。本项目使用的素材选自「月薪喵」表情包第 1 弹。

根目录 `assets/salary-cat.png` 与 `assets/salary-cat.ico` 是以本目录 GIF 中的月薪喵角色为视觉参考、通过 OpenAI 图像生成模型制作的静态衍生头像。它们沿用原角色的识别特征，同样不纳入 WorkMeow 的 MIT License。

> **素材版权归抖音博主 @月薪喵 所有，不纳入 WorkMeow 的 MIT License。**

## 托盘图标（2026-09-17 起）

菜单栏托盘图标已换成企鹅：`assets/pingu-tray.svg`（矢量原件，彩色版）+ `assets/pingu-tray.png`（按目标像素烘好的位图，配方见 `scripts/build-tray-icon.js`）。这两个文件是依据 Pingu 角色形象制作的衍生图标，**视觉特征来自 Pingu**（角色版权与商标归其权利人所有），同样不纳入 WorkMeow 的 MIT License。原先的托盘头像 `assets/salary-cat-tray.png` 已不再使用（需要时从 git 历史取回）。

位图不是原件直接缩小 —— 烘焙脚本另外做了三件事：裁掉透明边、补成正方形居中、沿剪影向外扩一圈 1.5pt 的**白色光晕**。光晕是为了在深色菜单栏上保住轮廓（企鹅身体是纯黑，半透明菜单栏会透出深色壁纸，黑对黑就糊了）；浅色菜单栏下白边自然隐去、本体本来就清楚，所以一套图通吃深浅两种外观。

## app 图标（2026-09-20 起）

打包出来的 `.app` 图标也换成了企鹅，和托盘图标同一个角色、但不是同一张画：app 图标是**彩色企鹅 + 浅蓝渐变方圆底**（macOS 原生图标那种整块铺满画布的方圆造型），托盘图标则是纯剪影加白色光晕。

- `assets/pingu-app.svg` —— 矢量原件（1024×1024），改图从这里改
- `assets/pingu-app.icns` —— 烘好的多档位图标，配方见 `scripts/build-icns.js`，`package.json` 的 `build.mac.icon` 指向它

烘焙脚本会裁掉透明边、把墨迹缩到每帧画布的 82%（Apple 自家图标墨迹的占比，照这个排才和 Finder 里的邻居一样大）再补回透明边；源是矢量，所以 1024 档也是从矢量画出来的，不是放大来的。原先的 `assets/salary-cat.icns` 已不再被引用（需要时从 git 历史取回，也可用 `node scripts/build-icns.js assets/salary-cat.png assets/salary-cat.icns` 重新烘）。

> 版权同托盘图标：**视觉特征来自 Pingu**（角色版权与商标归其权利人所有），不纳入 WorkMeow 的 MIT License。

- **原作者**：抖音博主 **@月薪喵**（原创猫 meme 表情系列）
- **素材出处**：mfuns 文章《最近很火的月薪喵表情包第1弹》
  https://www.mfuns.net/article/120254
  （CDN：`https://cdn.mfuns.net/static/<hash>.gif`）

原文共 62 张表情，本皮肤目前收录 28 张，按桌宠状态命名放在本目录。多图状态会
按状态独立随机轮换：一轮内每张只出现一次，全部出现后才重新洗牌：

| 文件 | 状态 | 表情含义 |
|---|---|---|
| `cat-working.gif`    | working    | 戴耳机对着笔记本喝咖啡——干活中（轮换第 1 张） |
| `cat-working-2.gif`  | working    | 电脑前举「稍等」牌——干活轮换 |
| `cat-working-3.gif`  | working    | 捂着耳朵埋头猛敲键盘——干活轮换 |
| `cat-working-4.gif`  | working    | 边吃零食边敲键盘——干活轮换 |
| `cat-working-5.gif`  | working    | 飞扑键盘猛敲——干活轮换 |
| `cat-idle.gif`       | idle       | 转椅上冰淇淋+手机摸鱼——待命 |
| `cat-loafing.gif`    | loafing    | 躺地上刷手机——工具间隙摸鱼（轮换第 1 张） |
| `cat-loafing-2.gif`  | loafing    | 沙发上点外卖——摸鱼轮换 |
| `cat-loafing-3.gif`  | loafing    | 靠着枕头奶瓶+手机——摸鱼轮换 |
| `cat-loafing-4.gif`  | loafing    | 边休息边盯着电脑——摸鱼轮换 |
| `cat-loafing-5.gif`  | loafing    | 躺着喝咖啡看屏幕——摸鱼轮换 |
| `cat-roam.gif`       | ambient    | 撒腿跑着玩——闲时作息的「溜达」片段 |
| `cat-xiaban.gif`     | ambient    | 下班时间放松一下——每天两个定时下班片段 |
| `cat-thinking.gif`   | thinking   | 对着笔记本挠头——思考（轮换第 1 张） |
| `cat-thinking-2.gif` | thinking   | 躺着想：头顶「浮云」思考泡——思考轮换 |
| `cat-talking.gif`    | talking    | 对着笔记本疯狂输出喵喵喵——正在回应 |
| `cat-juggling.gif`   | juggling   | 趴键盘上还同时刷手机——并行子任务 |
| `cat-juggling-2.gif` | juggling   | 并行忙活还照看小伙伴——并行子任务轮换 |
| `cat-juggling-3.gif` | juggling   | 分身协作处理多项事情——并行子任务轮换 |
| `cat-sweeping.gif`   | sweeping   | 喷消毒水打扫——压缩/清理上下文 |
| `cat-waiting.gif`    | waiting    | 冒汗紧张等待——等你授权 |
| `cat-needsinput.gif` | needsinput | 头顶冒问号挠头——等你回复 |
| `cat-happy.gif`      | happy      | 摸小猫的头夸夸——任务完成庆祝 |
| `cat-greet.gif`      | greet      | 被闹钟炸醒弹射到工位——打招呼/新会话 |
| `cat-sleeping.gif`   | sleeping   | 被窝里睡成一坨——睡觉（轮换第 1 张） |
| `cat-sleeping-2.gif` | sleeping   | 坐椅子上拔下肚子毛当眼罩睡——睡觉轮换 |
| `cat-error.gif`      | error      | 抱头崩溃大叫——出错 |
| `cat-sad.gif`        | sad(情绪)  | 嚎啕大哭——用户消息里带负面情绪时的短暂表情 |

版权归抖音博主 **@月薪喵** 所有。公开发布本项目时必须保留本文件及上述署名。
