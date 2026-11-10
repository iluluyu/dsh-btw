# btw 后续工作

- 试用右上角临时聊天、上下文/模型选择、侧栏切换、多选送回草稿；按实际体验反馈问题。
- 界面调整对照 `docs/design-acceptance.md` 和设计稿批注，保持单层输入、原生圆角及简洁交互。
- 修 bug 先固定最短复现、核对实际 dsh API、补回归，再修改；避免并行堆功能或重写架构。
- 修改后运行 `npm run check`、`npm test`、`node scripts/smoke-isolated.mjs`；必要时用已有 `glm/glm-5.3-flash` 做合成请求测试。
- 会话与删除测试仅使用隔离 HOME/DSH_HOME；不读取真实会话、不输出凭据、不擅自重启服务。
- 是否 push、升版本或发布由用户决定，未明确要求前不执行。
