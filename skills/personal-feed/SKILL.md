---
name: personal-feed
description: 处理 Telegram 中用户明确请求的 Personal Feed，以及对当前消息或引用中 X 内容的喜欢、不喜欢、收藏、取消收藏和查看收藏。普通话题里的“喜欢/不喜欢”不要触发。
---

# Personal Feed

只处理明确的 Feed 请求，或当前消息和当前 Telegram 引用中可定位的 X 内容。

- 用户明确请求 Personal Feed 时，交给已经加载的 Personal Feed Telegram 运行时。不要自行观察 X、模拟筛选或调用旧 selector。运行时只会返回一条内容、业务空或未完成；不要把业务空改写成推荐，也不要把未完成说成没有内容。
- 当前消息有明确 X URL，或引用中只有一个 X URL 时，可以直接定位。引用中有多条 X 内容时，只有唯一序号或唯一标题才算定位；“这个”“这条”无法唯一定位时，只问“你指哪一条？”。不要根据更早的会话历史猜目标。
- 收藏或取消收藏时，调用 `personal_feed_record_feedback`，`operation` 只传 `save` 或 `unsave`。工具成功后再自然确认一句；失败时如实说明。
- 喜欢或不喜欢交给 Telegram clean-feedback 链处理，不调用收藏工具，也不要在结果出来前声称已经记录。
- 查看收藏时调用 `personal_feed_list_saved`。

不要另建 Markdown、research、cron、当前承诺、后台任务或平行收藏文件。工具或运行时不存在时，明确说明当前入口没有加载 Personal Feed 能力，不要用临时脚本写状态。
